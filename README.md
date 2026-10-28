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
| 拖拽成员进群 | ✅ 智能体/真人拖到左侧群聊行或群聊详情页 |
| 首次进入的开场白 + 推荐问题 | ✅ 模型生成，mock 有兜底 |
| **opencode 执行引擎** | ✅ sidecar + 每群每智能体一个 session |
| 工具调用 / 写入审批 | ✅ 工具卡片 + 允许一次 / 总是允许 / 拒绝 |
| opencode 运行时 | ✅ 自动扫描安装目录 / 手动指定 / 离线包 |
| opencode 模型双向同步 | ✅ 读本机 providers 反显导入 + 一键写回 sidecar |
| opencode 技能浏览 | ✅ 技能页展示内置 / 本机 / 项目 SKILL.md |
| 对话式新建技能 | ✅ 多轮追问 + TCP 连通性验证 + 确认后写入 |
| 知识库（RAGFlow） | ✅ 数据集启停、智能体绑定、检索引用角标 |
| 真人成员 / 群内邀请 | ✅ 登录后把人拉进群 |
| 找同事 | ✅ 服务端搜索 S-BOT 同事 + Mattermost 通讯录（在线/离线） |
| Mattermost 邀请 | ✅ 服务端模拟接口；填地址/Token 后切真实发送 |
| 成员加入事件 | ✅ 真人加入问上下文看法，智能体加入按擅长方向提问 |
| 真人在线状态 | ✅ 30 秒心跳，模拟真人常驻在线 |
| 智能体 @ 真人软等待 | ✅ 暂停剩余发言，60 秒倒计时，可回复 / 继续 / 跳过 |
| 发言上限 | ✅ 1~5 条或无限制；无限制时全员讨论，冲突自动 @ 所有真人 |
| 模拟真人 | ✅ 预置李娜、王强、陈晨，被 @ 后自动回复 |
| 服务端消息推送 | ✅ `/api/events` SSE，其他客户端实时刷新 |
| 附件对话 | ✅ 文本/代码/CSV/JSON 等读取正文给智能体；图片先只报文件名 |
| 智能体归属 | ✅ 私有智能体只有创建者能拉进群 |
| 智能体库 | ✅ 卡片、增删改复制 |
| 对话式创建智能体 | ✅ 多轮对话生成名字、职位、擅长和人设，确认后填入表单 |
| 设置（多模型） | ✅ |
| 主题 | ✅ 亮色 / 暗色 / 跟随系统，本地记忆 |
| **Windows 安装包** | ✅ `S-BOT Setup 0.1.2.exe`（NSIS） |

还没接：真实 XABP 登录（当前是原型级按名字登录）、移动端、自动更新。

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
| POST | `/api/agents/coach` | 对话式设计智能体，返回回复和结构化草案 |
| GET | `/api/conversations` | 会话列表（含成员、最后一条消息） |
| GET | `/api/conversations/:id/messages` | 消息历史 |
| POST | `/api/conversations/dm` | 打开单聊（`agentId` 或 `humanId`） |
| POST | `/api/conversations/:id/messages` | 发消息，返回 SSE 流 |
| GET | `/api/conversations/:id/export` | 导出交接包（聊天记录 + 任务） |
| POST | `/api/conversations/:id/import` | 导入交接包到本群 |
| GET | `/api/conversations/:id/intro` | 首次进入的开场白 + 推荐问题（模型生成，缓存 30 分钟） |
| GET | `/api/opencode/status` | sidecar 是否可用 / 正在运行 / 数据目录 |
| POST | `/api/opencode/detect` | 扫描常见安装位置，或检测指定目录/可执行文件 |
| POST | `/api/opencode/open-data` | 打开本地数据目录 |
| POST | `/api/opencode/install` | 从离线 zip 安装 sidecar |
| GET | `/api/opencode/importable` | 本机 opencode 配置里的自定义模型（用于反显/导入） |
| POST | `/api/models/sync` | 把 S-BOT 的全部模型写进 sidecar 的 opencode 配置 |
| GET | `/api/skills` | opencode 可用技能（内置 + 本机 + 项目） |
| POST | `/api/skills` | 确认草案后写入 SKILL.md 并挂载给 opencode |
| POST | `/api/skills/coach` | 技能教练：多轮对话 + 自动 TCP 连通性验证 |
| POST | `/api/skills/verify` | 单独做一次 TCP 连通性测试 |
| GET | `/api/humans` | 真人列表（含在线状态、是否模拟） |
| GET | `/api/colleagues?q=` | 找同事：合并 S-BOT 真人和 Mattermost 用户 |
| GET | `/api/mattermost/status` | Mattermost 配置与连接状态 |
| POST | `/api/mattermost/invite` | 给指定 Mattermost 账号发私信邀请 |
| GET | `/api/mattermost/mock/posts` | 查看模拟 Mattermost 发出的私信（没配置真实服务时） |
| POST | `/api/login` | 原型级登录 |
| POST | `/api/presence` | 真人在线心跳 |
| POST | `/api/conversations/:id/humans` | 把真人拉进群 |
| POST | `/api/runs/:runId/resume` | 软等待：继续 / 跳过 |
| POST | `/api/runs/:runId/reply` | 软等待：以被 @ 真人的身份回复 |
| POST | `/api/permissions/:requestID` | 审批工具调用（once / always / reject） |
| GET | `/api/tasks` | 任务列表（未完成在前） |
| POST | `/api/tasks` | 新建任务 |
| PATCH | `/api/tasks/:id` | 改标题 / 描述 / 关联群 / 优先级 / 状态 |
| DELETE | `/api/tasks/:id` | 删除任务 |

SSE 事件：

```
event: run.start       { runId, userMessageId, targets }
event: message.start   { id, agentId, name, role, color, initial }
event: message.delta   { id, delta }
event: message.end     { id, agentId, savedId, text, createdAt, status }
event: human.wait      { runId, conversationId, humanId, name, seconds, remaining }  // 智能体 @ 真人，暂停
event: human.resume    { runId, decision }   // reply / continue / skip / timeout
event: presence        { humanId, online }   // 真人上线
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

### 工作台

- 左侧消息列右上角的 **+** 直接发起群聊（和「新建群聊」快捷入口一样）
- 任务超过 5 个、智能体超过 6 个、同事超过 6 位、最近会话超过 4 条时自动收起，
  底部出现「展开剩余 N 个 / 收起」，不用一屏塞满
- 切换任务「进行中 / 已完成」时，任务列表会回到收起状态

### 附件

- 输入框支持拖入或选择文件；文本类文件（`.txt/.md/.csv/.json/.yaml/.xml/代码文件` 等，≤ 512KB）
  会把正文读出来一起发给智能体，智能体可以按内容回答
- 每个文件最多带 6000 字，单条消息总共约 12000 字，超出会截断
- 图片目前只带文件名和大小：DeepSeek / Qwen 这类文本模型读不到像素；等接入视觉模型再补
- PDF / Word 等二进制文件暂时只报文件名，不会解析正文

### 拖拽入群

- 拖拽源：左侧单聊行、工作台里的智能体卡片、工作台「同事」里的真人卡片
- 落点：左侧任意群聊行，或当前群聊详情页（拖到主区域会显示「松开加入」遮罩）
- 已在群里 / 群满 6 个智能体会提示，不会重复加入
- 真人按名字去重，加入后插一条「XX 加入了群聊」的系统消息

### 对话式新建技能

技能页右上角「+ 新增技能」不会让你手写 YAML，而是先和技能教练聊：

1. 描述需求（比如「通过堡垒机 10.1.2.3:22 巡检内网服务器」）
2. 教练每次追问 2~3 个关键问题：触发场景、前置条件、步骤、成功标准、失败处理
3. 需要验证连通性时，模型输出一个 `verify` 代码块，服务端代跑 TCP 测试并把结果回传给模型
4. 信息够了，模型输出 `skill` 代码块；前端解析成可编辑草案（ID / 名称 / 描述 / 正文）
5. 你确认后才 `POST /api/skills` 落盘，并重写 sidecar 配置让 opencode 重新加载

安全约定：**明文密码、密钥、token 不写进技能文档**。教练会要求用 `${BASTION_PASSWORD}` 这类环境变量占位符，
并在「前置条件」里写清楚怎么配置。落盘位置二选一：

- 全局：`~/.config/opencode/skills/<id>/SKILL.md`
- 项目：仓库根目录 `.opencode/skills/<id>/SKILL.md`

> 技能目录是在 opencode sidecar 启动时挂载的。写入后如果列表没立刻出现，重启一次 sidecar 即可。

### 对话式创建智能体

智能体库右上角除了「+ 新建智能体」，还有「✦ 对话生成」：

- 说出你想要什么同事：负责什么、给谁用、说话直接还是温和、哪些事不要插手
- 教练会追问关键细节，信息够了生成结构化草案
- 草案包含名字、职位、一句话简介、3~5 个擅长标签、system prompt 和头像颜色
- 确认后只是**填入表单**，模型、知识库、权限还可以继续改，最后自己点创建
- 没有模型时接口会明确提示先配置模型

### 主题

设置 → 外观里有「暗色 / 亮色 / 跟随系统」。选择存在 `localStorage`，跟随系统时监听
`prefers-color-scheme`，系统切换后界面立即跟着变。

### 模型双向同步

- **opencode → S-BOT**：设置页「opencode 配置里的模型」读取本机 `~/.config/opencode/opencode.json(c)` 的
  `providers`，可以单个或全部导入。导入只带模型名和 Base URL，API Key 需要自己补。
- **S-BOT → opencode**：每次增删改模型、设默认模型都会自动同步；也可以点「同步到 opencode」手动触发。
  同步目标是 S-BOT 自己 sidecar 的配置（同一 Base URL 归到一个 provider），不会改写你本机的 opencode 配置。

### opencode 装在哪

设置 → opencode 运行时 会直接显示：

- **当前使用**：真实跑起来的可执行文件路径，可一键复制
- **数据目录 / sidecar 目录**：本地数据库和离线包装在哪，都能复制，也能点「打开数据目录」
- **自动扫描**：会扫 `%LOCALAPPDATA%\Programs\*`（包括 opencode 桌面版自带的 CLI）、npm 依赖、PATH；
  扫到多个版本会列出来，点一个就切换
- **手动指定**：填安装目录（例如 `C:\Users\你\AppData\Local\Programs\ai.opencode.desktop`）或直接填
  `opencode.exe` 路径，点「使用这个位置」，S-BOT 会自动在目录里找 `opencode-cli.exe`

内网装不了时，再展开「内网离线包 / 覆盖安装」，把 zip 地址填进去。

### 真人在线 / 软等待 / 模拟真人

- 登录后客户端每 30 秒发一次心跳；2 分钟没心跳算离线
- 消息列新增「同事」分组：显示在线人数和在线圆点，点一下直接单聊（模拟真人会自动回），也可以直接拖进群
- 工作台「同事」同样显示在线圆点和「模拟真人」标签，拖进群就能一起协作
- 智能体发言里 `@真人` 会触发**软等待**：剩余智能体暂停，输入框上方出现等待条，
  60 秒倒计时结束自动继续；也可以直接「回复」「继续」或「跳过」
- 预置三个模拟真人：**李娜（增长运营）**、**王强（后端工程师）**、**陈晨（UI 设计师）**。被 @ 后 3~5 秒自动回一句，
  没配模型也能演示完整对话和软等待
- 没有模型时，mock 回复也会让第一个智能体 @ 真人，方便测试这条链路

### 群聊发言规则

- 群聊设置里的「单条消息最多发言」支持 `1~5 条` 和 `无限制`
- 无限制 = 群里所有智能体都发言；后发言的智能体会带上前面的上下文，能接话和反驳
- 跑完后用默认模型判断是否存在明确分歧；有冲突时由最后一个发言的智能体
  `@所有真人`，并附一句分歧概括，请真人拍板
- 没有模型时用关键词兜底判断；模拟真人被 @ 后会自动回应

### 找同事

工作台点「找同事」会打开服务端搜索：

- S-BOT 里的真人：在线 / 离线都会显示，点一下直接单聊
- 配置了 Mattermost 后：同一个搜索框会按姓名、角色、账号搜公司通讯录，显示在线 / 离开 / 勿扰 / 离线
- Mattermost 同事点「发消息」会打开邀请弹窗，预填账号和当前群聊上下文

### Mattermost 邀请

设置 → **Mattermost** 填地址和 Token（需要能读用户、状态和发私信的权限）。「邀请更多」会把消息通过服务端发给指定账号：

1. `GET /users/username/:name` 找到账号
2. `POST /channels/direct` 建私聊
3. `POST /posts` 发送邀请消息

**没填地址 / Token 时走服务端模拟接口**：找同事会返回周敏（在线）、李强（离线）、王璐（离开）三个模拟账号，
邀请会记录到服务端内存并通过 `/api/mattermost/mock/posts` 查看，不会真的发出去。后续接真实 Mattermost
只需要填配置，调用方和 UI 都不用改。

> Mattermost 配置卡片只在**本地模式**显示。切到「连接服务器」后这张卡片会隐藏，Mattermost 由服务端统一配置。

邀请消息默认带上当前群名，也可以自己改。

### 成员加入事件

真人或智能体被拖进群聊时，服务端除了写系统消息，还会异步触发一次「加入事件」：

- **真人加入**：选一个已有智能体，先结合最近发言发一段带排版的摘要（最近在讨论 / 已经对齐 / 还需要确认），
  末尾 @ 他问「从你的角度怎么看」。摘要用聊天气泡单独高亮；模拟真人会自动回复
- **智能体加入**：新智能体按自己的擅长方向（skills / role）发一段带排版的上下文摘要，包含「最近在讨论 / 我的判断 / 我能接的部分」，最后给一个具体的下一步或分工建议
- 两种摘要都用单独高亮的摘要气泡显示，不会混成普通聊天或空附件
- 有默认模型时摘要由模型生成并整理成纯文本排版（• 列表、分段，不用 Markdown 符号）；没有模型时用模板兜底

---

## Electron 打包

`apps/desktop` 是独立的 npm 项目（不在 workspace 里，避免根目录安装时下载 Electron 二进制）。

```bash
cd apps/desktop
npm install          # 首次会下载 Electron，走 npmmirror 镜像更快
npm run build:main   # 编译主进程
npm run dist         # 出 Windows 安装包 -> release/S-BOT-Setup-0.1.2.exe
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
- 桌面提醒是自绘的无边框小窗，配色跟随亮色 / 暗色主题；点击回到主窗口
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

1. **真实 XABP 登录**：SSO、组织架构、在线状态由服务端统一维护
2. 真人消息已读 / 未读、@ 提醒和桌面通知聚合
3. 模拟真人接入真实 IM（企业微信 / 飞书），替换预置话术
4. 自动更新 + 代码签名
5. 服务器模式（共享数据库、鉴权、多端同步）
