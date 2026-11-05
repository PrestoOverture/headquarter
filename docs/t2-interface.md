# T2 接口与数据模型（草案，2026-11-06）

先定接口，再做看板。本文件定义：解析器插件长什么样、它交出什么数据、result 由哪几项组成。看板和最终形态（npm 包 + `serve` + MCP）等用户拍板后再写。

## 原则

- **只读、只在本机。** 插件只读 agent 的记录和 git，不写任何东西，不上传。
- **确定性。** 解析和归因全是代码，不调用模型，不花 token；同样的输入永远得到同样的数字。
- **只记录。** 输出是测量和它的精度（样本量、已知盲区），不是建议。
- **认不出就标"未知"。** 编排方式、父子关系、模型等字段，记录里没有证据就留空，不猜。

## 插件接口

```ts
export interface SourcePlugin {
  /** 稳定的名字，出现在报表的 agent 列：claude、codex、opencode */
  name: string;
  /** 默认位置；用户可以在配置里改或加 */
  defaultPaths(home: string): string[];
  /** 这个路径下有没有本插件能读的记录（用于"自动发现"） */
  detect(path: string): boolean;
  /** 读出全部会话 */
  read(path: string): Session[];
}
```

核心代码（任务拼装、提交关联、返工、CI、报表）只认 `Session`，不知道有哪些厂商。新 agent = 新插件文件 + 在注册表里加一行。

## Session（插件交出的东西）

在现有 `Session` 上改两处：

1. `vendor` 从固定的 `"claude" | "codex"` 改成 `string`（插件名）。
2. token 统一成一个结构，所有插件都填：

```ts
tokens: { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number }
```

- `input` 是**未命中缓存**的输入。Claude 的 `input_tokens` 本来就是这个意思；Codex 的 `input_tokens` 含缓存，要减去 `cached_input_tokens`；OpenCode 的 `tokens.input` 不含缓存读。
- 记录里没有的项填 0（例如 Codex 没有 cacheWrite，Claude 没有单独的 reasoning）。
- `costUSD` 保留为可选：只有记录自己写了钱（Claude 的 cost-state、OpenCode 的 `cost`）才填，不按价目表换算。

其余字段（时间、cwd、模型、role、parent、人类提示、打断、等待、提交 sha）语义不变。

## 编排方式（orchestration）

任务 = 一个根会话 + 它派生的会话。组合标签由核心统一生成：`<根 agent> → <子会话种类>` 或 `<根 agent> solo`。子会话种类由插件通过 `role` 给出：

| role | 含义 | 证据来源 |
|---|---|---|
| root | 人或程序直接开的 | 默认 |
| subagent | 同一个 agent 派生的子会话 | Claude 的 subagents 目录；Codex 的 thread_spawn；OpenCode 的 `session.parent_id` |
| review | 审查会话 | Codex 的 review 来源 |
| delegated | 另一个 agent 通过 MCP 等方式委派来的 | Codex 的 originator；Claude 结果里的 thread_id |

跨厂商的父子关系（例如 Claude → Codex）由插件给出 `parent` 或 `delegatedThreads`，核心负责连起来。连不上的标"caller unknown"。

## Result：每个组合的四项基础指标

| 指标 | 定义 | 分母 |
|---|---|---|
| **每任务 token** | 输入（未缓存）、缓存读、缓存写、输出分开列，不加总 | 全部任务 |
| **落地率** | 提交进了主线的任务 / 有提交的任务 | 有提交的任务 |
| **返工率** | 14 天内被修复类提交改掉的任务 / 已满 14 天的落地任务 | 成熟的落地任务 |
| **用户注意力** | 每任务的人类提示数、打断数、等待分钟数，三项分开列 | 全部任务 |

- 每个数字旁边显示样本量 n。
- 可选列：CI 新失败率（仓库有 GitHub CI 且装了 `gh` 才有）、美元花费（记录里有钱才有）。
- 落地率和返工率只对能连到 git 仓库的任务有意义；没有仓库的任务只算 token 和注意力。

## OpenCode 插件要点

- 位置：`~/.local/share/opencode/opencode.db`（sqlite，用只读模式打开；数据库里还有账号表，插件只查 `session`、`message`、`part` 三张表）。
- 会话：`session` 表一行一个；`parent_id` 不空的是子会话（task 工具派生），role = subagent。
- 模型：assistant 消息的 `modelID`（带 `providerID`）。
- token / 花费：assistant 消息的 `tokens` 和 `cost`。
- 人类提示：role = user 的消息，属于根会话，且至少有一个非 `synthetic`、非 compaction 的 text part。
- 打断：assistant 消息 `error.name = MessageAbortedError`。
- 提交：bash 工具调用的 `state.input.command` 匹配 git commit，从 `state.output` 里取 sha（同现有规则）。
- headless：`opencode run` 产生的会话目前在记录里看不出来，先全部当交互式；等确认有字段再改。

## 不在这一步做的

- 看板、`serve`、MCP server、npm 打包（等形态定下来）。
- 用模型判断"是否修复""任务类型"（如要做，必须是可选、默认关闭、并在报表里标出）。
