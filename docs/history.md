# 历史

按时间记录做项目的过程：做了什么、遇到了什么、学到了什么。新条目加在最上面。

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
