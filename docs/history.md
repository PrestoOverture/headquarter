# 历史

按时间记录做项目的过程：做了什么、遇到了什么、学到了什么。新条目加在最上面。

## 2026-10-23 M0.3：记账

- 做了什么：`hq/src/ledger.ts`、`stats.ts`。事件只追加，存在 `~/.hq/ledger/<仓库>/events.jsonl`，执行者沙箱写不了。hq 自己记：报告展示、批准（主动时间 = 报告打出来到你敲完目标名）、合入。其余靠命令：`hq task start`（目标、标题、难度、模型、base commit）、`gate`（四道关卡、过没过、是不是自报完成之后）、`cost`、`shelve`、`cause`（作弊 / 误解 / 其他）、`false-reject`，`hq escalate`（可带分钟数），`hq escape`。`hq stats` 按测评口径出表：每道关卡的「自报完成但没过关」、上报率、逃逸率（合入后 14 天内，窗口没结束的单列）、合格率、搁置率、每个合格任务的成本和主动时间、误拒、失败原因、按难度分层；不满 50 个任务标「不下结论」。
- 结果 / 数据：hq 22 个测试全过；本仓库全量测试在 srt 里通过。
- 遇到的问题：没有调度器，任务、关卡、花费只能手动记；漏记就是漏数据。「每个任务至少 200 行」还没自动核对。
- 下一步：M0.4 版本分开（钩子和 hq 本身从固定安装版本运行）。

## 2026-10-23 M0.2：目标报告；守卫钩子装进本仓库

- 做了什么：`hq install-hook` 装进本仓库，直接往 main 提交要带 `HQ_ALLOW_MAIN=1`（你的决定）。`hq report <目标>` 生成五栏：改了什么（目标分支 first-parent 的每个提交一行）、怎么测的（合并预演上沙箱里跑的原始测试输出和退出码，超过 300 行贴尾部、全文存盘）、风险（敏感路径、package.json 依赖增删改、其他依赖清单、新目录和新文件类型）、怎么撤回、没做完的（`goals/<目标>.json` 里的搁置任务和既有问题）。合并预演从 `hq merge` 里抽成 `trialMerge`，两边用同一套。`hq approve` 现在要求这个 commit 有绿色报告；报告存在 `~/.hq/reports`，执行者沙箱写不了。
- 结果 / 数据：hq 14 个测试全过；本仓库全量测试在 srt 里通过（hq 的 6 个沙箱测试在嵌套时跳过）。
- 下一步：M0.3 记账。

## 2026-10-23 M0.1：合入锁

- 做了什么：`hq/`（TS/Bun）。`hq approve <目标>` 从终端读你敲的目标名，把批准绑定到 `goal/<目标>` 当前的 commit，记录写进 `~/.hq/approvals/`。`hq merge <目标>` 核对批准、在最新 main 上建 `--no-ff` 合并提交、在 srt 沙箱里跑 `.hq.json`（从 main 读）的全量测试、main 没动过才移过去，输出 `git revert -m 1` 命令。`hq install-hook` 装 reference-transaction 钩子：main 只能移到已批准目标的合并提交。
- 结果 / 数据：9 个端到端测试全过（假执行者 + 真 git、真 worktree、真 srt）：未批准、批准后新提交、测试不过、目标改弱测试命令、终端外批准、沙箱里伪造批准或改 main、沙箱外改 main 都被拒；合法合入只有一个合并提交，一条 revert 能撤回。本仓库全量测试在 srt 里能跑通。
- 遇到的问题：Bun 子进程默认不继承运行中改过的 `process.env`，钩子拿不到 `HQ_HOME`；srt 把 `$TMPDIR` 设成 `/tmp/claude` 却不创建；srt 里起不了 srt，嵌套时有两个测试会「碰巧」通过，改成在沙箱运行里显式跳过（ADR-4）。
- 下一步：决定是否把守卫钩子装到本仓库；M0.2 目标报告。

## 2026-10-23 M0.0：沙箱前置验证通过

- 做了什么：M0 计划写进 roadmap（M0 实施计划）。写了 `scripts/sandbox/check.ts` 和 `probe.sh`：在 linked worktree 里用 `claude -p`（Haiku）加沙箱设置跑探针，从工具结果里读结论，再从沙箱外核对 main、hooks、config。
- 结果 / 数据：19 项全过：本仓库测试、worktree 里提交、起进程和杀进程树、临时目录、本地监听；hooks、config、main 的 ref、`packed-refs` 写不了；家目录写不了，`~/.ssh` 读不到，网络出不去。
- 遇到的问题：沙箱默认不让监听端口，本仓库代理测试失败，加了 `allowLocalBinding`；macOS 的 `mktemp` 不读 `$TMPDIR`；`--allowedTools` 会吞掉后面的提示词，改从 stdin 传。
- 学到的：执行者的 `.git` 不能整个只读，否则 worktree 提交失败；锁 main 只要 `denyWrite` 它的 ref 和 `packed-refs`。
- 下一步：M0.1 合入锁。

## 2026-10-23 第 0 步全量：Sonnet 出题，51 题里抓住 42 题（82%）

- 做了什么：61 题全部用 Sonnet 5.5（high）出题。首轮判卷后修了 runner（磁盘、判卷断网、重建超时 90 分钟、`NuGetAudit=false`、只重判模式 `writer_runs`），再用新判卷环境把已有的测试重判了一遍。出题共 12.4 美元。
- 结果 / 数据：能判的 51 题，抓住 42 题，抓住率 82.4%，过了一半的停止线。按语言：c 9/9、js 8/8、java 8/10、rust 7/10、cpp 6/8、cs 4/6。抓住的题都看过有 bug 一侧的日志：失败来自断言或 issue 描述的崩溃，不是构建失败。新判卷环境没改变任何一题的结论。
- 漏掉的 9 题都是 `fails_on_fixed`，没有一题是「测试太弱、在有 bug 的代码上也通过」：
  - 测得比 issue 宽（5 题：duckdb-24318、gitbutler-14920、lean-ctx-969、subtitleedit-12151、subtitleedit-12763）：测试在 issue 的复现外多要求了行为，gold 修复没覆盖。
  - 绑死实现（2 题：obscura-479 断言 `Number(1)` 而修复后是 `Number(1.0)`；langchain4j-5755 调用一个猜的内部方法名，两边都编不过）。
  - 在环境里编不过（btrace-897：用了离线缓存里没有的 junit-params，两边都编不过）。
  - 原因待查（ducklake-1339：修复后 `ATTACH` 元数据库报 IO Error）。
- 没算进分母的 10 题：
  - 5 题镜像解压后超过标准 runner 的 58 GB 磁盘（biome ×3、lance-8049、pnpm-12935），标准 runner 跑不了。
  - wolverine-3582、3608：NuGet 漏洞检查让数据集自带的还原命令失败，加了 `NuGetAudit=false` 但还没重判。
  - duckdb-24290 重建超时、monero-10858 和 Mooncake-2964 判卷时 runner 被关停，还没重判成功。
- 遇到的问题：私有仓库的 Actions 额度用完（「recent account payments have failed or your spending limit needs to be increased」），最后两次重判没能启动。
- 学到的：PRD 担心出题者「测试太弱」，这一轮反过来：主要问题是测试比需求更严或绑死实现。出题提示词可以加一条「只断言 issue 描述的行为，不断言实现细节」。
- 下一步：定第 0 步过不过；Actions 额度恢复后补判上面 5 题；定变异测试的做法。

## 2026-10-23 第 0 步首轮：Sonnet 出题 10 题，抓住 9 题

- 做了什么：在 GitHub Actions 上跑第 0 步 runner（`eval/`、`.github/workflows/step0.yml`）。从 61 道题里按语言挑 10 题（rust、cpp、java、c 各 2，cs、js 各 1），出题者用 Sonnet 5.5（high）。
- 结果 / 数据：抓住率 90%（9/10），过了一半的停止线。抓住的 9 题人工看过失败日志，都是断言或 issue 描述的崩溃，不是构建失败。出题共 2.1 美元，单题 17–337 秒；整轮约 1.5 小时。漏掉的 duckdb-24318（`fails_on_fixed`）：出题者在 issue 的复现上多加了一行真 NULL，gold 修复没覆盖「字面 'NULL' 和真 NULL 混在一起」的情况，测试超出了 issue 的范围。
- 遇到的问题：root-22854 的出题补丁带进了构建产物（`build/` 下的 .o、ninja 日志），因为洗过的 git 历史把没被忽略的 `build/` 也提交了。这次没影响判卷。
- 下一步：剩下 50 题用 Sonnet 跑完；10 题样本太小，不下结论。

## 2026-10-22 第 0 步改用 SWE-bench-Live 出题

- 做了什么：第 0 步的考题从「自己仓库的 bug 修复提交」改成 SWE-bench-Live 上训练截止日之后的题，写进 roadmap。
- 遇到的问题：自己的仓库没有成批、已知的 bug 修复提交；SWE-bench Verified 等静态题可能进了训练数据。
- 下一步：确认出题者所用模型的训练截止日，按日期筛题，搭判卷脚本。

## 2026-10-23 多 agent 平台设想入待定

- 做了什么：对照设计确认「集成所有 agent、自由设置角色」不在 v1 范围内（D12 只接 Claude 和 Codex，D21 前端绑定 Claude Code，D38 不追求更多 agent），作为 P14 记入 roadmap，留到 v2。

## 2026-10-22 设计文档落地到 docs/

- 做了什么：把 Notion《指挥所 v1 设计》拆进 prd、tech_stacks、roadmap；architecture 和 history 初始化为模板。定下技术栈（ADR-1）。
- 遇到的问题：Notion 的三张内嵌图导不出来，改用 Mermaid 按文字复原；M2、M4 的完成标准原文只在图里，待补。
- 下一步：路线第 0 步，考出题者。

<!--
条目模板：

## YYYY-MM-DD 标题

- 做了什么：
- 结果 / 数据：
- 遇到的问题：
- 下一步：
-->
