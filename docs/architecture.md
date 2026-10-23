# 架构

记录项目的骨架（目录、模块和它们的边界）以及重要的架构决定。随代码演进更新；产品需求见 [prd.md](prd.md)，技术选型见 [tech_stacks.md](tech_stacks.md)。

## 项目骨架

<!-- 目录结构：每个目录一行说明它负责什么。 -->

```text
.hq.json              合入前跑的全量测试命令；hq 从 main 读，目标分支改不了它
hq/                   合入锁（M0.1）：hq approve / merge / install-hook，git 的 main 守卫钩子
  src/approval.ts     批准记录：~/.hq/approvals/<仓库>/，绑定一个 commit，合入后作废
  src/merge.ts        合并预演（最新 main 上建合并提交、沙箱里跑全量测试），合入时移动 main
  src/goal.ts         开目标（`hq goal new`）：目标分支、旁边的链接 worktree、首个提交里的 goals/<目标>.json
  src/status.ts       总览（`hq status`）：每个目标分支的头、领先落后、报告与批准状态、未完成任务；只读
  src/report.ts       五栏目标报告（M0.2）：~/.hq/reports/<仓库>/，按目标 commit 存
  src/ledger.ts       记账（M0.3）：~/.hq/ledger/<仓库>/events.jsonl，只追加
  src/lines.ts        任务大小（200 行规则）：基线到结束 commit 的增删行数，只算文本文件，不算 goals/*.json 和锁文件
  src/stats.ts        把事件流折成每个任务一行，按测评口径算指标
  src/versions.ts     安装版本（M0.4）：~/.hq/versions/<commit>、current / previous、启动器 ~/.hq/bin/hq
  src/guard.ts        reference-transaction 钩子：main 只能移到已批准目标的合并提交
  src/sandbox.ts      执行者沙箱规则，用 srt（sandbox-runtime）跑命令
  test/               假执行者的端到端测试：真 git、真 worktree、真沙箱
eval/                 第 0 步：考出题者（SWE-bench-Live 题、出题、判卷、汇总）
  src/merge-runs.ts   把几次运行的结果合成一份，每道题取最新的判卷（`bun src/merge-runs.ts <out> <run>...`）
  src/ab.ts           两份合并结果逐题对比：修好、弄坏、不变，两边都判了的题上的抓住率（`bun src/ab.ts <a> <b> [--ids <file>]`）
  src/mutants.ts      变异测试：金标准补丁每次去掉一个 hunk 得一个变异体（至多 8 个）；`grade.ts --mutants` 对抓住的题逐个判，summarize 出变异得分
  src/writer_prompt_v2.md  出题提示词第二版（`write.ts --prompt v2`，默认 v1）；A/B 用法见 `ab/README.md`
scripts/sandbox/      M0.0：Claude Code 沙箱的前置检查
docs/                 设计、路线、历史
goals/<目标>.json      目标分支上的目标文件：title、shelved（搁置的任务）、known_issues（既有问题）；报告从这里读
```

## 模块与边界

<!-- 每个模块：职责、对外接口、依赖谁、谁依赖它。 -->

| 模块 | 职责 | 对外接口 | 依赖 |
| --- | --- | --- | --- |
| hq 合入锁 | 没有你的批准，main 不动（D29） | `hq approve <目标>`（只认终端输入，要先有这个 commit 的绿色报告）、`hq merge <目标>`、`hq install-hook` | git、srt；批准记录在 `$HQ_HOME`（默认 `~/.hq`） |
| hq 目标报告 | 批准前读的五栏报告（D31） | `hq report <目标>` | 合并预演、`.hq.json`（`sensitive` 可覆盖默认敏感路径）、`goals/<目标>.json` |
| hq 总览 | 每个目标现在在哪一步 | `hq status [--json]`，只读 | git、报告和批准记录、记账 |
| hq 记账 | M0 的指标数据（测评、D39） | `hq task start/gate/cost/lines/shelve/cause/false-reject`、`hq escalate`、`hq escape`、`hq stats [--json\|--tasks]`；approve 和 merge 自动记 | `$HQ_HOME/ledger`（执行者沙箱写不了） |
| main 守卫钩子 | 兜底：不在沙箱里的会话也改不了 main | git 调 `~/.hq/bin/hq guard`；人手动改 main 时设 `HQ_ALLOW_MAIN=1` | hq 的批准记录、安装版本 |
| hq 安装版本 | 运行的 hq 和被改的 hq 分开（D44） | `hq install [<rev>]`、`hq rollback`、`hq version` | git、bun；`$HQ_HOME/versions`（执行者沙箱写不了） |
| eval | 第 0 步的出题与判卷 | GitHub Actions 的 `step0` workflow | Docker、Claude Code |

## 重要决定

<!-- 每条一行；需要展开时在下方加小节「### ADR-编号 标题」，写背景、选项、决定、后果。 -->

| 编号 | 日期 | 决定 | 原因 | 状态 |
| --- | --- | --- | --- | --- |
| ADR-1 | 2026-10-22 | 实现语言 TypeScript，运行时 Bun（发布产物跑 Node ≥ 18） | 理由见 [tech_stacks.md · 选型总览](tech_stacks.md#选型总览) | 已定 |
| ADR-2 | 2026-10-23 | hq 自己跑的命令（合入前的全量测试）用 srt（`@anthropic-ai/sandbox-runtime` 0.0.78）包起来；执行者的会话用 Claude Code 沙箱 | 两者同一引擎；hq 不经过 Claude 会话，要直接包命令（D35） | 已定 |
| ADR-3 | 2026-10-23 | 批准只认终端输入：`hq approve` 从 `/dev/tty` 读你敲的目标名；批准记录放在执行者沙箱禁写的 `~/.hq` | agent 的 Bash 没有终端，也写不了 `~/.hq`；不做成 MCP 工具（D29） | 已定 |
| ADR-5 | 2026-10-23 | 记账用只追加的事件流，不用「每个任务一行、原地改」 | 追加不会互相覆盖，也留下谁在什么时候记了什么；每个任务一行由 `hq stats --tasks` 现算 | 已定 |
| ADR-6 | 2026-10-23 | 主动时间只在批准入口计：`hq approve` 打出报告到你敲完目标名；途中的决定用 `hq escalate --minutes` 自报 | 测评不量「等你多久」（D23、D39）；途中的决定在对话里做，hq 看不到 | 已定 |
| ADR-4 | 2026-10-23 | srt 里起不了 srt：hq 自己用到沙箱的测试，在合入前的沙箱运行里跳过 | 嵌套时这些测试会因为沙箱起不来而「碰巧」通过；改合入锁的任务由 Claude 新会话逐行读 diff，读过没问题才在沙箱外补跑这些测试（D44） | 已定 |
