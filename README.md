# ClaudeCodeRemoteControl

ClaudeCodeRemoteControl，简称 CCRC，用来从 QQ 远程操作正在运行的 Claude Code 会话。

它不是另起一个 `claude -p` 进程，也不靠 tmux 截取终端内容。每个 Claude Code 会话通过 Channel 接入本机 Broker，QQ 发来的消息会进入你选中的会话，Claude 的回复则会发回 QQ。终端和 QQ 可以同时使用，不需要二选一。

目前只实现了 QQ 官方 Bot。平台层是独立的，后续可以继续接入其他消息平台。

## 能做什么

- 在 QQ 中查看并切换本机在线的 Claude Code 会话。
- 从 QQ 给指定会话发送任务。
- 把所有会话的回复同步到 QQ，包括从本地终端发起的任务。
- 把权限确认和 `AskUserQuestion` 转成 QQ 按钮，同时保留 Claude 终端里的原生选择框。
- 使用 QQ Markdown 显示回复，并在消息底部标出会话标题和工作目录。
- 隐藏工具的具体命令和参数，只在 Claude 本身有说明文字时显示简短的执行状态。纯工具调用不会单独推送。

`/session` 选择的只是“QQ 下一条消息发给谁”。它不会过滤其他会话的输出。

## 运行条件

- Node.js 20 或更高版本
- Claude Code 2.1.247 或更高版本，建议使用最新版
- 可以使用 Claude Code Channels 的账号或组织
- QQ 开放平台创建的官方机器人，以及它的 App ID 和 App Secret

Channels 目前仍是 Claude Code 的 research preview。自定义 Channel 必须在 Claude 启动时加载，不能无感挂到一个已经启动的进程中。CCRC 提供了 resume 和 handoff 流程来保留原会话。

## 安装

克隆仓库：

```bash
git clone git@github.com:linyuchen/CCRC.git
cd CCRC
```

仓库已经包含构建后的 Plugin 文件，普通使用不需要先安装 npm 依赖或执行构建。先创建配置：

```bash
./bin/ccrc config init
```

然后编辑 `~/.ccrc/config.json`：

```json
{
  "broker": {
    "host": "127.0.0.1",
    "port": 43921,
    "autoStart": true,
    "mirrorLocalReplies": true
  },
  "platforms": [
    {
      "type": "qqbot",
      "id": "qqbot",
      "enabled": true,
      "appId": "YOUR_QQ_BOT_APP_ID",
      "appSecret": "YOUR_QQ_BOT_APP_SECRET",
      "sandbox": false,
      "allowedSenders": ["YOUR_QQ_OPENID"],
      "allowedConversations": [],
      "shareGroupSession": false,
      "markdown": true
    }
  ]
}
```

`allowedSenders` 是可以远程控制 Claude 的 QQ OpenID 列表，不能省略。第一次不知道 OpenID 时，可以先填一个无效值，给 Bot 发一条消息，再从 `~/.ccrc/broker.log` 中的 `blocked QQ sender` 记录查看真实 OpenID。

不要长期使用 `"*"`。这会允许任何能联系到 Bot 的人控制你的 Claude 会话，也可能看到工作目录、权限请求和 Claude 回复中的内容。

安装 Claude Code Plugin：

```bash
./bin/ccrc plugin install
```

如果希望在任意目录直接使用 `ccrc`，可以把 `bin` 加入 PATH，或者创建一个链接：

```bash
mkdir -p ~/.local/bin
ln -s "$PWD/bin/ccrc" ~/.local/bin/ccrc
```

请确认 `~/.local/bin` 已经在 PATH 中。

## 启动

以后使用 `ccrc` 启动 Claude：

```bash
ccrc
```

它等同于：

```bash
ccrc claude
```

Claude 参数可以照常传入：

```bash
ccrc claude --model opus
```

CCRC 会自动加载 `ccrc@ccrc-local` Channel。Claude 启动时可能显示开发 Channel 的确认页，这是 Claude Code 对自定义 Channel 的现有限制，不代表它会跳过工具权限。

如果组织管理员已经允许该 Channel，可以改用普通的 `--channels` 模式：

```bash
CCRC_CHANNEL_FLAG=--channels ccrc
```

### 让 `claude` 命令默认经过 CCRC

在 `~/.zshrc` 中加入：

```bash
eval "$(ccrc shell-init zsh)"
```

重新打开终端后，直接执行 `claude` 也会自动加载 CCRC。临时绕过时使用 `command claude`。

### 接管已经存在的会话

先安装 Plugin，然后在旧 Claude 会话中执行：

```text
/ccrc:handoff
```

它会给出对应的 resume 命令。退出旧会话后再执行该命令，不要让两个 Claude 进程同时占用同一个 session ID。

也可以手动运行：

```bash
ccrc resume <session-id>
```

Plugin 更新后，已经打开的 Claude 会话可以执行 `/reload-plugins`；如果重载没有生效，退出后再用 `ccrc resume` 进入。

## QQ 中的命令

| 命令 | 作用 |
| --- | --- |
| `/session` | 列出在线会话，并用数字按钮选择 QQ 的输入目标 |
| `/current` | 查看当前输入目标 |
| `/rename 新名称` | 给当前会话设置一个更容易识别的名称 |
| `/help` | 查看帮助 |

其他文本会直接发送给当前选中的 Claude 会话。只有一个在线会话时会自动选中。

## 回复、权限和选择题

只要一个通过白名单验证的 QQ 对话给 Bot 发过消息，它就会登记为输出接收端。之后所有已加载 CCRC Hook 的 Claude 会话都会把可见回复广播到这些接收端。登记结果保存在 `~/.ccrc/state.json`，Broker 重启后仍然有效。

CCRC 不发送 Claude 的思考内容，也不发送工具参数或具体命令。Claude 在调用工具前写了说明时，QQ 会看到说明和类似“正在搜索文件…”的状态；如果这一段只有工具调用，则不会产生一条只有状态的 QQ 消息。最终回复仍会正常发送。

Claude 请求工具权限时，QQ 会显示“允许”和“拒绝”按钮，也可以回复形如 `yes abcde` 或 `no abcde` 的文本。

Claude 使用原生 `AskUserQuestion` 时，QQ 按钮和终端选择框会同时出现，先完成的一端获胜：

- QQ 先完成，终端选择框会结束。
- 终端先完成，QQ 会收到“选择已结束”，并显示本次问题和答案。
- 同一次调用包含多个问题时，Claude Code 只会在整组提交后通知 Hook，因此终端侧的答案会在全部完成后一次同步。

## Broker 管理

```bash
ccrc broker status
ccrc broker logs
ccrc broker restart
ccrc broker stop
ccrc broker start
```

第一个 CCRC 会话会自动启动 Broker。所有 Claude 会话退出后，Broker 默认继续运行，以保持 QQ Gateway 在线。

运行数据都在 `~/.ccrc/`：

- `config.json` 保存平台配置和凭据。
- `state.json` 保存会话选择、别名和输出接收端。
- `runtime/broker.token` 是本机进程间通信使用的随机令牌。
- `broker.log` 用于排查连接和消息问题。

这些文件不属于仓库，也不应该提交。可以通过 `CCRC_HOME` 或 `CCRC_CONFIG` 修改存放位置。

## 常见问题

### QQ Bot 没有显示在线

先检查：

```bash
ccrc broker status
```

再查看日志路径：

```bash
ccrc broker logs
```

常见原因是 App ID 或 App Secret 错误、QQ Gateway 尚未连接，或者配置修改后没有重启 Broker。

### QQ 能发消息，但看不到某个会话的回复

确认该会话出现在 `ccrc broker status` 中，并且启动后加载过最新版 Plugin。旧会话先尝试 `/reload-plugins`。

长任务中的阶段性文字会在工具调用边界发送，不是逐 Token 抓取终端画面。Claude Code 当前没有向 Plugin 或 Channel 暴露交互会话的 Token 增量。

### 出现 background agent 提示

同一个 session ID 仍被另一个 Claude 进程占用。先退出原进程，再执行 `ccrc resume <session-id>`。如果确实需要分支副本，使用 Claude Code 提供的 `--fork-session`。

## 开发

修改源码后执行：

```bash
npm install
npm run format:check
npm run check
npm test
npm run build
claude plugin validate plugin/.claude-plugin/plugin.json
claude plugin validate .claude-plugin/marketplace.json
```

`plugin/dist/*.cjs` 会提交到仓库，因为 Claude Code 安装 Plugin 后需要直接运行这些文件。源码映射、依赖目录、日志和本机配置不会提交。

内部结构和平台适配接口见 [docs/architecture.md](docs/architecture.md)。

## License

MIT
