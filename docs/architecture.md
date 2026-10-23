# 架构

记录项目的骨架（目录、模块和它们的边界）以及重要的架构决定。随代码演进更新；产品需求见 [prd.md](prd.md)，技术选型见 [tech_stacks.md](tech_stacks.md)。

## 项目骨架

<!-- 目录结构：每个目录一行说明它负责什么。 -->

```text
.hq.json              合入前跑的全量测试命令；hq 从 main 读，目标分支改不了它
hq/                   合入锁（M0.1）：hq approve / merge / install-hook，git 的 main 守卫钩子
  src/approval.ts     批准记录：~/.hq/approvals/<仓库>/，绑定一个 commit，合入后作废
  src/merge.ts        在最新 main 上建合并提交、沙箱里跑全量测试、移动 main
  src/guard.ts        reference-transaction 钩子：main 只能移到已批准目标的合并提交
  src/sandbox.ts      执行者沙箱规则，用 srt（sandbox-runtime）跑命令
  test/               假执行者的端到端测试：真 git、真 worktree、真沙箱
eval/                 第 0 步：考出题者（SWE-bench-Live 题、出题、判卷、汇总）
scripts/sandbox/      M0.0：Claude Code 沙箱的前置检查
docs/                 设计、路线、历史
```

## 模块与边界

<!-- 每个模块：职责、对外接口、依赖谁、谁依赖它。 -->

| 模块 | 职责 | 对外接口 | 依赖 |
| --- | --- | --- | --- |
| hq 合入锁 | 没有你的批准，main 不动（D29） | `hq approve <目标>`（只认终端输入）、`hq merge <目标>`、`hq install-hook` | git、srt；批准记录在 `$HQ_HOME`（默认 `~/.hq`） |
| main 守卫钩子 | 兜底：不在沙箱里的会话也改不了 main | git 调 `hq guard`；人手动改 main 时设 `HQ_ALLOW_MAIN=1` | hq 的批准记录 |
| eval | 第 0 步的出题与判卷 | GitHub Actions 的 `step0` workflow | Docker、Claude Code |

## 重要决定

<!-- 每条一行；需要展开时在下方加小节「### ADR-编号 标题」，写背景、选项、决定、后果。 -->

| 编号 | 日期 | 决定 | 原因 | 状态 |
| --- | --- | --- | --- | --- |
| ADR-1 | 2026-10-22 | 实现语言 TypeScript，运行时 Bun（发布产物跑 Node ≥ 18） | 理由见 [tech_stacks.md · 选型总览](tech_stacks.md#选型总览) | 已定 |
| ADR-2 | 2026-10-23 | hq 自己跑的命令（合入前的全量测试）用 srt（`@anthropic-ai/sandbox-runtime` 0.0.78）包起来；执行者的会话用 Claude Code 沙箱 | 两者同一引擎；hq 不经过 Claude 会话，要直接包命令（D35） | 已定 |
| ADR-3 | 2026-10-23 | 批准只认终端输入：`hq approve` 从 `/dev/tty` 读你敲的目标名；批准记录放在执行者沙箱禁写的 `~/.hq` | agent 的 Bash 没有终端，也写不了 `~/.hq`；不做成 MCP 工具（D29） | 已定 |
| ADR-4 | 2026-10-23 | srt 里起不了 srt：hq 自己用到沙箱的测试，在合入前的沙箱运行里跳过 | 嵌套时这些测试会因为沙箱起不来而「碰巧」通过；改合入锁的任务本来就要你亲自看（D44） | 已定 |
