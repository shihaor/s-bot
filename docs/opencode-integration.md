# 接入 opencode（V2）— 探针结论与落地方案

> 探针时间：2026-10-27 · opencode v2.1.4（Windows x64 sidecar）· 假模型验证管道
> 复跑：`npm run probe:opencode`

## 一、结论

| Gate | 内容 | 结果 |
|---|---|---|
| G1 | 同一 session 连续两轮，第二轮能引用第一轮 | ✅ PASS（真模型：记住「蓝鲸42」） |
| G2 | 事件流能拿到逐字增量 | ✅ PASS（`session.text.delta`） |
| G3 | 不同 session 不串记忆 | ✅ PASS |
| G4 | 工具调用 + 审批（允许 / 拒绝） | ✅ PASS（写文件，两次分支都对） |
| G5 | 中断能真的停下输出 | ✅ PASS（`session.interrupt` → `{interrupted:true}`） |

G4 实测细节（DeepSeek `deepseek-chat`）：

```
收到审批请求：action=edit resources=["hello.txt"]
→ 回复 once → session.tool.called / success → hello.txt 内容 "hi"
→ 回复 reject → bye.txt 没有创建
```

G6（打包）还没验。

## 二、验证过的接口细节

### 起服务

```bash
opencode serve --hostname 127.0.0.1 --port 41999
```

stdout 会打印：

```
server listening on http://127.0.0.1:41999
server password <随机串>
```

### 鉴权

Basic auth，用户名固定 `opencode`：

```
Authorization: Basic base64("opencode:<server password>")
```

### 客户端（@opencode/client 2.1.4）

```ts
import { OpenCode } from '@opencode/client'

const client = OpenCode.make({
  baseUrl: 'http://127.0.0.1:41999',
  headers: { authorization: `Basic ${btoa('opencode:' + password)}` },
})

const session = await client.session.create({ location: { directory: workspace } })
await client.session.prompt({ sessionID: session.id, text: '...' }) // 只返回 user message
await client.session.wait({ sessionID: session.id })                // 等助手跑完
await client.session.interrupt({ sessionID: session.id })           // 中断
await client.session.delete({ sessionID: session.id })              // 删会话
```

**坑**：`prompt()` 的返回值是刚入队的用户消息，不是助手回复。助手正文只能从事件
`session.text.delta` 里拼（`e.data.delta`，按 `e.data.sessionID` 过滤），或者等
`session.wait()` 之后读消息列表。

### 事件（`client.event.subscribe()`）

一次正常回复会依次出现：

```
session.inbox.enqueued
session.execution.started
session.inbox.delivered
session.step.started
session.text.started
session.text.delta        ← 逐字增量，直接映射我们的 message.delta
session.text.ended
session.step.streamed
session.step.ended
session.usage.updated     ← token 用量，可以记到消息上
session.execution.succeeded   / interrupted / failed
```

工具相关（下一阶段用）：

```
session.tool.input.started / delta / ended
session.tool.called
session.tool.progress
session.tool.success / failed
permission.asked / permission.replied
```

审批回复（实测）：

```ts
await client.permission.reply({
  sessionID,
  requestID,                 // permission.asked 事件里的 data.id
  decision: 'once',          // once | always | reject
})
```

权限配置（S-BOT 第一版就是这么写的）：

```jsonc
"permissions": [
  { "action": "edit", "resource": "*", "effect": "ask" },        // 写文件要审批
  { "action": "shell", "resource": "*", "effect": "ask" },       // 跑命令要审批
  { "action": "external_directory", "resource": "*", "effect": "ask" }
]
```

### 配置（给 opencode 加自定义 provider）

工作目录下放 `opencode.json`：
```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "sbot/deepseek-chat",
  "providers": {
    "sbot": {
      "name": "S-BOT",
      "env": ["SBOT_LLM_KEY"],
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "https://api.deepseek.com/v1" },
      "models": { "deepseek-chat": { "name": "DeepSeek Chat" } }
    }
  }
}
```

`env` 里的变量由 S-BOT 在 spawn sidecar 时注入，不要把 Key 写进文件。

## 三、配置热加载与运行时更新（实测）

### 不用重启的部分

- 改 `opencode.json`（model / providers / baseURL / 权限）→ **热加载**。实测写入后约 8 秒内，
  server 打出 `config.updated → provider.updated → model.updated`，`GET /api/model` 立刻多出新模型。
- 也可以直接 `PATCH /api/experimental/config` 改配置，不用碰文件。
- **凭据**有运行时接口，不用重启：
  - `POST /api/credential` 建
  - `PATCH /api/credential/{id}` 改
  - `POST /api/credential/{id}/activate` 激活
  - `DELETE /api/credential/{id}` 删

### 必须重启的部分

- **启动时注入的环境变量**（例如把 Key 放在 `SBOT_LLM_KEY` 里）——进程环境不会变，必须重启 sidecar。
  → 结论：**Key 不要走 env，走 `/api/credential`**。
- 换二进制 / 端口 / 启动参数。

### 重启的代价

- sidecar 冷启动约 1~2 秒；session 存在 opencode 自己的 DB 里，重启不丢。
- 正在跑的那一轮会中断（`execution.interrupted`），设置页保存时要提示。

### 数据隔离（复用人家的 opencode 时必须做）

实测这两个环境变量生效：

| 变量 | 作用 |
|---|---|
| `OPENCODE_DB` | 指定 opencode 自己的 sqlite 路径，不污染用户主实例 |
| `XDG_CONFIG_HOME` | 重定向配置目录（opencode 会读 `$XDG_CONFIG_HOME/opencode`） |

S-BOT 启动 sidecar 时固定注入：

```
OPENCODE_DB=<userData>/opencode/opencode.db
XDG_CONFIG_HOME=<userData>/opencode/config
SBOT_LLM_KEY=<...>   // 仅在用 env 方案时
```

## 四、安装策略：复用本机 or 内置

两种成本要分开看：

| 做法 | 安装包体积 | 磁盘占用 | 说明 |
|---|---|---|---|
| 内置 exe，安装时检测到就直接用本机的 | 不变（仍是 250MB 左右） | 可省一份 | NSIS 自定义脚本跳过解压 |
| 安装包不带 exe，首次启动下载 | **省 250MB** | 按需 | 需要下载源（内网镜像）或离线 zip |
| 内置 exe，始终用内置的 | +250MB | +250MB | 最确定，版本可控 |

**探测顺序（建议）**：

1. 环境变量 `SBOT_OPENCODE_BIN`（内网运维指定）
2. S-BOT 自己的 sidecar（`<userData>/sidecar/opencode.exe` 或安装目录 resources）
3. `PATH` 里的 `opencode`
4. 常见安装位置：`%LOCALAPPDATA%\Programs\opencode`、npm 全局、`~/.opencode/bin`

**版本门槛**：必须是 V2（`opencode --version` ≥ 2.x，且 `serve --help` 存在）。
V1（1.19.x）的 HTTP API 和事件名都不一样，直接拒绝并回退到内置/下载。

**推荐**：

- 内网正式交付：轻量安装包 + 内网下载源（10.201.2.38 放一份 zip），首次启动检测/下载，带进度和校验。
- 无外网的机器：单独出一个「离线全量包」，或者允许把 `opencode.zip` 放到安装目录，首次启动解压。
- 不管哪种，都注入上面那套 `OPENCODE_DB` / `XDG_CONFIG_HOME`，不碰用户自己的 OpenCode 数据。

## 五、落地方案（已定）

| 决定 | 选择 |
|---|---|
| 接入形态 | 随包 sidecar：打包 `opencode.exe`，`opencode serve` 起本地端口 |
| 工作目录 | 每个群一个：`<userData>/workspaces/<conversationId>/` |
| 权限 | 读/检索自动允许；写文件、跑 shell 走审批卡片 |

### 1. sidecar 生命周期（主进程）

- 启动 App 时 spawn，端口用 0 交给系统分配或挑空闲端口，`--hostname 127.0.0.1`
- 从 stdout 抓 `server password`，存内存，不落盘
- `/api/info` 探活；退出时 kill；崩溃自动重启一次
- 打包：`extraResources` 放 `opencode.exe`（win x64 约 247MB，安装包会明显变大）

### 2. 会话映射

新表 `agent_sessions`：

```sql
conversation_id TEXT, agent_id TEXT, session_id TEXT, workspace TEXT, updated_at INTEGER
PRIMARY KEY (conversation_id, agent_id)
```

- 每个「群 × 智能体」一个 session，第一次发言时创建
- 群名/成员变化不重建；智能体被移出群只解绑不删 session
- 发言人设：每轮 prompt 前注入「你是谁 + 本轮群聊上下文（别人的新消息）」

### 3. 事件 → 现有 SSE

| opencode | S-BOT |
|---|---|
| `session.text.started` | `message.start` |
| `session.text.delta` | `message.delta` |
| `session.execution.succeeded` + 消息落库 | `message.end` |
| `session.tool.*` | 新的 `tool.start / tool.end`（前端一张工具卡） |
| `permission.asked` | `permission.ask`（前端审批卡片） |
| `session.execution.failed` | `message.error` |

中断：前端停止按钮 → `session.interrupt({ sessionID })`，等 `execution.interrupted` 后再收尾。

### 4. 权限卡片

- 收到 `permission.asked`：暂停该 session 的后续事件展示，弹卡片（工具名 + 参数 + 允许/拒绝）
- 用户点允许 → 调 client 的 permission reply（下次实现时对照 `/openapi.json` 确认方法名）
- 60 秒无响应按「拒绝」处理，避免卡死

### 5. 编排

- 群聊仍然由我们的 `pickTargets` 决定顺序，逐个 `session.prompt`
- 智能体 @ 真人 → 暂停剩余发言（软等待），和 opencode 的 permission 是两套机制，别混
- 真实模型下要验证：同一 session 里多次 prompt 的上下文成本、工具调用是否串台

## 六、下一步清单

1. ~~`packages/server`：`opencode/manager.ts`（spawn / 探活 / 密码 / 关闭）~~ ✅ `src/opencode.ts`
2. ~~`packages/server`：`opencode/runtime.ts`（session 映射 + 事件转 SSE）~~ ✅ 同文件
3. ~~`db.ts`：`agent_sessions` 表~~ ✅
4. ~~`runtime.ts`：加 `SBOT_RUNTIME=opencode` 开关，保留 mock / openai 兜底~~ ✅ `auto` 默认
5. ~~前端：工具卡 + 审批卡 + 停止接 `interrupt`~~ ✅
6. 打包：`prepare.mjs` 拷 `opencode.exe` 到 resources（发布时再做）

### 实现位置

| 文件 | 作用 |
|---|---|
| `packages/server/src/opencode.ts` | 探测二进制、起停 sidecar、写配置、session 映射、事件转内部事件、审批 |
| `packages/server/src/index.ts` | 每轮发言走 opencode；SSE 增加 `tool` / `permission.ask`；`/api/permissions/:id` |
| `packages/server/src/repo.ts` | `agent_sessions` 读写 |
| `apps/web/src/App.tsx` | 工具 chip、审批弹窗、输入框上方的推荐问题 |
| `apps/web/src/Panels.tsx` | `PermissionDialog` |

### 运行时开关

| 变量 | 效果 |
|---|---|
| 不设置（`auto`） | 有 Key + 找得到 opencode v2 → 用 opencode；否则退到 LLM / mock |
| `SBOT_RUNTIME=llm` | 强制走原来的 OpenAI 兼容流式 |
| `SBOT_RUNTIME=mock` | 强制 mock |
| `SBOT_OPENCODE_BIN` | 指定 opencode 可执行文件 |

数据落在 `data/opencode/`：`opencode.db`、`config/opencode/opencode.json`、`workspaces/<conversationId>/`。

## 七、风险

- **真模型才能验 G4**：假模型不产生工具调用和 permission 事件。需要一个可用 Key。
- **体积**：win x64 CLI 约 247MB，安装包会从 115MB 涨到 300MB+；Linux 同样。
- **工具执行范围**：workspace 之外的路径必须在权限层挡住。
- **多智能体成本**：每个群每个智能体一个 session，长群聊的上下文会快速增长，靠 opencode 自己的压缩策略。
