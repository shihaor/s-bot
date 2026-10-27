# S-BOT

AI 同事和真人一起工作的桌面工作台。

当前是一个**可运行的垂直切片**：会话列表 → 消息历史 → 发消息 → 多智能体流式回复 → 落库。不是设计稿。

---

## 现在能跑什么

| 能力 | 状态 |
|---|---|
| 会话列表（群聊 / 单聊） | ✅ 从 SQLite 读 |
| 消息历史 | ✅ 持久化 |
| 发送消息 | ✅ |
| 多智能体顺序回复 | ✅ 一条用户消息触发 2~3 个智能体 |
| 流式输出 | ✅ SSE |
| `@` 指定智能体 | ✅ 只让被 @ 的回复 |
| 中断 | ✅ 停止按钮，保留已输出的部分 |
| 模型 | ✅ OpenAI 兼容接口，支持流式 |
| 无模型时 | ✅ 自动降级为 mock 回复 |
| 工作台 | ✅ 问候、快捷入口、任务、智能体、最近会话 |
| 任务 | ✅ 新建/编辑/完成/删除，可挂到群聊 |
| AI 判定完成 → 群里 @ 你确认 | ✅ 确认后任务置为完成 |
| 完结撒花 | ✅ canvas-confetti |
| 群设置里关联待分配任务 | ✅ |
| 取消执行 → 任务回到待分配 | ✅ 其他群可接手 |
| 导出 / 导入聊天记录（交接） | ✅ JSON 交接包，带任务 |
| 拖拽智能体进群 | ✅ 拖单聊 / 工作台卡片到左侧群聊 |
| 首次进入的开场白 + 推荐问题 | ✅ 模型生成，mock 有兜底 |
| **opencode 执行引擎** | ✅ sidecar + 每群每智能体一个 session |
| 工具调用 / 写入审批 | ✅ 工具卡片 + 允许一次 / 总是允许 / 拒绝 |
| opencode 离线包装载 | ✅ 设置/首次启动探测，默认内网地址 |
| 从 opencode 导入模型 | ✅ 读 ~/.config/opencode 的 providers |
| 知识库（RAGFlow） | ✅ 数据集启停、智能体绑定、检索引用角标 |
| 真人成员 / 群内邀请 | ✅ 登录后把人拉进群 |
| 服务端消息推送 | ✅ `/api/events` SSE，其他客户端实时刷新 |
| 智能体归属 | ✅ 私有智能体只有创建者能拉进群 |
| 智能体库 | ✅ 卡片、增删改复制 |
| 设置（多模型） | ✅ |
| **Windows 安装包** | ✅ `S-BOT Setup 0.1.0.exe`（NSIS，115 MB） |

还没接：RAGFlow 知识库、附件、真人成员、XABP 登录。

---

## 快速开始

```bash
cd s-bot
npm install
npm run dev
```

打开 http://localhost:5173

**不配模型也能跑**：没填 `LLM_BASE_URL` 时用本地 mock 回复。

要接真实模型：

```bash
cp .env.example .env
# 填 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
```

然后重启 `npm run dev`。服务端启动日志会打印 `runtime llm · <模型名>`。

---

## 目录

```
s-bot/
├─ apps/
│  ├─ web/          React + Vite（三栏界面）
│  └─ desktop/      Electron 壳（未安装依赖，见下）
├─ packages/
│  ├─ shared/       共享类型
│  └─ server/       Hono + SQLite + SSE + 模型调用
├─ scripts/dev.mjs  同时起 server 和 web
└─ .env.example
```

数据库默认在 `packages/server/data/sbot.db`（相对于服务进程的工作目录）。

---

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/runtime` | 当前模型模式（mock / 模型名） |
| GET | `/api/agents` | 智能体列表 |
| GET | `/api/conversations` | 会话列表（含成员、最后一条消息） |
| GET | `/api/conversations/:id/messages` | 消息历史 |
| POST | `/api/conversations/:id/messages` | 发消息，返回 SSE 流 |
| GET | `/api/conversations/:id/export` | 导出交接包（聊天记录 + 任务） |
| POST | `/api/conversations/:id/import` | 导入交接包到本群 |
| GET | `/api/conversations/:id/intro` | 首次进入的开场白 + 推荐问题（模型生成，缓存 30 分钟） |
| GET | `/api/opencode/status` | sidecar 是否可用 / 正在运行 |
| POST | `/api/permissions/:requestID` | 审批工具调用（once / always / reject） |
| GET | `/api/tasks` | 任务列表（未完成在前） |
| POST | `/api/tasks` | 新建任务 |
| PATCH | `/api/tasks/:id` | 改标题 / 描述 / 关联群 / 优先级 / 状态 |
| DELETE | `/api/tasks/:id` | 删除任务 |

SSE 事件：

```
event: run.start       { userMessageId, targets }
event: message.start   { id, agentId, name, role, color, initial }
event: message.delta   { id, delta }
event: message.end     { id, agentId, savedId, text, createdAt, status }
event: task.confirm    { message, task }   // 智能体判定任务已完成，@ 发起者确认
event: run.end         {}
```

任务完成的判定（`judgeTaskDone`）：每轮发言结束后，取该群最早一个未完成任务，
把它和任务创建之后的智能体发言一起交给默认模型，回答 `DONE` 就置为 `awaiting`
并在群里发一条带 `task-confirm` 卡片的 @ 消息；用户点「确认完成」才真正变 `done`。

### 群聊之间的任务交接

1. 在群里点「取消执行」把任务摘下来，任务回到「未分配 / 待分配」
2. 在群设置里「导出聊天记录」，得到 `群名-交接-YYYYMMDD.json`
3. 到接手的群打开群设置 →「导入到本群」
   - 聊天记录按原时间戳插入，作者名/颜色一起带过去（不在群里的作者显示为「来自交接记录」）
   - 交接包里未完成的任务会自动认领：同名任务从原群摘过来，不会复制一份
4. 也可以不导出任务，直接在接手的群里「+ 关联待分配任务」挑选

交接包格式：

```json
{ "kind": "s-bot-handoff", "version": 1, "exportedAt": 0,
  "conversation": { "title": "", "type": "group", "members": [] },
  "messages": [ { "authorType": "agent", "authorName": "老周", "role": "assistant",
                  "text": "", "parts": [], "createdAt": 0 } ],
  "tasks": [ { "title": "", "description": "", "priority": "high",
               "status": "todo", "creatorName": "我", "createdAt": 0 } ] }
```

### 首次进入的开场白

- 单聊（还没有消息）：`Hi，我是老周，产品经理。我能帮你需求拆解、优先级排序…有问题直接问我就行。` + 3 个推荐问题
- 群聊（还没有消息）：团队介绍 + 固定气泡「＋ 点击开始为团队加入任务」（打开新建任务并预选本群）+ 3 个推荐问题
- **有历史记录时**：同一批推荐问题变成小气泡，贴在输入框上方，随时可以点一条发出去
- 推荐问题由默认模型生成（要求返回 JSON 数组），没配模型时按成员擅长兜底；开场白按群缓存 30 分钟
- 点气泡直接当作一条消息发出去

### 拖拽入群

- 把左侧的单聊行、或工作台里的智能体卡片，拖到左侧任意群聊行
- 拖过去时会高亮并显示「松开加入」，底部有提示条
- 已在群里 / 群满 6 个智能体会提示，不会重复加入
- 加入后插一条「XX 加入了群聊」的系统消息

---

## Electron 打包

`apps/desktop` 是独立的 npm 项目（不在 workspace 里，避免根目录安装时下载 Electron 二进制）。

```bash
cd apps/desktop
npm install          # 首次会下载 Electron，走 npmmirror 镜像更快
npm run build:main   # 编译主进程
npm run dist         # 出 Windows 安装包 -> release/S-BOT Setup 0.1.0.exe
```

### 已打通的生产链路

```
Electron 主进程
  └─ 选一个空闲端口
  └─ 加载 server/index.cjs（esbuild 打好的单文件服务）
       ├─ API（Hono）
       └─ 静态前端（app.asar/web）
  └─ BrowserWindow 加载 http://127.0.0.1:<port>
```

- 数据库落在 `app.getPath('userData')/sbot.db`，不写进安装目录
- 服务端用 **`node:sqlite`**，没有任何原生模块，**不需要 electron-rebuild / Visual Studio**
- 已实测：打包后的 exe 启动、起服务、返回 UI 200

### 还没做

- 应用图标（现在用的是 Electron 默认图标）
- 代码签名
- Linux AppImage 实机验证（配置已写）
- 自动更新

开发模式跑 Electron：

```bash
# 终端 1
npm run dev          # web 5173 + api 8787
# 终端 2
cd apps/desktop && npm run dev   # 加载 localhost:5173
```

---

## 已知问题

**`node:sqlite` 需要 Node 22 的实验性开关**

开发时服务端脚本已经带上 `--experimental-sqlite`。如果你手动跑：

```bash
node --experimental-sqlite --import tsx src/index.ts
```

Electron 45 自带 Node 24，`node:sqlite` 已默认可用，打包后不需要任何开关。

**为什么不用 better-sqlite3**

13.x 在 Node 22 + ESM 下会崩（`0xC0000005`），11.x 可用；但用它就要为 Electron 重建原生模块，需要 Visual Studio C++ 工具链。换成内置的 `node:sqlite` 后，原生模块为零，打包干净很多。

---

## 下一步

1. **真人 @ 拍板 + 软等待**：智能体 @ 真人后暂停剩余发言，60 秒倒计时自动继续，也可手动「继续 / 跳过」
2. 把 Gate 脚本跑完，接 opencode 作为执行引擎（工具、权限、压缩）
3. RAGFlow 检索接入 + 引用角标
4. XABP 登录 + 真人成员/同事列表
5. Electron 打包 + 自动更新（发布时统一构建）
