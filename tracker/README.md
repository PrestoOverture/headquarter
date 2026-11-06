# crewmeter

读取本机 Claude Code、Codex、OpenCode 的会话记录和相关 Git 仓库，生成任务测量报告。记录的测量包括模型与 agent 组合、token 用量（输入、缓存读写、输出）、记录中已有的费用、用户插话与打断次数、等待用户的时间，以及关联提交的合入、回滚、14 天返工证据；`--ci` 可补充 GitHub checks。

这些是本地记录中的测量，不是能力评分或因果结论。部分提交按仓库和时间推测归属；返工只覆盖已成熟的合入任务及回滚、修复提交改写的行，无法覆盖所有缺陷。等待用户的时间每段最多计 60 分钟，缺失的 token 或费用无法凭空补齐；报告会标记样本少的分组。

## 本地安装与运行

需要 Node.js **>=22.13** 和本地 `git`；读取压缩的 Codex `.zst` 日志还需要 `zstd`，`--ci` 需要已配置好 GitHub 访问权限的 `gh`。Bun 可通过 `bunx crewmeter` 调用同一安装。

此项目保留 `private: true`，本次仅验证本地 tarball，未发布到 npm。源码构建需要 Bun，安装打包后的 tarball 不需要构建：

```sh
cd tracker
bun run build
npm pack  # prepack 会再次运行 build

# 在另一个临时目录中安装；替换成刚生成的 tarball 的绝对路径
npm install /absolute/path/to/crewmeter-0.1.0.tgz
npx crewmeter --version
npx crewmeter --help
```

## 三个命令

```sh
npx crewmeter collect --out out/report.html
npx crewmeter serve --host 127.0.0.1 --port 4317 --open
npx crewmeter mcp
```

- `collect`：默认命令（省略子命令也可），生成独立 HTML 报告和同名 `.tasks.json`，在终端打印有仓库、有提交的任务汇总；终端表默认排除无人值守任务。
- `serve`：启动支持刷新数据的 HTTP 仪表盘，默认地址 `http://127.0.0.1:4317/`，可用 `Ctrl+C` 结束进程。
- `mcp`：启动 stdio MCP 服务，提供 `summary`、`trend`、`tasks`、`refresh`、`dashboard` 五个工具；协议写到 stdout，收集日志写到 stderr。启动时在后台收集，工具调用等待数据；`dashboard` 返回本机仪表盘地址。

`crewmeter --help` 列出所有命令和参数，`crewmeter collect --help`、`crewmeter serve --help`、`crewmeter mcp --help` 分别列出子命令参数。`--version` 输出包版本。

### 三个命令共用的参数

| 参数 | 默认值 / 行为 |
| --- | --- |
| `--claude-dir <path>` | `~/.claude/projects`，读取 JSONL 会话及子 agent 记录 |
| `--codex-dir <path>` | `~/.codex/sessions`，读取 JSONL / `.jsonl.zst` 会话 |
| `--opencode-dir <path>` | `~/.local/share/opencode` 下的 `opencode.db`；也可直接传数据库文件路径 |
| `--since <YYYY-MM-DD>` | 只保留开始时间不早于该日期的任务；不传则不限制 |
| `--ci` | 默认关闭；通过 `gh api` 查询 GitHub checks，需要网络 |
| `--cache-dir <path>` | 默认 `$XDG_CACHE_HOME/crewmeter`，未设置或为空时用 `~/.cache/crewmeter` |
| `--no-cache` | 禁用会话、Git 和 CI 缓存的读写，每次重新收集；不会删除现有缓存 |
| `-h, --help` | 显示帮助并退出，不收集数据 |
| `-v, --version` | 显示版本并退出 |

缓存包含解析后的会话测量、Git 命令结果和 CI 查询结果。`--cache-dir` 可覆盖缓存位置；无缓存模式仍会按命令生成报告或提供服务。

### 命令专用参数

| 命令 | 参数 | 默认值 / 行为 |
| --- | --- | --- |
| `collect` | `--out <path>` | 相对当前工作目录的 `out/report.html`；同时写入 `out/report.tasks.json` |
| `collect` | `--include-headless` | 把无人值守任务加入终端表；不改变已收集的任务数据 |
| `serve` | `--host <host>` | `127.0.0.1`；仪表盘无身份认证，指定非回环地址会输出警告 |
| `serve` | `--port <port>` | `4317`；`0` 表示由系统分配空闲端口 |
| `serve` | `--open` | 用系统浏览器打开仪表盘，默认不打开 |

## 隐私与本地读写

对源会话记录、OpenCode 数据库和 Git 仓库只读，不修改工作区或提交；会写入自己的缓存及 `collect` 指定的输出文件。默认本地处理，不向外部网络发送数据；独立 HTML 无外部资源，`serve` 和 MCP 的仪表盘默认仅在回环地址提供 HTTP 服务。唯一可选的外部查询是 `--ci` 调用 `gh` 向 GitHub 请求仓库提交的 checks。

报告、JSON、缓存和 MCP 工具输出可能包含本地路径、仓库名、模型名、提交标题及返工证据中的代码行，应按本地项目数据保管。MCP 客户端收到的工具结果会进入该客户端的上下文，其后续数据处理取决于客户端配置。下面的 `npx -y` 示例在需要下载包及依赖时也会访问 npm，这属于安装阶段。

## MCP 配置

以下是通过包名启动的配置格式。由于本项目尚未发布，当前验证请在已安装 tarball 的目录运行，或将 `npx` 启动方式替换为 `node /absolute/path/to/install/node_modules/crewmeter/dist/cli.js mcp`。GUI 客户端需能找到 Node；自定义源目录和缓存时，在 `mcp` 后附加上面的共用参数。

### Claude Code

```sh
claude mcp add crewmeter -- npx -y crewmeter mcp
```

配置格式见 [Claude Code MCP 文档](https://code.claude.com/docs/en/mcp)。

### Codex

在 `~/.codex/config.toml` 中添加：

```toml
[mcp_servers.crewmeter]
command = "npx"
args = ["-y", "crewmeter", "mcp"]
```

配置格式见 [OpenAI 官方 MCP 文档](https://developers.openai.com/codex/mcp)。

### OpenCode

在项目的 `opencode.json` 中添加（与现有配置合并）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "crewmeter": {
      "type": "local",
      "command": ["npx", "-y", "crewmeter", "mcp"],
      "enabled": true
    }
  }
}
```

配置格式见 [OpenCode MCP 文档](https://opencode.ai/docs/mcp-servers/)。
