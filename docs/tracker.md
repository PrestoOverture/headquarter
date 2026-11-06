# 多 agent 效果追踪器：产品说明（2026-11-05 对齐）

指挥所的下一个方向。为什么转过来，见 [history.md](history.md) 2026-11-05 一条。

## S：现状

用 AI 写代码，现在主要有两种做法：

- 编排（Orchestration）：主 agent 拆任务、派给其他 agent，人只在开头给目标、结尾批准。这样用的人越来越多。
- 单 agent：一个 agent 从头写到尾，人在旁边盯着。很多人仍然这样用。

无论哪种，你都很难回答：哪种做法在我的项目上更靠得住？哪个 agent、哪种组合返工最少、最省钱？我实际花了多少注意力？换了模型之后，效果是变好还是变差？公开 benchmark 测的是单个 agent 做标准题，和你自己项目里的真实任务关系不大。

## T：要做的事

在你自己的电脑上，对所有任务、所有项目、所有 agent 持续追踪，不管是单 agent 还是多 agent 编排，回答同一个问题：**在你的真实工作里，哪种用法以最少的人工注意力交付了最靠得住的结果。** 不改工作流，不额外跑评测，数据不离开本机。

## A：怎么做

1. 读已有的记录：Claude Code、Codex、OpenCode 本来就在本机存会话记录，再加上 git 历史和 CI 结果。
2. 认出分工：哪个会话是主管在派活，哪个是子 agent 在干活，跨厂商串成一件任务。单 agent 就是没有子 agent 的组合。
3. 追结果：产出的代码合进去了没有，CI 第一次过没过，14 天内有没有被回滚或返工。
4. 记你的投入：插了几次话、几次是纠正、它等了你多久、这件任务花了多少钱。
5. 出报表：按组合汇总，可按仓库、任务类型、时间段筛选；模型更新后自动做前后对比。

## R：你得到什么

打开本地报表，看到这样的结论：

> 过去 30 天，在你的 TypeScript 后端仓库上：Claude Code 当主管、Codex 写代码，合格率 85%，14 天返工率 8%，每件活 $3.1，平均介入 1.2 次；Claude Code 自己当子 agent，合格率 88%，但返工率 15%，介入 2.0 次。上周升级模型后，后者的返工率降到 9%。

你据此决定怎么派活、什么时候换模型，用的是自己的数据，不是别人的榜单。以后可以选择匿名贡献汇总数据，看同行业的人用哪种组合最好。

## 已知风险

- 三家的日志格式都没公开承诺，会变：解析器做成可替换的插件。
- 会话对上提交要靠目录、时间、分支和 `Co-Authored-By` 署名来匹配，会有误差。
- 质量只能用替代指标（存活、返工、CI）；隐藏测试以后作为可选增强。
- 护城河弱：可选的匿名汇总榜是后续补网络效应的办法。

## 第一步（T0，已完成）

在作者自己的电脑上做原型：读 Claude Code 和 Codex 的日志（本机约 1.8 GB）加 git，出一张本地报表，看能不能从中看出东西（比如哪种组合返工最少）。

## 给别人用：输入、输出和形态（2026-11-06 讨论）

- **输入**：默认自动发现本机已知位置（`~/.claude/projects`、`~/.codex/sessions`、`~/.local/share/opencode`），列出找到的 agent 让用户勾选；不在默认位置的手动填路径；新的 agent 装一个解析器插件。只读、只在本机。
- **输出**：一个可视化看板。可选日期、仓库；看用了哪些 agent、每个 agent 用的哪个模型、哪种编排（单干、委派、子 agent、审查；认不出的标「未知」）、结果是什么。每个数字旁标样本量 n。
- **Result 四项基础指标**（定义见 [t2-interface.md](t2-interface.md#result每个组合的四项基础指标)）：每任务 token（输入、缓存读、缓存写、输出分开列）、落地率、14 天返工率、用户注意力（插话、打断、等待分开列）。可选：CI 新失败率、美元花费。
- **解析不花 token**：全部是确定性代码（解析 JSON、正则、git blame、gh api），同样的数据永远出同样的数字。将来如果用模型判断「是否修复」「任务类型」，只做可选项、默认关闭，并在报表里标出。
- **形态（方向已谈，未定）**：要让每个主流 agent 都能接，选 MCP（Claude Code、Codex、OpenCode、Cursor、Gemini CLI 都支持）。但数据不能靠 MCP 采集（agent 不会每步都记得报告），采集仍是读本地日志。设想做成一个 npm 包，三件事：
  1. 采集：插件读日志。
  2. 看板：`npx <包名> serve`，本地浏览器打开。
  3. MCP server：在任何 agent 里查询（例如「这周各组合的返工率」），返回文字摘要和看板链接；宿主支持 MCP Apps 的（Claude 桌面端、ChatGPT、VS Code 等图形宿主）可以直接在对话里显示图表，纯终端宿主（Claude Code CLI、Codex CLI）只显示文字和链接。

## 本机日志格式（2026-11-05 核对）

T0 开工前看的三家记录。格式都没公开承诺，下面是这台机器上看到的样子。

- **Codex**（`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`，旧的压成 `.jsonl.zst`）：每行 `{type, payload}`。第一行 `session_meta` 有 `cwd`、`git`（commit、branch、remote）、`originator`（`claude2codex` 是 Claude Code 经 MCP 派来的活）、`source`（`vscode`、`exec`，子 agent 是 `{subagent: {thread_spawn: {parent_thread_id, agent_role}}}` 或 `{subagent: "review"}`）。花费只有 token（`event_msg.token_count` 的累计值），没有美元。人的插话看 `task_started.turn_attribution.turn_trigger`（`composer`、`edit_user_message`），旧会话没有这个字段，只能数用户消息。
- **Claude Code**（`~/.claude/projects/<目录>/<session>.jsonl`，子 agent 在 `<session>/subagents/agent-*.jsonl`）：每条消息带 `cwd`、`gitBranch`、`entrypoint`（`claude-desktop`、`cli` 是人用；`sdk-cli` 是 `claude -p`）。`cost-state` 记录给出整个进程的 `totalCostUSD`。人说的话：`origin.kind == "human"`，旧记录没有 `origin`，按 entrypoint 和内容排除。派给 Codex 的活：`codex_result` 的返回带 `thread_id`，就是 Codex 会话 id，本机 295 个 `claude2codex` 会话对上 210 个。
- **OpenCode**（`~/.local/share/opencode/opencode.db`，SQLite）：`session` 表有 `parent_id`、`directory`、`cost`、token；`message.data` 是 JSON（assistant 带 `modelID`、`tokens`、`cost`、`error`），`part.data` 里有工具调用（bash 的命令和输出）。本机 14 个会话，T2 起接入（只读，只查 session、message、part；库里还有账号表，不碰）。
- **对提交**：会话里跑 `git commit` 的输出带 `[分支 短哈希]`，能精确对上；对不上的按仓库和时间窗口猜。Codex 的提交很少带署名。
