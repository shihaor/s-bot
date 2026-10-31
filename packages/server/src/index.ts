import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createConnection } from 'node:net';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import type { ChatIntro, Conversation, Member } from '@sbot/shared';
import {
  addMember,
  addMessage,
  clearAgentSessions,
  createAgent,
  findConversationByP2PGroup,
  getP2PState,
  setP2PState,
  upsertP2PAgent,
  upsertP2PHuman,
  createGroup,
  createModel,
  createTask,
  deleteAgent,
  deleteConversation,
  deleteModel,
  deleteTask,
  ensureDm,
  ensureHumanDm,
  getAgent,
  getConversation,
  getDefaultModel,
  getModel,
  getSettings,
  getTask,
  getHuman,
  getWorkflow,
  saveWorkflow,
  deleteWorkflow,
  upsertHuman,
  listAgents,
  listConversations,
  listHumans,
  listMessages,
  listModels,
  listTasks,
  removeMember,
  saveSettings,
  setDefaultModel,
  DEFAULT_OPENCODE_URL,
  tasksForConversation,
  touchAgentSession,
  updateAgent,
  updateConversation,
  updateMember,
  updateModel,
  updateTask,
} from './repo.js';
import { generateReply, completeChat, type ChatTurn, type ModelConfig } from './runtime.js';
import {
  applyBinaryPath,
  createSkill,
  ensureSession,
  ensureStarted as ensureOpencode,
  getStatus as getOpencodeStatus,
  importableModels,
  installFromZip,
  listSkills,
  openDataDir,
  resetBinaryCache,
  resetSkillInventory,
  resolvePermission,
  runAgent,
  scanBinaryCandidates,
  shutdown as shutdownOpencode,
  syncModelConfig,
} from './opencode.js';
import { listDatasets, ragflowStatus, retrieve } from './ragflow.js';
import { getLanIdentity, getLanPeers, registerPeer, setLanIdentity, setLanPort } from './lan.js';
import {
  getMattermostStatus,
  getMockMattermostPosts,
  searchMattermostUsers,
  sendMattermostDm,
} from './mattermost.js';
import { broadcast, bus } from './events.js';
import { generateWorkflow, validateWorkflow } from './workflow.js';
import { resolveWorkflowApproval, runWorkflow } from './workflowRunner.js';

const app = new Hono();
app.use('*', cors());

/** 工作流产物目录：实现完成的 HTML 放这里，通过 /api/artifacts 预览 */
const dataDir = resolve(process.env.SBOT_DATA_DIR ?? dirname(process.env.SBOT_DB ?? './data/sbot.db'));
const artifactRoot = join(dataDir, 'artifacts');

const toConfig = (m: ReturnType<typeof getModel>): ModelConfig | null =>
  m ? { baseUrl: m.baseUrl, apiKey: m.apiKey, model: m.model } : null;

app.get('/api/health', (c) => c.json({ ok: true }));

app.get('/api/runtime', (c) => {
  const d = getDefaultModel();
  const ready = !!(d && d.baseUrl && d.apiKey);
  const oc = getOpencodeStatus();
  const mode = process.env.SBOT_RUNTIME?.toLowerCase();
  if (ready && oc.available && mode !== 'llm' && mode !== 'mock') {
    return c.json({ mode: 'opencode', label: `opencode · ${d!.name}` });
  }
  return c.json({ mode: ready ? 'llm' : 'unset', label: ready ? d!.name : '未配置模型' });
});

app.get('/api/opencode/status', (c) => c.json({ data: getOpencodeStatus() }));

/** 扫描常见安装位置；传 path 就直接检测这个目录/文件 */
app.post('/api/opencode/detect', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  const path = String(b?.path ?? '').trim();

  if (b?.save === true) {
    const r = applyBinaryPath(path);
    return c.json({ data: { ...r, candidates: scanBinaryCandidates() } }, r.ok ? 200 : 400);
  }

  const candidates = scanBinaryCandidates(path || undefined);
  return c.json({
    data: {
      ok: candidates.length > 0,
      candidates,
      status: getOpencodeStatus(),
      error: candidates.length ? undefined : path ? '这个位置没找到可用的 opencode' : '常见位置都没找到 opencode',
    },
  });
});

app.post('/api/opencode/open-data', (c) => c.json(openDataDir()));

app.get('/api/opencode/importable', (c) => c.json({ data: importableModels() }));

/* ---------- 技能 ---------- */

const SKILL_COACH_PROMPT = `你是 S-BOT 的技能教练，负责帮用户把一段可重复的操作流程整理成 opencode 技能（SKILL.md）。

工作方式：
1. 用中文多轮对话。先弄清目标、触发场景、前置条件、具体步骤、验证成功的方法、失败处理。
2. 每次最多问 2~3 个关键问题，不要一次列一长串清单，也不要编造用户没提供的信息。
3. 用户给出堡垒机 / 内网地址时，你可以请求做连通性验证。请求格式必须单独放在一个代码块里：
\`\`\`verify
{"host":"10.1.2.3","port":22}
\`\`\`
服务端会做 TCP 连接测试，并把结果返回给你。端口不确定时先问用户，默认 SSH 是 22。
4. 安全红线：绝对不要在技能文档里写明文密码、密钥或 token。需要凭据时，写成环境变量或占位符（例如 \${BASTION_PASSWORD}），并在「前置条件」里说明怎么配置。
5. 只有信息足够时才输出完整草案。草案必须放在一个 \`\`\`skill 代码块里，内容就是最终要写入磁盘的 SKILL.md：
\`\`\`skill
---
name: 技能名称
description: 一句话说明什么时候该用这个技能
---

## 适用场景
...
## 前置条件
...
## 操作步骤
1. ...
## 验证
...
## 常见问题
...
\`\`\`
6. 输出草案后，用一句话请用户确认；用户确认前不要声称已经保存或已经生效。
7. 普通回复保持简洁，不要重复整份草案，除非用户要求修改。

当前环境：${process.platform}，日期 ${new Date().toISOString().slice(0, 10)}。
全局技能会写入 ~/.config/opencode/skills/<id>/SKILL.md，项目技能会写入仓库的 .opencode/skills/<id>/SKILL.md。`;

function probeTcp(host: string, port: number, timeoutMs = 5000): Promise<{
  ok: boolean;
  host: string;
  port: number;
  ms: number;
  error?: string;
}> {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const socket = createConnection({ host, port });
    const finish = (ok: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, host, port, ms: Date.now() - started, error });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, `连接超时（${timeoutMs}ms）`));
    socket.once('error', (e) => finish(false, String((e as Error).message ?? e)));
  });
}

function parseEndpoint(input: any): { host: string; port: number } | null {
  let host = String(input?.host ?? '').trim();
  let port = Number(input?.port ?? 0);
  const raw = String(input?.address ?? input?.url ?? '').trim();

  if (!host && raw) {
    const withoutScheme = raw.replace(/^[a-z]+:\/\//i, '');
    const v6 = withoutScheme.match(/^\[([^\]]+)\](?::(\d+))?/);
    if (v6) {
      host = v6[1] ?? '';
      port = Number(v6[2] ?? port);
    } else {
      const m = withoutScheme.match(/^([^/:]+)(?::(\d+))?/);
      host = m?.[1] ?? '';
      port = Number(m?.[2] ?? port);
    }
  }

  if (!host) return null;
  if (!port) port = 22;
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

/** 对话式创建技能：多轮追问 + 自动做 TCP 连通性验证 */
app.post('/api/skills/coach', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  const raw = Array.isArray(b?.messages) ? b.messages : [];
  const turns: ChatTurn[] = raw
    .filter((m: any) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string')
    .slice(-40)
    .map((m: any) => ({ role: m.role, content: m.content.slice(0, 12000) }));

  if (!turns.length || turns[turns.length - 1]!.role !== 'user') {
    return c.json({ error: '需要一条用户消息' }, 400);
  }

  const picked = b?.modelId ? getModel(String(b.modelId)) : null;
  const cfg = toConfig(picked ?? getDefaultModel());
  if (!cfg || !cfg.baseUrl.trim() || !cfg.apiKey.trim()) {
    return c.json({ error: '还没有可用的模型，请先在设置里添加模型并填写 API Key' }, 400);
  }

  let reply = '';
  try {
    reply = await completeChat(cfg, [
      { role: 'system', content: SKILL_COACH_PROMPT },
      ...turns,
    ], { temperature: 0.35, maxTokens: 2600 });
  } catch (e) {
    return c.json({ error: String((e as Error).message ?? e) }, 502);
  }

  // 模型想看某个地址通不通，服务端代跑一次 TCP 测试
  let verification: Awaited<ReturnType<typeof probeTcp>> | null = null;
  const verifyBlock = reply.match(/```(?:verify|json:verify)\s*\r?\n([\s\S]*?)```/i);
  if (verifyBlock && b?.autoVerify !== false) {
    try {
      const endpoint = parseEndpoint(JSON.parse(verifyBlock[1]!));
      if (endpoint) verification = await probeTcp(endpoint.host, endpoint.port);
    } catch {
      /* 模型给的验证块不是合法 JSON，忽略即可 */
    }
  }

  return c.json({ data: { reply, verification } });
});

app.post('/api/skills/verify', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  const endpoint = parseEndpoint(b);
  if (!endpoint) return c.json({ ok: false, error: '地址或端口不合法' }, 400);
  const timeoutMs = Math.min(Math.max(Number(b?.timeoutMs ?? 5000), 1000), 15000);
  return c.json(await probeTcp(endpoint.host, endpoint.port, timeoutMs));
});

/** 用户确认草案后写入磁盘，并同步到 opencode 的技能目录 */
app.post('/api/skills', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  try {
    const data = createSkill({
      id: typeof b?.id === 'string' ? b.id : undefined,
      name: String(b?.name ?? ''),
      description: String(b?.description ?? ''),
      content: String(b?.content ?? ''),
      scope: b?.scope === 'project' ? 'project' : 'global',
      overwrite: b?.overwrite === true,
    });
    resetSkillInventory();
    return c.json({ data }, 201);
  } catch (e) {
    return c.json({ error: String((e as Error).message ?? e) }, 400);
  }
});

/** opencode 当前可用的技能：内置 + 本机 ~/.config/opencode/skills + 项目 .opencode/skills */
app.get('/api/skills', async (c) => {
  const model = getDefaultModel();
  const ok = await ensureOpencode(model ?? null).catch(() => false);
  if (!ok) {
    const status = getOpencodeStatus();
    return c.json({ data: [], error: status.error ?? 'opencode 不可用', status }, 503);
  }
  try {
    const data = await listSkills();
    return c.json({ data, status: getOpencodeStatus() });
  } catch (e) {
    return c.json({ data: [], error: String((e as Error).message ?? e), status: getOpencodeStatus() }, 500);
  }
});

/** 前端在审批卡片上点「允许一次 / 总是允许 / 拒绝」 */
app.post('/api/permissions/:requestID', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  const decision = b?.decision === 'once' || b?.decision === 'always' || b?.decision === 'reject' ? b.decision : 'reject';
  const ok = resolvePermission(c.req.param('requestID'), decision);
  return c.json({ ok });
});

/* ---------- 设置 / 运行时安装 / 知识库 ---------- */

app.get('/api/settings', (c) => {
  const s = getSettings();
  return c.json({ data: { ...s, opencodeUrl: s.opencodeUrl || DEFAULT_OPENCODE_URL } });
});

app.patch('/api/settings', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  saveSettings({
    baseUrl: typeof b?.baseUrl === 'string' ? b.baseUrl.trim() : undefined,
    apiKey: typeof b?.apiKey === 'string' ? b.apiKey.trim() : undefined,
    model: typeof b?.model === 'string' ? b.model.trim() : undefined,
    opencodeUrl: typeof b?.opencodeUrl === 'string' ? b.opencodeUrl.trim() : undefined,
    opencodeBin: typeof b?.opencodeBin === 'string' ? b.opencodeBin.trim() : undefined,
    ragflowBaseUrl: typeof b?.ragflowBaseUrl === 'string' ? b.ragflowBaseUrl.trim() : undefined,
    ragflowApiKey: typeof b?.ragflowApiKey === 'string' ? b.ragflowApiKey.trim() : undefined,
    ragflowEnabledKbs: Array.isArray(b?.ragflowEnabledKbs) ? b.ragflowEnabledKbs.map(String) : undefined,
    mattermostUrl: typeof b?.mattermostUrl === 'string' ? b.mattermostUrl.trim() : undefined,
    mattermostToken: typeof b?.mattermostToken === 'string' ? b.mattermostToken.trim() : undefined,
  });
  resetBinaryCache();
  return c.json({ data: getSettings() });
});

app.post('/api/opencode/install', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  const url = String(b?.url ?? '').trim() || getSettings().opencodeUrl || DEFAULT_OPENCODE_URL;
  const result = await installFromZip(url);
  if (result.ok) saveSettings({ opencodeUrl: url });
  return c.json({ ...result, status: getOpencodeStatus() }, result.ok ? 200 : 400);
});

app.get('/api/kb/status', async (c) => c.json({ data: await ragflowStatus() }));

app.get('/api/kb/datasets', async (c) => {
  try {
    return c.json({ data: await listDatasets(true) });
  } catch (e) {
    return c.json({ error: String((e as Error).message ?? e), data: [] }, 502);
  }
});

app.patch('/api/kb/enabled', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  const ids = Array.isArray(b?.ids) ? b.ids.map(String) : [];
  saveSettings({ ragflowEnabledKbs: ids });
  return c.json({ data: ids });
});

/* ---------- 真人 / 推送 ---------- */

/**
 * 真人在线状态：客户端每 30 秒打一次心跳，2 分钟没心跳就算离线。
 * 模拟真人（预置的李娜/王强）始终在线，用来演示拉群和 @ 拍板。
 */
const ONLINE_TTL = 120_000;
const humanSeen = new Map<string, number>();

function isHumanOnline(h: { id: string; simulated?: boolean }): boolean {
  if (h.simulated) return true;
  return (humanSeen.get(h.id) ?? 0) > Date.now() - ONLINE_TTL;
}

function markHumanOnline(id: string): void {
  const was = isHumanOnline({ id });
  humanSeen.set(id, Date.now());
  if (!was) {
    const h = getHuman(id);
    broadcast('presence', { humanId: id, name: h?.name ?? '', online: true });
  }
}

function humansWithPresence() {
  return listHumans().map((h) => ({ ...h, online: isHumanOnline(h) }));
}

/** 原型级登录：按名字建/找真人，不做密码校验；身份通过 x-sbot-user 头传递 */
app.post('/api/login', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  const name = String(b?.name ?? '').trim();
  if (!name) return c.json({ error: 'name required' }, 400);
  const human = upsertHuman({ name, role: String(b?.role ?? '') });
  markHumanOnline(human.id);
  return c.json({ data: { ...human, online: true } });
});

app.get('/api/humans', (c) => c.json({ data: humansWithPresence() }));

/* ---------- 局域网发现（飞秋式） ---------- */
app.get('/api/lan/peers', (c) => c.json({ data: getLanPeers(), self: getLanIdentity() }));

/** 供「手动添加同事」握手：对方通过 http://ip:port/api/lan/hello 确认身份 */
app.get('/api/lan/hello', (c) => c.json({ data: getLanIdentity() }));

app.post('/api/lan/identity', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  setLanIdentity({
    name: typeof b?.name === 'string' ? b.name : undefined,
    role: typeof b?.role === 'string' ? b.role : undefined,
    color: typeof b?.color === 'string' ? b.color : undefined,
    initial: typeof b?.initial === 'string' ? b.initial : undefined,
  });
  return c.json({ data: getLanIdentity() });
});

/**
 * 手动添加内网同事：广播/组播被内网屏蔽时，用户输入对方 IP:端口即可。
 * 先握手确认对方是 S-BOT，再注册进发现列表。
 */
app.post('/api/lan/peers', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  const host = String(b?.host ?? '').trim().replace(/^https?:\/\//, '').split('/')[0];
  const port = Number(b?.port ?? b?.port);
  if (!host || !Number.isFinite(port) || port <= 0) {
    return c.json({ error: '请填写对方 IP 和端口' }, 400);
  }
  const url = `http://${host}:${port}/api/lan/hello`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return c.json({ error: `对方返回 ${res.status}` }, 400);
    const body = (await res.json().catch(() => ({}))) as { data?: any };
    const self = body.data;
    if (!self?.id) return c.json({ error: '对方不是 S-BOT' }, 400);
    const peer = registerPeer({
      id: String(self.id),
      name: String(self.name ?? 'S-BOT 用户'),
      role: String(self.role ?? ''),
      color: String(self.color ?? '#5B8CFF'),
      initial: String(self.initial ?? ''),
      host,
      port,
      manual: true,
    });
    return c.json({ data: peer });
  } catch (e) {
    return c.json({ error: `连不上 ${host}:${port}（${String((e as Error).message ?? e).slice(0, 80)}）` }, 400);
  }
});

/* ---------- P2P 邀请 / 接受（局域网直连） ---------- */

interface P2PMemberCard {
  p2pId: string;
  kind: 'human' | 'agent';
  memberId: string;
  name: string;
  role: string;
  color: string;
  initial: string;
  skills?: string[];
}

interface P2PInvite {
  inviteId: string;
  groupId: string;
  title: string;
  token: string;
  summary: string;
  host: { id: string; name: string; host: string; port: number };
  members: P2PMemberCard[];
}

const p2pInvites = new Map<string, P2PInvite>();

function p2pOwnId(): string {
  return getLanIdentity().id;
}

function p2pRemoteAddress(c: any): string {
  try {
    const addr = c.env?.incoming?.socket?.remoteAddress ?? c.env?.remoteAddr ?? '';
    return String(addr).replace(/^::ffff:/, '');
  } catch {
    return '';
  }
}

async function p2pPost(host: string, port: number, path: string, body: unknown, token: string): Promise<void> {
  if (!host || !port) throw new Error('对方没有可连接的 P2P 端口');
  const res = await fetch(`http://${host}:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sbot-p2p': token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`对方 P2P 请求失败 ${res.status}${text ? `：${text.slice(0, 160)}` : ''}`);
  }
}

async function p2pSummary(conv: Conversation): Promise<string> {
  const context = joinContext(conv.id, 10)
    .map((m) => `${senderName(conv, m)}：${m.text}`)
    .join('\n')
    .slice(0, 2400);
  const fallback = [
    '📋 群聊上下文摘要',
    '',
    `群聊：${conv.title}`,
    '',
    '最近在讨论',
    ...(context
      ? context.split('\n').slice(-4).map((line) => `• ${line.slice(0, 100)}`)
      : ['• 群里还没有历史发言']),
    '',
    '你加入后可以直接接着聊，之前的完整记录不会同步。',
  ].join('\n');

  const cfg = toConfig(getDefaultModel());
  if (!cfg?.apiKey) return fallback;
  try {
    const reply = await completeChat(
      cfg,
      [
        {
          role: 'system',
          content: `你是群聊助理。用 250 字以内给刚加入的同事写一份带排版的上下文摘要：第一行「📋 群聊上下文摘要」，然后「最近在讨论」「已经对齐」「还需要确认」三段，用 • 列表，不要 Markdown 符号。群名：${conv.title}。`,
        },
        { role: 'user', content: context || '（还没有历史发言）' },
      ],
      { temperature: 0.35, maxTokens: 420 },
    );
    return reply.trim() || fallback;
  } catch {
    return fallback;
  }
}

function p2pMemberCards(conv: Conversation): P2PMemberCard[] {
  const own = p2pOwnId();
  return conv.members.map((m) => ({
    p2pId: `p_${own}_${m.memberId}`,
    kind: m.memberType,
    memberId: m.memberId,
    name: m.name,
    role: m.role,
    color: m.color,
    initial: m.initial,
    skills: m.memberType === 'agent' ? getAgent(m.memberId)?.skills ?? [] : undefined,
  }));
}

/** 群主邀请一个内网同事：生成群 ID/token、摘要，发到对方 P2P 端口 */
app.post('/api/p2p/invite', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  const conversationId = String(b?.conversationId ?? '');
  const peer = b?.peer as { id?: string; name?: string; host?: string; port?: number } | undefined;
  const conv = getConversation(conversationId);
  if (!conv || conv.type !== 'group') return c.json({ ok: false, error: '只能邀请到群聊' }, 400);
  if (!peer?.id || !peer.host || !peer.port) return c.json({ ok: false, error: '对方 P2P 地址不完整' }, 400);

  const own = getLanIdentity();
  let state = getP2PState(conv.id);
  if (!state) {
    state = {
      groupId: `pg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      hostId: own.id,
      token: Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2),
      peers: [],
    };
    setP2PState(conv.id, state);
  }
  if (state.hostId !== own.id) return c.json({ ok: false, error: '只有群主能邀请成员' }, 403);

  const summary = await p2pSummary(conv);
  const invite: P2PInvite = {
    inviteId: `inv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    groupId: state.groupId,
    title: conv.title,
    token: state.token,
    summary,
    host: { id: own.id, name: own.name, host: '', port: own.port },
    members: p2pMemberCards(conv),
  };

  try {
    await p2pPost(String(peer.host), Number(peer.port), '/api/p2p/receive-invite', { kind: 'invite', ...invite }, state.token);
    return c.json({ ok: true, groupId: state.groupId, summary });
  } catch (e) {
    return c.json({ ok: false, error: String((e as Error).message ?? e) }, 502);
  }
});

/** 收到邀请：先放内存，推给界面让用户接受 */
app.post('/api/p2p/receive-invite', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  if (b?.kind !== 'invite' || !b?.inviteId || !b?.groupId) return c.json({ ok: false, error: '邀请格式不对' }, 400);
  const hostAddress = p2pRemoteAddress(c) || String(b.host?.host ?? '');
  const invite: P2PInvite = {
    inviteId: String(b.inviteId),
    groupId: String(b.groupId),
    title: String(b.title ?? '内网群聊'),
    token: String(b.token ?? ''),
    summary: String(b.summary ?? ''),
    host: {
      id: String(b.host?.id ?? ''),
      name: String(b.host?.name ?? '内网同事'),
      host: hostAddress,
      port: Number(b.host?.port ?? 0),
    },
    members: Array.isArray(b.members) ? b.members : [],
  };
  p2pInvites.set(invite.inviteId, invite);
  broadcast('p2p.invite', {
    inviteId: invite.inviteId,
    groupId: invite.groupId,
    title: invite.title,
    hostName: invite.host.name,
    summary: invite.summary,
    memberCount: invite.members.length,
  });
  return c.json({ ok: true });
});

/** 接受邀请：本地建群、写影子成员与摘要，再回报群主 */
app.post('/api/p2p/invites/:inviteId/accept', async (c) => {
  const invite = p2pInvites.get(c.req.param('inviteId'));
  if (!invite) return c.json({ ok: false, error: '邀请已失效' }, 404);

  const b = await c.req.json().catch(() => ({} as any));
  const localName = String(b?.name ?? '内网同事').trim() || '内网同事';
  const localRole = String(b?.role ?? '');
  const localColor = String(b?.color ?? '#5B8CFF');
  const localInitial = String(b?.initial ?? localName.slice(0, 1));
  const self = upsertHuman({ name: localName, role: localRole });

  const memberIds: string[] = [self.id];
  for (const card of invite.members.slice(0, 6)) {
    if (!card?.p2pId || !card?.name) continue;
    if (card.kind === 'agent') {
      upsertP2PAgent({
        id: card.p2pId,
        name: card.name,
        role: card.role,
        color: card.color,
        initial: card.initial,
        skills: card.skills,
      });
    } else {
      upsertP2PHuman({
        id: card.p2pId,
        name: `${card.name}（内网）`,
        role: card.role,
        color: card.color,
        initial: card.initial,
      });
    }
    memberIds.push(card.p2pId);
  }

  if (memberIds.length < 2) return c.json({ ok: false, error: '邀请里没有可加入的成员' }, 400);
  const conv = createGroup(invite.title, memberIds.slice(0, 7));
  const own = getLanIdentity();
  setP2PState(conv.id, {
    groupId: invite.groupId,
    hostId: invite.host.id,
    token: invite.token,
    peers: [{
      id: invite.host.id,
      name: invite.host.name,
      host: invite.host.host,
      port: invite.host.port,
      token: invite.token,
    }],
  });

  const shadowAgent = conv.members.find((m) => m.memberType === 'agent');
  if (shadowAgent) {
    addMessage({
      conversationId: conv.id,
      authorType: 'agent',
      authorId: shadowAgent.memberId,
      role: 'assistant',
      text: invite.summary || '📋 群聊上下文摘要\n\n你已加入群聊，之前的完整记录不会同步。',
      parts: [{ type: 'context-summary' }],
    });
  }

  try {
    await p2pPost(
      invite.host.host,
      invite.host.port,
      '/api/p2p/accept',
      {
        kind: 'accept',
        groupId: invite.groupId,
        token: invite.token,
        peer: { id: own.id, name: localName, port: own.port },
        human: {
          p2pId: `p_${own.id}_${self.id}`,
          name: localName,
          role: localRole,
          color: localColor,
          initial: localInitial,
        },
      },
      invite.token,
    );
  } catch {
    /* 群主暂时不可达，本地群先建好 */
  }

  p2pInvites.delete(invite.inviteId);
  return c.json({ data: conv });
});

app.post('/api/p2p/invites/:inviteId/decline', (c) => {
  p2pInvites.delete(c.req.param('inviteId'));
  return c.json({ ok: true });
});

/** 群主收到接受：把新成员写成影子真人，记下 peer */
app.post('/api/p2p/accept', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  const conv = findConversationByP2PGroup(String(b?.groupId ?? ''));
  if (!conv) return c.json({ ok: false, error: '群不存在' }, 404);
  const state = getP2PState(conv.id);
  if (!state || state.token !== String(b?.token ?? '')) return c.json({ ok: false, error: '群 token 不匹配' }, 403);

  const human = b?.human as { p2pId?: string; name?: string; role?: string; color?: string; initial?: string } | undefined;
  if (human?.p2pId && human.name) {
    upsertP2PHuman({
      id: human.p2pId,
      name: human.name,
      role: human.role,
      color: human.color,
      initial: human.initial,
    });
    addMember(conv.id, human.p2pId, 'human');
    addMessage({
      conversationId: conv.id,
      authorType: 'system',
      authorId: null,
      role: 'system',
      text: `${human.name} 加入了群聊`,
    });
  }

  const peer = b?.peer as { id?: string; name?: string; port?: number } | undefined;
  if (peer?.id) {
    const host = p2pRemoteAddress(c);
    const peers = state.peers.filter((p) => p.id !== peer.id);
    peers.push({
      id: peer.id,
      name: String(peer.name ?? '内网同事'),
      host,
      port: Number(peer.port ?? 0),
      token: state.token,
    });
    setP2PState(conv.id, { peers });
  }
  return c.json({ ok: true });
});

/** 登录客户端的心跳；带上 x-sbot-user 或 { humanId } */
app.post('/api/presence', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  const id = String(c.req.header('x-sbot-user') ?? b?.humanId ?? '').trim();
  if (!id) return c.json({ ok: false, error: 'humanId required' }, 400);
  const h = getHuman(id);
  if (!h) return c.json({ ok: false, error: 'human not found' }, 404);
  markHumanOnline(id);
  return c.json({ ok: true, data: { id, online: true } });
});

/** 找同事：服务端合并 S-BOT 本地真人和 Mattermost 用户，按关键字搜索 */
app.get('/api/colleagues', async (c) => {
  const q = String(c.req.query('q') ?? '').trim();
  const lower = q.toLowerCase();
  const self = c.req.header('x-sbot-user') ?? '';

  const local = humansWithPresence()
    .filter((h) => h.id !== self)
    .filter((h) => !lower || h.name.toLowerCase().includes(lower) || h.role.toLowerCase().includes(lower))
    .map((h) => ({
      source: 'local' as const,
      id: h.id,
      name: h.name,
      role: h.role,
      online: h.online,
      status: h.online ? 'online' : 'offline',
      simulated: !!h.simulated,
      username: null as string | null,
      color: h.color,
      initial: h.initial,
    }))
    .sort((a, b) => Number(b.online) - Number(a.online));

  const mm = await getMattermostStatus();
  let external: Array<{
    source: 'mattermost';
    id: string;
    name: string;
    role: string;
    online: boolean;
    status: string;
    simulated: boolean;
    username: string;
    color: string | null;
    initial: string;
  }> = [];
  let mmError = mm.error;

  if (mm.ok && (q || mm.mock)) {
    try {
      external = (await searchMattermostUsers(q)).map((u) => ({
        source: 'mattermost' as const,
        id: u.id,
        name: u.name,
        role: u.role,
        online: u.online,
        status: u.status,
        simulated: false,
        username: u.username,
        color: null,
        initial: u.name.slice(0, 1),
      }));
    } catch (e) {
      mmError = String((e as Error).message ?? e);
    }
  }

  return c.json({
    data: [...local, ...external],
    meta: { mattermost: { ...mm, error: mmError }, query: q },
  });
});

app.get('/api/mattermost/status', async (c) => c.json({ data: await getMattermostStatus() }));

/** 查看模拟 Mattermost 发出的私信（联调用） */
app.get('/api/mattermost/mock/posts', (c) => c.json({ data: getMockMattermostPosts() }));

/** 邀请更多：通过 Mattermost 给指定账号发一条私信 */
app.post('/api/mattermost/invite', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  const username = String(b?.username ?? '').trim().replace(/^@/, '');
  if (!username) return c.json({ ok: false, error: '请填写 Mattermost 账号' }, 400);

  const uid = c.req.header('x-sbot-user') ?? '';
  const inviter = uid ? getHuman(uid)?.name : null;
  const message = String(b?.message ?? '').trim()
    || `${inviter ? `${inviter}邀请` : '邀请'}你来 S-BOT 一起协作，打开 S-BOT 就能看到会话。`;

  const result = await sendMattermostDm(username, message);
  return c.json(result, result.ok ? 200 : 400);
});

/** 所有客户端共享的事件流：新消息、任务、成员变化 */
app.get('/api/events', (c) => {
  return streamSSE(c, async (stream) => {
    const listener = (event: unknown) => {
      const e = event as { type: string };
      void stream.writeSSE({ event: e.type, data: JSON.stringify(event) });
    };
    bus.on('event', listener);
    await stream.writeSSE({ event: 'ready', data: '{}' });

    await new Promise<void>((resolve) => {
      const ping = setInterval(() => {
        void stream.writeSSE({ event: 'ping', data: '{}' });
      }, 15000);
      stream.onAbort(() => {
        clearInterval(ping);
        resolve();
      });
    });
    bus.off('event', listener);
  });
});

/* ---------- 模型 ---------- */

app.get('/api/models', (c) => c.json({ data: listModels() }));

app.post('/api/models', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  const name = String(b?.name ?? '').trim();
  const model = String(b?.model ?? '').trim();
  const baseUrl = String(b?.baseUrl ?? '').trim();
  if (!name || !model || !baseUrl) return c.json({ error: 'name, model, baseUrl required' }, 400);
  const created = createModel({
    name,
    model,
    baseUrl,
    apiKey: String(b?.apiKey ?? ''),
    tools: b?.tools !== false,
    stream: b?.stream !== false,
  });
  try { syncModelConfig(); } catch { /* 配置同步失败不影响模型本身 */ }
  return c.json({ data: created }, 201);
});

app.patch('/api/models/:id', async (c) => {
  const id = c.req.param('id');
  if (!getModel(id)) return c.json({ error: 'model not found' }, 404);
  const b = await c.req.json().catch(() => ({} as any));
  updateModel(id, {
    name: typeof b?.name === 'string' ? b.name.trim() : undefined,
    model: typeof b?.model === 'string' ? b.model.trim() : undefined,
    baseUrl: typeof b?.baseUrl === 'string' ? b.baseUrl.trim() : undefined,
    apiKey: typeof b?.apiKey === 'string' && b.apiKey.trim() ? b.apiKey.trim() : undefined,
    tools: typeof b?.tools === 'boolean' ? b.tools : undefined,
    stream: typeof b?.stream === 'boolean' ? b.stream : undefined,
  });
  try { syncModelConfig(); } catch { /* ignore */ }
  return c.json({ data: getModel(id) });
});

app.delete('/api/models/:id', (c) => {
  const id = c.req.param('id');
  if (!getModel(id)) return c.json({ error: 'model not found' }, 404);
  deleteModel(id);
  try { syncModelConfig(); } catch { /* ignore */ }
  return c.json({ ok: true });
});

app.post('/api/models/:id/default', (c) => {
  const id = c.req.param('id');
  if (!getModel(id)) return c.json({ error: 'model not found' }, 404);
  setDefaultModel(id);
  try { syncModelConfig(); } catch { /* ignore */ }
  return c.json({ ok: true });
});

/** 把 S-BOT 里的所有模型同步给 opencode sidecar */
app.post('/api/models/sync', (c) => {
  try {
    const r = syncModelConfig();
    return c.json({ ok: true, ...r });
  } catch (e) {
    return c.json({ ok: false, error: String((e as Error).message ?? e) }, 500);
  }
});

app.post('/api/models/:id/test', async (c) => {
  const m = getModel(c.req.param('id'));
  if (!m) return c.json({ error: 'model not found' }, 404);
  if (!m.baseUrl || !m.apiKey) return c.json({ ok: false, error: '这个模型还没填 API Key' });
  const started = Date.now();
  try {
    const res = await fetch(`${m.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${m.apiKey}` },
      body: JSON.stringify({ model: m.model, messages: [{ role: 'user', content: '回复 OK' }], max_tokens: 8 }),
    });
    return c.json({ ok: res.ok, status: res.status, ms: Date.now() - started });
  } catch (e) {
    return c.json({ ok: false, error: String(e) });
  }
});

/* ---------- 智能体 ---------- */

app.get('/api/agents', (c) => {
  const user = c.req.header('x-sbot-user') ?? '';
  const all = listAgents();
  return c.json({
    data: all.filter((a) => a.visibility !== 'private' || !a.ownerId || a.ownerId === user),
  });
});

const AGENT_COACH_PROMPT = `你是 S-BOT 的智能体教练，帮用户设计一个 AI 同事。用中文多轮对话，先弄清：
1. 这个智能体负责什么工作、给谁用
2. 它的性格和说话风格（直接、严格、温和、简洁……）
3. 边界：只做什么、不做什么
4. 3~5 个擅长标签

工作方式：
- 每次最多问 2~3 个关键问题，不要一次列一长串清单，也不要编造用户没提供的信息。
- 信息足够时，输出一个完整草案。草案必须放在一个 \`\`\`agent 代码块里，内容必须是合法 JSON：
\`\`\`agent
{"name":"老周","role":"产品经理","description":"只谈用户价值、场景和优先级","skills":["需求拆解","优先级排序","用户价值判断"],"systemPrompt":"你是老周，产品经理。只谈用户价值、场景和优先级，不写代码。说话简短口语化，一次不超过 120 字。","color":"#5B8CFF"}
\`\`\`
- systemPrompt 写成第二人称「你是……」，明确角色、只谈什么、说话风格、不要做什么，控制在 120 字以内。
- color 只能从这些里选：#5B8CFF、#3DDC97、#F5A524、#C77DFF、#FF7A9C、#37C3D6、#A0E85C、#FF9F5A。
- 输出草案后，用一句话请用户确认；确认后设定会填入表单，由用户自己创建，不要声称已经创建或会直接替用户创建。
- 普通回复保持简洁，不要重复整份 JSON，除非用户要求修改。

当前环境：${process.platform}。`;

function parseAgentDraft(reply: string): {
  name: string;
  role: string;
  description: string;
  skills: string[];
  systemPrompt: string;
  color: string;
} | null {
  const block = reply.match(/```(?:agent|json:agent)\s*\r?\n([\s\S]*?)```/i);
  if (!block) return null;
  try {
    const raw = JSON.parse(block[1]!.trim()) as Record<string, unknown>;
    const name = String(raw.name ?? '').trim();
    const role = String(raw.role ?? '').trim();
    if (!name || !role) return null;
    const skills = Array.isArray(raw.skills)
      ? raw.skills.map((s) => String(s).trim()).filter(Boolean).slice(0, 6)
      : String(raw.skills ?? '').split(/[,，]/).map((s) => s.trim()).filter(Boolean).slice(0, 6);
    const palette = ['#5B8CFF', '#3DDC97', '#F5A524', '#C77DFF', '#FF7A9C', '#37C3D6', '#A0E85C', '#FF9F5A'];
    const color = palette.includes(String(raw.color)) ? String(raw.color) : palette[0]!;
    return {
      name,
      role,
      description: String(raw.description ?? '').trim().slice(0, 200),
      skills,
      systemPrompt: String(raw.systemPrompt ?? '').trim().slice(0, 1200),
      color,
    };
  } catch {
    return null;
  }
}

/** 对话式创建智能体：多轮对话，信息够了返回结构化草案 */
app.post('/api/agents/coach', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  const raw = Array.isArray(b?.messages) ? b.messages : [];
  const turns: ChatTurn[] = raw
    .filter((m: any) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string')
    .slice(-40)
    .map((m: any) => ({ role: m.role, content: m.content.slice(0, 8000) }));

  if (!turns.length || turns[turns.length - 1]!.role !== 'user') {
    return c.json({ error: '需要一条用户消息' }, 400);
  }

  const cfg = toConfig(getDefaultModel());
  if (!cfg || !cfg.baseUrl.trim() || !cfg.apiKey.trim()) {
    return c.json({ error: '还没有可用的模型，请先在设置里添加模型并填写 API Key' }, 400);
  }

  try {
    const reply = await completeChat(cfg, [
      { role: 'system', content: AGENT_COACH_PROMPT },
      ...turns,
    ], { temperature: 0.55, maxTokens: 1800 });
    return c.json({ data: { reply, draft: parseAgentDraft(reply) } });
  } catch (e) {
    return c.json({ error: String((e as Error).message ?? e) }, 502);
  }
});

app.post('/api/agents', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  const name = String(b?.name ?? '').trim();
  const role = String(b?.role ?? '').trim();
  if (!name || !role) return c.json({ error: 'name and role required' }, 400);

  const agent = createAgent({
    name,
    role,
    color: String(b?.color ?? '#5B8CFF'),
    initial: name.slice(0, 1),
    systemPrompt: String(b?.systemPrompt ?? ''),
    description: String(b?.description ?? ''),
    visibility: b?.visibility === 'private' ? 'private' : 'team',
    tools: typeof b?.tools === 'object' && b.tools ? b.tools : {},
    modelId: b?.modelId ? String(b.modelId) : null,
    skills: Array.isArray(b?.skills)
      ? b.skills.map((s: unknown) => String(s))
      : String(b?.skills ?? '')
          .split(/[,，]/)
          .map((s) => s.trim())
          .filter(Boolean),
    kbIds: Array.isArray(b?.kbIds) ? b.kbIds.map((s: unknown) => String(s)) : [],
    ownerId: c.req.header('x-sbot-user') || null,
  });
  return c.json({ data: agent }, 201);
});

app.patch('/api/agents/:id', async (c) => {
  const id = c.req.param('id');
  if (!getAgent(id)) return c.json({ error: 'agent not found' }, 404);
  const b = await c.req.json().catch(() => ({} as any));
  updateAgent(id, {
    name: typeof b?.name === 'string' ? b.name.trim() : undefined,
    role: typeof b?.role === 'string' ? b.role.trim() : undefined,
    color: typeof b?.color === 'string' ? b.color : undefined,
    initial: typeof b?.name === 'string' ? b.name.trim().slice(0, 1) : undefined,
    systemPrompt: typeof b?.systemPrompt === 'string' ? b.systemPrompt : undefined,
    description: typeof b?.description === 'string' ? b.description : undefined,
    visibility: b?.visibility === 'private' ? 'private' : b?.visibility === 'team' ? 'team' : undefined,
    tools: typeof b?.tools === 'object' && b.tools ? b.tools : undefined,
    modelId: b?.modelId === null ? null : typeof b?.modelId === 'string' ? b.modelId : undefined,
    skills: Array.isArray(b?.skills) ? b.skills.map((s: unknown) => String(s)) : undefined,
    kbIds: Array.isArray(b?.kbIds) ? b.kbIds.map((s: unknown) => String(s)) : undefined,
  });
  return c.json({ data: getAgent(id) });
});

app.delete('/api/agents/:id', (c) => {
  const id = c.req.param('id');
  if (!getAgent(id)) return c.json({ error: 'agent not found' }, 404);
  deleteAgent(id);
  return c.json({ ok: true });
});

/* ---------- 任务 ---------- */

app.get('/api/tasks', (c) => c.json({ data: listTasks() }));

app.post('/api/tasks', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  const title = String(b?.title ?? '').trim();
  if (!title) return c.json({ error: 'title required' }, 400);
  const task = createTask({
    title,
    description: String(b?.description ?? ''),
    conversationId: b?.conversationId ? String(b.conversationId) : null,
    creatorName: String(b?.creatorName ?? '我'),
    priority: ['high', 'mid', 'low'].includes(b?.priority) ? b.priority : 'mid',
  });
  broadcast('task', task, task.conversationId ?? undefined);
  return c.json({ data: task }, 201);
});

app.patch('/api/tasks/:id', async (c) => {
  const id = c.req.param('id');
  if (!getTask(id)) return c.json({ error: 'task not found' }, 404);
  const b = await c.req.json().catch(() => ({} as any));
  updateTask(id, {
    title: typeof b?.title === 'string' ? b.title.trim() : undefined,
    description: typeof b?.description === 'string' ? b.description : undefined,
    conversationId: b?.conversationId === null ? null : typeof b?.conversationId === 'string' ? b.conversationId : undefined,
    priority: ['high', 'mid', 'low'].includes(b?.priority) ? b.priority : undefined,
    status: ['todo', 'awaiting', 'done'].includes(b?.status) ? b.status : undefined,
  });
  const task = getTask(id);
  broadcast('task', task, task?.conversationId ?? undefined);
  return c.json({ data: task });
});

app.delete('/api/tasks/:id', (c) => {
  const id = c.req.param('id');
  if (!getTask(id)) return c.json({ error: 'task not found' }, 404);
  deleteTask(id);
  return c.json({ ok: true });
});

/* ---------- 会话 ---------- */

app.get('/api/conversations', (c) => c.json({ data: listConversations() }));

app.post('/api/conversations', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  const title = String(b?.title ?? '').trim();
  const memberIds = Array.isArray(b?.memberIds) ? b.memberIds.map((s: unknown) => String(s)) : [];
  if (!title || memberIds.length < 2) return c.json({ error: 'title and at least 2 members required' }, 400);
  const conv = createGroup(title, memberIds);
  // 新建群：自动生成聊天逻辑图（前端可以传自己改过的）
  const graph = b?.workflow && Array.isArray(b.workflow.nodes)
    ? b.workflow
    : generateWorkflow({ memberIds, title, withHuman: true });
  const checked = validateWorkflow(graph);
  if (checked.ok) saveWorkflow(conv.id, graph);
  return c.json({ data: conv, workflow: checked.ok ? getWorkflow(conv.id) : null, workflowErrors: checked.errors }, 201);
});

app.post('/api/conversations/dm', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  const humanId = String(b?.humanId ?? '');
  if (humanId) {
    if (!getHuman(humanId)) return c.json({ error: 'human not found' }, 404);
    return c.json({ data: ensureHumanDm(humanId) });
  }
  const agentId = String(b?.agentId ?? '');
  if (!getAgent(agentId)) return c.json({ error: 'agent not found' }, 404);
  return c.json({ data: ensureDm(agentId) });
});

app.get('/api/conversations/:id', (c) => {
  const conv = getConversation(c.req.param('id'));
  if (!conv) return c.json({ error: 'conversation not found' }, 404);
  return c.json({ data: conv });
});

app.patch('/api/conversations/:id', async (c) => {
  const id = c.req.param('id');
  if (!getConversation(id)) return c.json({ error: 'conversation not found' }, 404);
  const b = await c.req.json().catch(() => ({} as any));
  updateConversation(id, {
    title: typeof b?.title === 'string' ? b.title.trim() : undefined,
    pinned: typeof b?.pinned === 'boolean' ? b.pinned : undefined,
    muted: typeof b?.muted === 'boolean' ? b.muted : undefined,
    modelId: b?.modelId === null ? null : typeof b?.modelId === 'string' ? b.modelId : undefined,
    autoReply: typeof b?.autoReply === 'boolean' ? b.autoReply : undefined,
    supModel: b?.supModel === null ? null : typeof b?.supModel === 'string' ? b.supModel : undefined,
    maxTurns: typeof b?.maxTurns === 'number' ? b.maxTurns : undefined,
  });
  return c.json({ data: getConversation(id) });
});

app.delete('/api/conversations/:id', (c) => {
  const id = c.req.param('id');
  if (!getConversation(id)) return c.json({ error: 'conversation not found' }, 404);
  deleteConversation(id);
  clearAgentSessions(id);
  deleteWorkflow(id);
  return c.json({ ok: true });
});

app.post('/api/conversations/:id/members', async (c) => {
  const id = c.req.param('id');
  const conv = getConversation(id);
  if (!conv) return c.json({ error: 'conversation not found' }, 404);

  const b = await c.req.json().catch(() => ({} as any));
  const agentId = String(b?.agentId ?? '');
  const agent = getAgent(agentId);
  if (!agent) return c.json({ error: 'agent not found' }, 404);
  const user = c.req.header('x-sbot-user') ?? '';
  if (agent.visibility === 'private' && agent.ownerId && agent.ownerId !== user) {
    return c.json({ error: '这是别人创建的智能体，只有创建者能拉进群' }, 403);
  }
  if (conv.members.some((m) => m.memberId === agentId)) return c.json({ data: conv });
  if (conv.type === 'group' && conv.members.filter((m) => m.memberType === 'agent').length >= 6) {
    return c.json({ error: '群聊最多 6 个智能体' }, 400);
  }

  addMember(id, agentId);
  addMessage({
    conversationId: id,
    authorType: 'system',
    authorId: null,
    role: 'system',
    text: `${agent.name} 加入了群聊`,
  });
  void sendJoinEvent(id, 'agent', agentId);
  return c.json({ data: getConversation(id) });
});

app.post('/api/conversations/:id/humans', async (c) => {
  const id = c.req.param('id');
  const conv = getConversation(id);
  if (!conv) return c.json({ error: 'conversation not found' }, 404);

  const b = await c.req.json().catch(() => ({} as any));
  const name = String(b?.name ?? '').trim();
  if (!name) return c.json({ error: 'name required' }, 400);
  const human = upsertHuman({ name, role: String(b?.role ?? '') });
  if (conv.members.some((m) => m.memberId === human.id)) return c.json({ data: conv });

  addMember(id, human.id, 'human');
  addMessage({
    conversationId: id,
    authorType: 'system',
    authorId: null,
    role: 'system',
    text: `${human.name} 加入了群聊`,
  });
  void sendJoinEvent(id, 'human', human.id);
  return c.json({ data: getConversation(id) });
});

app.get('/api/conversations/:id/workflow', (c) => {
  const id = c.req.param('id');
  if (!getConversation(id)) return c.json({ error: 'conversation not found' }, 404);
  return c.json({ data: getWorkflow(id) });
});

app.put('/api/conversations/:id/workflow', async (c) => {
  const id = c.req.param('id');
  const conv = getConversation(id);
  if (!conv) return c.json({ error: 'conversation not found' }, 404);
  const b = await c.req.json().catch(() => ({} as any));
  const graph = b?.graph ?? b;
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return c.json({ error: 'invalid workflow' }, 400);
  }
  const checked = validateWorkflow(graph);
  if (!checked.ok) return c.json({ error: checked.errors.join('；'), errors: checked.errors }, 400);
  const memberIds = new Set(conv.members.filter((m) => m.memberType === 'agent').map((m) => m.memberId));
  const outsider = graph.nodes.find((n: any) => n.type === 'agent' && n.agentId && !memberIds.has(n.agentId));
  if (outsider) return c.json({ error: `节点「${outsider.label}」绑定的智能体不在这个群里` }, 400);
  return c.json({ data: saveWorkflow(id, graph) });
});

app.post('/api/conversations/:id/workflow/generate', (c) => {
  const id = c.req.param('id');
  const conv = getConversation(id);
  if (!conv) return c.json({ error: 'conversation not found' }, 404);
  const graph = generateWorkflow({
    memberIds: conv.members.filter((m) => m.memberType === 'agent').map((m) => m.memberId),
    title: conv.title,
    withHuman: true,
  });
  return c.json({ data: saveWorkflow(id, graph) });
});

app.post('/api/workflows/preview', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  const memberIds = Array.isArray(b?.memberIds) ? b.memberIds.map((x: unknown) => String(x)) : [];
  if (!memberIds.length) return c.json({ error: 'memberIds required' }, 400);
  const graph = generateWorkflow({
    memberIds,
    title: String(b?.title ?? ''),
    withHuman: b?.withHuman !== false,
  });
  return c.json({ data: graph });
});

app.post('/api/workflows/coach', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  const agentIds = (Array.isArray(b?.agentIds) ? b.agentIds : Array.isArray(b?.memberIds) ? b.memberIds : [])
    .map((x: unknown) => String(x));
  const hintIds = Array.isArray(b?.memberIds) ? b.memberIds.map((x: unknown) => String(x)) : [];
  const agents = agentIds.map((id: string) => getAgent(id)).filter(Boolean) as Array<NonNullable<ReturnType<typeof getAgent>>>;
  if (!agents.length) return c.json({ error: 'agentIds required' }, 400);
  const text = String(b?.text ?? '').trim();
  if (!text) return c.json({ error: 'text required' }, 400);
  const history = Array.isArray(b?.messages)
    ? b.messages
        .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-10)
        .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 2000) }))
    : [];

  const fallback = () => ({
    status: 'ready' as const,
    reply: '没配置模型，我先按角色生成一版聊天逻辑，你可以再看图调整。',
    graph: generateWorkflow({ memberIds: hintIds.length ? hintIds : agentIds, withHuman: true }),
    memberIds: hintIds.length ? hintIds : agentIds,
  });

  const cfg = toConfig(getDefaultModel());
  if (!cfg?.apiKey) return c.json({ data: fallback() });

  const roster = agents
    .map((a) => `- ${a.id} / ${a.name} / ${a.role}${a.skills?.length ? ` / 擅长：${a.skills.join('、')}` : ''}`)
    .join('\n');
  const hintNames = hintIds
    .map((id: string) => agents.find((a) => a.id === id)?.name)
    .filter(Boolean)
    .join('、');

  const system = [
    '你是 S-BOT 的群聊流程设计师，负责把用户用自然语言描述的聊天流程变成一张可执行的流程图。',
    '',
    '可用智能体（只能使用这些 id）：',
    roster,
    hintNames ? `\n用户已经勾选的智能体（可参考，也可以按需求增删）：${hintNames}` : '',
    '',
    '图结构：',
    '{"nodes":[{"id":"start","type":"start","label":"开始"},{"id":"a1","type":"agent","label":"出方案","agentId":"上面的id","prompt":"这一步要做什么","producesVerdict":false},{"id":"h1","type":"human","label":"真人确认"},{"id":"end","type":"end","label":"结束"}],"edges":[{"id":"e1","from":"start","to":"a1","when":"always"},{"id":"e2","from":"a1","to":"h1","when":"pass"}],"maxLoops":3}',
    '',
    '规则：',
    '1. 必须有一个 start 和一个 end，所有节点从 start 可达。',
    '2. 智能体节点必须绑定上面列表里的 agentId。',
    '3. 评审节点把 producesVerdict 设为 true；走 pass / changes 两条边；修订回路的边加 maxLoops: 2。',
    '4. 除非用户明确说不要，最后加一个 human 真人确认节点。',
    '5. 如果用户要求评审不通过要修订，必须单独加一个 agent 修订节点，并加 review→revise（when=changes）和 revise→review（when=always, maxLoops=2）两条边。',
    '6. 不要发明智能体，不要用群外的 id。',
    '7. 如果用户没有指定成员，根据需求从列表里推荐最合适的成员；ready 时除了 graph，还要输出 memberIds（这些成员用到的 id 数组）。',
    '',
    '对话规则：',
    '- 信息不足（谁先做、要不要评审、改几轮、要不要真人确认、要哪些成员）时，只问一个最关键的问题，status 用 question。',
    '- 信息够了，先用一句话复述你的理解（包括你选了哪些成员），并问用户是否确认，status 用 question，reply 里要出现「确认」。',
    '- 只有用户明确确认后，才输出 status=ready、graph 和 memberIds。',
    '',
    '只输出 JSON，格式：{"status":"question" 或 "ready","reply":"给用户看的话","graph":{...},"memberIds":["id"]}。status 为 question 时不要输出 graph 和 memberIds。',
  ].join('\n');

  try {
    const reply = await completeChat(
      cfg,
      [{ role: 'system', content: system }, ...history, { role: 'user', content: text }],
      { temperature: 0.2, maxTokens: 1400 },
    );
    const raw = reply.match(/\{[\s\S]*\}/);
    const json = raw ? JSON.parse(raw[0]) : null;
    if (!json || (json.status !== 'question' && json.status !== 'ready')) {
      return c.json({ data: { status: 'question', reply: reply.slice(0, 500) || '能再说一下你希望的顺序吗？' } });
    }

    const hasAssistant = history.some((m: any) => m.role === 'assistant');
    if (json.status === 'ready' && !hasAssistant) {
      return c.json({
        data: {
          status: 'question',
          reply: `${String(json.reply ?? '').trim() || '我按你的描述整理了一版流程。'} 你确认按这个生成流程图吗？`,
        },
      });
    }

    if (json.status === 'ready' && json.graph) {
      const graph = json.graph;
      const checked = validateWorkflow(graph);
      const memberSet = new Set(agents.map((a) => a.id));
      const bad = Array.isArray(graph.nodes)
        ? graph.nodes.find((n: any) => n.type === 'agent' && (!n.agentId || !memberSet.has(n.agentId)))
        : true;

      const usedIds = Array.isArray(json.memberIds)
        ? json.memberIds.map((x: unknown) => String(x)).filter((id: string) => memberSet.has(id))
        : [];
      const finalIds = usedIds.length
        ? usedIds
        : Array.from(new Set((graph.nodes ?? []).filter((n: any) => n.type === 'agent').map((n: any) => n.agentId))).filter(Boolean);

      if (checked.ok && !bad) {
        return c.json({
          data: { status: 'ready', reply: String(json.reply ?? '已生成，打开流程图确认。'), graph, memberIds: finalIds },
        });
      }
      // 图不合法：退回一版确定性的，避免卡住
      const fb = generateWorkflow({ memberIds: hintIds.length ? hintIds : agentIds, withHuman: true });
      return c.json({
        data: {
          status: 'ready',
          reply: '模型生成的图有点问题，我先按角色生成一版，你在画布上再调。',
          graph: fb,
          memberIds: hintIds.length ? hintIds : agentIds,
        },
      });
    }

    return c.json({ data: { status: 'question', reply: String(json.reply ?? '再说一下你希望的流程？') } });
  } catch (e) {
    return c.json({ data: { status: 'question', reply: `我这边没理解好：${String((e as Error).message ?? e).slice(0, 120)}。能再说一下顺序吗？` } });
  }
});

app.post('/api/workflow/runs/:runId/approve', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  const nodeId = String(b?.nodeId ?? '');
  const decision = ['pass', 'changes', 'reject'].includes(b?.decision) ? b.decision : 'pass';
  const ok = resolveWorkflowApproval(
    c.req.param('runId'),
    nodeId,
    decision === 'changes' || decision === 'reject' ? 'changes' : 'pass',
  );
  return c.json({ ok });
});

app.patch('/api/conversations/:id/members/:agentId', async (c) => {
  const id = c.req.param('id');
  const agentId = c.req.param('agentId');
  if (!getConversation(id)) return c.json({ error: 'conversation not found' }, 404);
  const b = await c.req.json().catch(() => ({} as any));
  updateMember(id, agentId, {
    muted: typeof b?.muted === 'boolean' ? b.muted : undefined,
    talk: typeof b?.talk === 'string' ? b.talk : undefined,
  });
  return c.json({ data: getConversation(id) });
});

app.delete('/api/conversations/:id/members/:agentId', (c) => {
  const id = c.req.param('id');
  const agentId = c.req.param('agentId');
  const conv = getConversation(id);
  if (!conv) return c.json({ error: 'conversation not found' }, 404);

  const agent = getAgent(agentId);
  const human = getHuman(agentId);
  removeMember(id, agentId);
  addMessage({
    conversationId: id,
    authorType: 'system',
    authorId: null,
    role: 'system',
    text: `${agent?.name ?? human?.name ?? '成员'} 被移出群聊`,
  });
  return c.json({ data: getConversation(id) });
});

app.get('/api/conversations/:id/messages', (c) => {
  const id = c.req.param('id');
  if (!getConversation(id)) return c.json({ error: 'conversation not found' }, 404);
  return c.json({ data: listMessages(id, Number(c.req.query('limit') ?? 200)) });
});

/* ---------- 开场白 ---------- */

const introCache = new Map<string, { sig: string; at: number; data: ChatIntro }>();

function fallbackQuestions(conv: Conversation): string[] {
  if (conv.type === 'dm') {
    const m = conv.members[0];
    const a = m ? getAgent(m.memberId) : null;
    if (m && !a) {
      return [`${m.name}，在吗？`, '这周有空一起过一下方案吗？', '有个事想听听你的意见'];
    }
    const skill = a?.skills?.[0] ?? a?.role ?? '这件事';
    return [
      `${a?.name ?? '你'}，帮我${skill}这件事`,
      '这事你会先从哪里下手？',
      '有什么坑要提前避开？',
    ];
  }
  return ['一起评审一下这周的方案', '各自说一个最大的风险', '给一个能落地的下一步'];
}

function buildGreeting(conv: Conversation): string {
  if (conv.type === 'dm') {
    const m = conv.members[0];
    const a = m ? getAgent(m.memberId) : null;
    if (m && !a) {
      return `这是你和${m.name}${m.role ? `（${m.role}）` : ''}的私聊。直接说事就行。`;
    }
    const name = a?.name ?? m?.name ?? '我';
    const role = a?.role ?? m?.role ?? '';
    const skills = (a?.skills ?? []).slice(0, 3);
    const desc = (a?.description ?? '').trim().replace(/[。.]$/, '');
    const cap = desc || (skills.length ? `我能帮你${skills.join('、')}` : '我可以帮你一起把事推进');
    return `Hi，我是${name}${role ? `，${role}` : ''}。${cap}。有问题直接问我就行。`;
  }
  const names = conv.members.map((m) => `${m.name}（${m.role}）`).join('、');
  const skills = [...new Set(
    conv.members.flatMap((m) => (getAgent(m.memberId)?.skills ?? []).slice(0, 1)),
  )].slice(0, 4);
  const cap = skills.length ? `擅长${skills.join('、')}` : '能一起拆问题、给方案';
  return `Hi，我们是「${conv.title}」：${names}。${cap}。把一个具体目标丢进来，我们分头推进。`;
}

async function generateIntroQuestions(
  conv: Conversation,
  model: ReturnType<typeof getDefaultModel>,
): Promise<string[]> {
  const fallback = fallbackQuestions(conv);
  if (!model?.baseUrl || !model.apiKey) return fallback;

  const dmHuman = conv.type === 'dm' && !!conv.members[0] && !getAgent(conv.members[0]!.memberId);
  const who =
    conv.type === 'dm'
      ? (() => {
          const m = conv.members[0];
          const a = m ? getAgent(m.memberId) : null;
          const skills = (a?.skills ?? []).slice(0, 3).map((s) => `，擅长${s}`).join('');
          return a
            ? `${a.name}（${a.role}${skills}）`
            : `${m?.name ?? '同事'}（${m?.role ?? '同事'}，真人同事）`;
        })()
      : `群聊「${conv.title}」，成员：${conv.members.map((m) => `${m.name}（${m.role}）`).join('、')}`;

  try {
    const res = await fetch(`${model.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${model.apiKey}` },
      body: JSON.stringify({
        model: model.model,
        temperature: 0.7,
        max_tokens: 220,
        messages: [
          {
            role: 'system',
            content:
              '你在为多智能体协作应用写开场推荐问题。站在用户角度，具体、口语、不要客套，每条不超过 18 个字。只输出 JSON 数组，例如 ["...","...","..."]。',
          },
          {
            role: 'user',
            content: `用户第一次${conv.type === 'dm' ? (dmHuman ? '和这个真人同事单聊' : '和这个智能体单聊') : '进入这个群聊'}：${who}。生成 3 条用户最可能发的问题或任务。`,
          },
        ],
      }),
    });
    const json: any = await res.json();
    const content = String(json?.choices?.[0]?.message?.content ?? '').trim();
    const match = content.match(/\[[\s\S]*\]/);
    const arr = JSON.parse(match ? match[0] : content);
    if (Array.isArray(arr)) {
      const qs = arr
        .filter((x) => typeof x === 'string')
        .map((x) => String(x).trim().slice(0, 40))
        .filter(Boolean)
        .slice(0, 3);
      if (qs.length) return qs;
    }
  } catch {
    /* 模型不可用就用兜底问题 */
  }
  return fallback;
}

app.get('/api/conversations/:id/intro', async (c) => {
  const id = c.req.param('id');
  const conv = getConversation(id);
  if (!conv) return c.json({ error: 'conversation not found' }, 404);

  const sig = `${conv.type}|${conv.title}|${conv.members.map((m) => m.memberId).join(',')}`;
  const hit = introCache.get(id);
  if (hit && hit.sig === sig && Date.now() - hit.at < 30 * 60 * 1000) {
    return c.json({ data: hit.data });
  }

  const questions = await generateIntroQuestions(conv, getDefaultModel());
  const data: ChatIntro = {
    kind: conv.type === 'dm' ? 'dm' : 'group',
    title: conv.title,
    greeting: buildGreeting(conv),
    suggestions: questions,
  };
  introCache.set(id, { sig, at: Date.now(), data });
  return c.json({ data });
});

/* ---------- 交接：导出 / 导入 ---------- */

app.get('/api/conversations/:id/export', (c) => {
  const id = c.req.param('id');
  const conv = getConversation(id);
  if (!conv) return c.json({ error: 'conversation not found' }, 404);

  const messages = listMessages(id, 5000)
    // 系统提示（建群、成员变动）不带上下文价值，不导出
    .filter((m) => m.authorType !== 'system')
    .map((m) => {
      const person = conv.members.find((x) => x.memberId === m.authorId);
      return {
        authorType: m.authorType,
        authorName: person?.name ?? m.authorName ?? (m.authorType === 'user' ? '我' : null),
        authorColor: person?.color ?? m.authorColor ?? null,
        authorInitial: person?.initial ?? m.authorInitial ?? null,
        role: m.role,
        text: m.text,
        // 任务确认卡片引用的是旧群的任务 id，导出时去掉
        parts: Array.isArray(m.parts)
          ? m.parts.filter((p) => (p as { type?: string })?.type !== 'task-confirm')
          : [],
        status: m.status,
        createdAt: m.createdAt,
      };
    });

  const tasks = tasksForConversation(id).map((t) => ({
    title: t.title,
    description: t.description,
    priority: t.priority,
    status: t.status,
    creatorName: t.creatorName,
    createdAt: t.createdAt,
  }));

  return c.json({
    data: {
      kind: 's-bot-handoff',
      version: 1,
      exportedAt: Date.now(),
      conversation: {
        title: conv.title,
        type: conv.type,
        members: conv.members.map((m) => ({ name: m.name, role: m.role, color: m.color, initial: m.initial })),
      },
      messages,
      tasks,
    },
  });
});

app.post('/api/conversations/:id/import', async (c) => {
  const id = c.req.param('id');
  const conv = getConversation(id);
  if (!conv) return c.json({ error: 'conversation not found' }, 404);

  const pkg = await c.req.json().catch(() => null as any);
  if (!pkg || pkg.kind !== 's-bot-handoff' || !Array.isArray(pkg.messages)) {
    return c.json({ error: '不是有效的交接文件' }, 400);
  }

  const sourceTitle = String(pkg.conversation?.title ?? '另一个群聊');
  const incoming = pkg.messages
    .filter((m: any) => m && typeof m.text === 'string' && m.text.trim())
    .slice(0, 5000);

  let importedMessages = 0;
  for (const m of incoming) {
    addMessage({
      conversationId: id,
      authorType: m.authorType === 'user' ? 'user' : 'agent',
      authorId: null,
      authorName: m.authorName ? String(m.authorName) : null,
      authorColor: m.authorColor ? String(m.authorColor) : null,
      authorInitial: m.authorInitial ? String(m.authorInitial) : null,
      role: m.role === 'user' ? 'user' : 'assistant',
      text: String(m.text),
      parts: Array.isArray(m.parts) ? m.parts : [],
      status: 'done',
      createdAt: Number(m.createdAt) || Date.now(),
    });
    importedMessages++;
  }

  const allTasks = listTasks();
  const importedTitles = new Set<string>();
  let importedTasks = 0;
  for (const t of Array.isArray(pkg.tasks) ? pkg.tasks : []) {
    const title = String(t?.title ?? '').trim();
    if (!title || importedTitles.has(title)) continue;

    // 同名任务视为「接手」：从原来的群摘过来，而不是复制一份
    const same = allTasks.find((x) => x.title === title);
    if (same) {
      if (same.status !== 'done' && same.conversationId !== id) {
        updateTask(same.id, { conversationId: id, status: 'todo' });
        importedTasks++;
      }
      importedTitles.add(title);
      continue;
    }

    const task = createTask({
      title,
      description: String(t?.description ?? ''),
      conversationId: id,
      creatorName: String(t?.creatorName ?? '我'),
      priority: ['high', 'mid', 'low'].includes(t?.priority) ? t.priority : 'mid',
    });
    // 旧群里已完成的保持完成；未完成 / 待确认的重新变成待办
    if (t?.status === 'done') updateTask(task.id, { status: 'done' });
    importedTitles.add(title);
    importedTasks++;
  }

  addMessage({
    conversationId: id,
    authorType: 'system',
    authorId: null,
    role: 'system',
    text: `已从「${sourceTitle}」导入 ${importedMessages} 条聊天记录${importedTasks ? `、${importedTasks} 个任务` : ''}`,
  });

  return c.json({ data: { importedMessages, importedTasks } });
});

/* ---------- 发言 ---------- */

/** 群聊第一个议题：让模型判断它是不是一个任务，并绑定到群里 */
async function inferTaskFromTopic(
  conversationId: string,
  text: string,
  creatorName: string,
): Promise<ReturnType<typeof createTask> | null> {
  const trimmed = text.trim();
  if (trimmed.length < 10) return null;
  const fallback = () => {
    const title = trimmed.split(/\r?\n/)[0]!.trim().slice(0, 40);
    return title ? createTask({ title, description: '', conversationId, creatorName, priority: 'mid' }) : null;
  };

  const cfg = toConfig(getDefaultModel());
  if (!cfg?.apiKey) {
    const t = fallback();
    if (t) broadcast('task', t, conversationId);
    return t;
  }

  try {
    const reply = await completeChat(
      cfg,
      [
        {
          role: 'system',
          content:
            '判断用户这句话是不是一个可以交给团队做的任务。如果是，总结成一句标题（不超过 20 字）和一句描述。只输出 JSON：{"is_task":true,"title":"...","description":"...","priority":"high|mid|low"}。寒暄、单纯提问、确认类不算任务，is_task 为 false，其余字段留空。',
        },
        { role: 'user', content: trimmed.slice(0, 1500) },
      ],
      { temperature: 0, maxTokens: 160 },
    );
    const raw = reply.match(/\{[\s\S]*\}/);
    const json = raw ? JSON.parse(raw[0]) : null;
    if (!json?.is_task) return null;
    const title = String(json.title ?? '').trim().slice(0, 60);
    if (!title) return null;
    const priority = ['high', 'mid', 'low'].includes(json.priority) ? json.priority : 'mid';
    const task = createTask({
      title,
      description: String(json.description ?? '').slice(0, 500),
      conversationId,
      creatorName,
      priority,
    });
    broadcast('task', task, conversationId);
    return task;
  } catch {
    const t = fallback();
    if (t) broadcast('task', t, conversationId);
    return t;
  }
}

async function judgeTaskDone(task: { id: string; title: string; conversationId: string | null; createdAt: number }, model: ReturnType<typeof getDefaultModel>): Promise<boolean> {  if (!task.conversationId) return false;
  const recent = listMessages(task.conversationId, 50).filter(
    (m) => m.createdAt >= task.createdAt && m.authorType === 'agent',
  );
  if (!recent.length) return false;

  if (model && model.baseUrl && model.apiKey) {
    try {
      const res = await fetch(`${model.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${model.apiKey}` },
        body: JSON.stringify({
          model: model.model,
          temperature: 0,
          max_tokens: 6,
          messages: [
            { role: 'system', content: '判断群聊是否已经把任务完成。只回答 DONE 或 TODO。' },
            {
              role: 'user',
              content: `任务：${task.title}\n最近讨论：\n${recent.map((m) => m.text).join('\n').slice(0, 2000)}`,
            },
          ],
        }),
      });
      const json: any = await res.json();
      const content = String(json?.choices?.[0]?.message?.content ?? '');
      if (/DONE/i.test(content)) return true;
      if (/TODO/i.test(content)) return false;
    } catch {
      /* 判断失败走兜底 */
    }
  }
  // mock 模式兜底：任务创建后已有至少两条智能体发言，视为可确认
  return recent.length >= 2;
}

function pickTargets(conv: Conversation, text: string): string[] {
  const agents = conv.members.filter((m) => m.memberType === 'agent' && !m.muted);
  if (!agents.length) return [];

  const mentions = [...text.matchAll(/@([^\s@，,。.！!？?]+)/g)].map((m) => m[1]!);
  if (mentions.length) {
    const hit = agents.filter((a) => mentions.some((n) => a.name === n || a.name.includes(n) || n.includes(a.name)));
    if (hit.length) return hit.slice(0, 3).map((a) => a.memberId);
  }
  if (!conv.autoReply) return [];
  const limit = conv.maxTurns === 0 ? agents.length : Math.min(conv.maxTurns || 3, agents.length);
  return agents.slice(0, limit).map((a) => a.memberId);
}

/** 判断这一轮智能体发言里是否存在明确意见冲突 */
async function detectDisagreement(
  conv: Conversation,
  messages: Array<{ text: string; authorType: string; authorId: string | null; authorName?: string | null }>,
  model: ReturnType<typeof getDefaultModel>,
): Promise<boolean> {
  const joined = messages.map((m) => m.text).join('\n').slice(0, 3000);
  if (!joined.trim()) return false;

  const cfg = toConfig(model);
  if (!cfg?.apiKey) {
    return /(不同意|反对|不建议|不行|来不及|有冲突|我保留)/.test(joined);
  }
  try {
    const reply = await completeChat(
      cfg,
      [
        {
          role: 'system',
          content: '判断下面多个智能体的发言是否存在明确意见冲突（方案、优先级或判断互相矛盾），只是补充细节不算。只回答 CONFLICT 或 CONSISTENT。',
        },
        { role: 'user', content: joined },
      ],
      { temperature: 0, maxTokens: 8 },
    );
    return /CONFLICT/i.test(reply);
  } catch {
    return false;
  }
}

async function summarizeDisagreement(
  conv: Conversation,
  messages: Array<{ text: string; authorType: string; authorId: string | null; authorName?: string | null }>,
  model: ReturnType<typeof getDefaultModel>,
): Promise<string> {
  const fallback = '目前智能体之间的意见有分歧，请你们拍板。';
  const cfg = toConfig(model);
  if (!cfg?.apiKey) return fallback;
  try {
    const reply = await completeChat(
      cfg,
      [
        {
          role: 'system',
          content: '用一句中文概括这些智能体发言里的主要分歧，不超过 60 字，不要评价谁对谁错，只输出这句话。',
        },
        {
          role: 'user',
          content: messages.map((m) => `${senderName(conv, m as any)}：${m.text}`).join('\n').slice(0, 3000),
        },
      ],
      { temperature: 0.2, maxTokens: 100 },
    );
    if (reply.trim()) return reply.trim().slice(0, 160);
  } catch {
    /* 用兜底 */
  }
  return fallback;
}

/** 意见冲突时，@ 群里所有真人来拍板 */
async function askAllHumansOnConflict(
  conv: Conversation,
  messages: Array<{ text: string; authorType: string; authorId: string | null; authorName?: string | null }>,
  model: ReturnType<typeof getDefaultModel>,
): Promise<void> {
  if (conv.type !== 'group' || messages.length < 2) return;
  const humans = conv.members.filter((m) => m.memberType === 'human');
  if (!humans.length) return;
  if (!(await detectDisagreement(conv, messages, model))) return;

  const summary = await summarizeDisagreement(conv, messages, model);
  const mentions = humans.map((h) => `@${h.name}`).join(' ');
  const authorId = messages[messages.length - 1]?.authorId
    ?? conv.members.find((m) => m.memberType === 'agent')?.memberId;
  if (!authorId) return;

  addMessage({
    conversationId: conv.id,
    authorType: 'agent',
    authorId,
    role: 'assistant',
    text: `${mentions} ${summary}`,
  });
  for (const h of humans) {
    const human = getHuman(h.memberId);
    if (human?.simulated) void scheduleSimulatedReply(conv.id, human.id, Date.now());
  }
}

/** 多轮讨论后由主持人智能体给结论；有冲突时 @ 所有真人 */
async function postDiscussionConclusion(
  conv: Conversation,
  messages: Array<{ text: string; authorType: string; authorId: string | null; authorName?: string | null }>,
  model: ReturnType<typeof getDefaultModel>,
): Promise<void> {
  if (conv.type !== 'group' || messages.length < 2) return;
  const agents = conv.members.filter((m) => m.memberType === 'agent' && !m.muted);
  const leadMember = agents.find((a) => /产品|评审|主持|架构/.test(`${a.name} ${a.role}`)) ?? agents[0];
  const lead = leadMember ? getAgent(leadMember.memberId) : null;
  if (!lead) return;

  const humans = conv.members.filter((m) => m.memberType === 'human');
  const hasConflict = await detectDisagreement(conv, messages, model);
  const mentions = hasConflict && humans.length ? humans.map((h) => `@${h.name}`).join(' ') : '';
  const context = messages.slice(-12).map((m) => `${senderName(conv, m as any)}：${m.text}`).join('\n').slice(0, 5000);

  const fallbackLines = [
    '📌 讨论结论',
    '',
    '核心共识',
    ...messages.slice(-3).map((m) => `• ${m.text.replace(/\s+/g, ' ').slice(0, 100)}`),
    '',
    '下一步',
    '• 先把上面共识落成一条可执行待办，再继续验证。',
  ];
  if (hasConflict) fallbackLines.push('', '目前还有分歧，需要真人拍板。');
  const fallback = fallbackLines.join('\n');

  const cfg = toConfig(model);
  let text = fallback;
  if (cfg?.apiKey) {
    try {
      const reply = await completeChat(
        cfg,
        [
          {
            role: 'system',
            content: [
              `你是${lead.name}，${lead.role}，现在是这场群聊讨论的主持人。`,
              '请基于大家的发言给出最终结论，不要重复每个人说过的话。',
              '结构：第一行「📌 讨论结论」，然后分「核心共识」「仍存在的分歧」「建议下一步」三段，用 • 列表；最后说明需要谁拍板。',
              '不要用 Markdown 的 #、**、表格；总字数 280 字以内，语气明确。',
              lead.systemPrompt,
            ].join('\n'),
          },
          { role: 'user', content: `群聊发言：\n${context}` },
        ],
        { temperature: 0.35, maxTokens: 500 },
      );
      if (reply.trim()) text = reply.trim();
    } catch {
      /* 用兜底 */
    }
  }

  if (hasConflict && mentions && !text.includes('@')) {
    text += `\n\n${mentions} 目前还有分歧，请你们拍板。`;
  }

  addMessage({
    conversationId: conv.id,
    authorType: 'agent',
    authorId: lead.id,
    role: 'assistant',
    text,
    parts: [{ type: 'discussion-conclusion' }],
  });

  if (hasConflict) {
    for (const h of humans) {
      const human = getHuman(h.memberId);
      if (human?.simulated) void scheduleSimulatedReply(conv.id, human.id, Date.now());
    }
  }
}

/** 找出这条发言里 @ 到的真人成员 */
function humansMentioned(text: string, conv: Conversation): Member[] {
  const mentions = [...text.matchAll(/@([^\s@，,。.！!？?]+)/g)].map((m) => m[1]!);
  if (!mentions.length) return [];
  return conv.members.filter(
    (m) => m.memberType === 'human' && mentions.some((n) => m.name === n || m.name.includes(n) || n.includes(m.name)),
  );
}

/**
 * 软等待：智能体 @ 真人后暂停，等真人回复、手动继续/跳过，或者 60 秒超时。
 * 同一个 run 只允许一个等待。
 */
const HUMAN_WAIT_SECONDS = 60;

interface HumanWaitEntry {
  runId: string;
  conversationId: string;
  humanId: string;
  resolve: (decision: HumanWaitDecision) => void;
}

type HumanWaitDecision = 'continue' | 'skip' | 'reply' | 'timeout';

const humanWaits = new Map<string, HumanWaitEntry>();

function resolveHumanWait(runId: string, decision: HumanWaitDecision): boolean {
  const entry = humanWaits.get(runId);
  if (!entry) return false;
  entry.resolve(decision);
  return true;
}

function findHumanWaitForConversation(conversationId: string): HumanWaitEntry | null {
  for (const entry of humanWaits.values()) {
    if (entry.conversationId === conversationId) return entry;
  }
  return null;
}

function waitForHuman(
  runId: string,
  conversationId: string,
  human: Member,
  remaining: number,
): Promise<HumanWaitDecision> {
  return new Promise((resolve) => {
    let done = false;
    let timer: NodeJS.Timeout | undefined;

    const finish = (decision: HumanWaitDecision) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      bus.off('event', onMessage);
      humanWaits.delete(runId);
      broadcast('human.resume', {
        runId,
        conversationId,
        humanId: human.memberId,
        name: human.name,
        decision,
      });
      resolve(decision);
    };

    const onMessage = (event: unknown) => {
      const e = event as { type?: string; conversationId?: string; data?: { authorType?: string; authorId?: string } };
      if (e.type !== 'message' || e.conversationId !== conversationId) return;
      if (e.data?.authorType === 'human' && e.data.authorId === human.memberId) finish('reply');
    };

    timer = setTimeout(() => finish('timeout'), HUMAN_WAIT_SECONDS * 1000);
    humanWaits.set(runId, { runId, conversationId, humanId: human.memberId, resolve: finish });
    bus.on('event', onMessage);

    broadcast('human.wait', {
      runId,
      conversationId,
      humanId: human.memberId,
      name: human.name,
      role: human.role,
      color: human.color,
      initial: human.initial,
      seconds: HUMAN_WAIT_SECONDS,
      remaining,
    });
  });
}

const SIM_REPLIES: Record<string, string[]> = {
  hu_sim_lina: [
    '增长这边可以。先按 10% 流量灰度，三天后看首日留存再决定要不要放量。',
    '我拍板：这周先小流量验证，别一次全量。指标口径我下午补一版。',
    '没问题，我拉一下上周的留存数据，明天评审时带上。',
  ],
  hu_sim_wang: [
    '后端没问题，接口两天能给。回滚开关我一起加上，避免上线后被动。',
    '我担心老接口兼容，建议先双写一周再切，风险可控一些。',
    '行，我先出个技术方案，明天评审前发群里。',
  ],
  hu_sim_chen: [
    '视觉这边我来跟。先出一版首页空状态和加载态，明天上午发群里看。',
    '我只有一个要求：文案别太长，按钮层级要清楚，不然用户还是不知道点哪。',
    '设计稿我今天下午更新，走查清单一起带上，避免开发阶段来回改。',
  ],
};

/** 模拟真人被 @ 后自动回一句，用来演示对话和软等待 */
async function scheduleSimulatedReply(conversationId: string, humanId: string, triggerAt: number): Promise<void> {
  const human = getHuman(humanId);
  if (!human?.simulated) return;

  setTimeout(async () => {
    const conv = getConversation(conversationId);
    if (!conv || !conv.members.some((m) => m.memberId === humanId)) return;

    const hasReplied = () =>
      listMessages(conversationId, 12).some(
        (m) => m.authorType === 'human' && m.authorId === humanId && m.createdAt >= triggerAt,
      );
    if (hasReplied()) return;

    const pool = SIM_REPLIES[humanId] ?? ['收到，我看一下。'];
    let text = pool[Math.floor(Math.random() * pool.length)] ?? pool[0]!;

    const cfg = toConfig(getDefaultModel());
    if (cfg?.baseUrl && cfg.apiKey) {
      try {
        const context = listMessages(conversationId, 8)
          .map((m) => `${senderName(conv, m)}：${m.text}`)
          .join('\n');
        const reply = await completeChat(
          cfg,
          [
            {
              role: 'system',
              content: `你是${human.name}，${human.role}，群里的真人同事。别人 @ 你时用 1~2 句中文口语回复，给出判断或下一步，不超过 80 字。不要自称 AI。`,
            },
            { role: 'user', content: `群聊「${conv.title}」最近的发言：\n${context}\n\n请回复。` },
          ],
          { temperature: 0.6, maxTokens: 160 },
        );
        if (reply.trim()) text = reply.trim();
      } catch {
        /* 模型不可用就用兜底话术 */
      }
    }

    if (hasReplied()) return;
    addMessage({
      conversationId,
      authorType: 'human',
      authorId: human.id,
      authorName: human.name,
      authorColor: human.color,
      authorInitial: human.initial,
      role: 'user',
      text,
    });
  }, 3500 + Math.floor(Math.random() * 1500));
}

/** 暂停剩余智能体发言，等待真人拍板 */
async function maybeWaitForHuman(
  runId: string,
  conv: Conversation,
  text: string,
  remaining: number,
): Promise<HumanWaitDecision | null> {
  const mentions = humansMentioned(text, conv);
  const first = mentions[0];
  if (!first) return null;

  for (const m of mentions) {
    const h = getHuman(m.memberId);
    if (h?.simulated) void scheduleSimulatedReply(conv.id, h.id, Date.now());
  }
  if (remaining <= 0) return null;
  return waitForHuman(runId, conv.id, first, remaining);
}

/** 群聊最近几条真实发言，用来生成“刚加入”的提问 */
function joinContext(conversationId: string, limit = 6) {
  return listMessages(conversationId, 30)
    .filter((m) => m.status === 'done' && m.authorType !== 'system' && (m.role === 'user' || m.role === 'assistant'))
    .slice(-limit);
}

async function buildJoinQuestion(
  conv: Conversation,
  kind: 'human' | 'agent',
  member: { name: string; role: string; skills?: string[] },
  asker: { name: string; role: string },
  context: { text: string }[],
): Promise<string> {
  const contextText = context.map((m) => m.text).join('\n').slice(0, 1200);
  const skills = (member.skills ?? []).slice(0, 3).join('、');

  const fallback = kind === 'human'
    ? context.length
      ? `@${member.name} 刚加入群聊。你先看下最近的讨论，从${member.role || '你的角度'}看，最大的风险或补充是什么？`
      : `@${member.name} 刚加入群聊，先说说你能帮上什么？`
    : context.length
      ? `@${member.name} 你擅长${skills || member.role}。结合刚才的讨论，从${member.skills?.[0] ?? member.role}角度给一个判断？`
      : `@${member.name} 你擅长${skills || member.role}，先介绍一下你能接手哪部分？`;

  const cfg = toConfig(getDefaultModel());
  if (!cfg?.baseUrl || !cfg.apiKey) return fallback;

  try {
    const reply = await completeChat(
      cfg,
      [
        {
          role: 'system',
          content: [
            `你是${asker.name}，${asker.role}。`,
            `群聊里刚加入${kind === 'human' ? '一位真人同事' : '一位新智能体'}。`,
            kind === 'human'
              ? '结合最近讨论，用一句中文 @对方，问他对当前讨论的看法。'
              : '结合最近讨论，用一句中文 @对方，围绕他擅长的方向问一个具体问题。',
            '只输出这一句群聊消息，不超过 80 字，不要加引号和解释。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: `最近讨论：\n${contextText || '（还没有历史发言）'}\n\n新成员：${member.name}（${member.role}${skills ? `，擅长${skills}` : ''}）。`,
        },
      ],
      { temperature: 0.5, maxTokens: 160 },
    );
    const text = reply.trim().slice(0, 300);
    if (text) return text.includes(`@${member.name}`) ? text : `@${member.name} ${text}`;
  } catch {
    /* 模型失败就用模板 */
  }
  return fallback;
}

/** 把模型输出整理成适合聊天气泡显示的纯文本排版 */
function tidySummary(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 给刚加入的真人做一段带排版的上下文摘要，并在末尾请他发表看法 */
async function buildContextSummary(
  conv: Conversation,
  human: { name: string; role: string },
  asker: { name: string; role: string },
  context: Array<{ text: string; authorType: string; authorId: string | null; authorName?: string | null }>,
): Promise<string> {
  const names = conv.members.map((m) => `${m.name}${m.role ? `（${m.role}）` : ''}`).join('、');
  const recent = context.slice(-8);
  const contextText = recent
    .map((m) => `${senderName(conv, m as any)}：${m.text}`)
    .join('\n')
    .slice(0, 2400);

  const fallbackLines = [
    '📋 群聊上下文摘要',
    '',
    `群聊：${conv.title}`,
    `成员：${names}`,
    '',
  ];
  if (recent.length) {
    fallbackLines.push('最近在讨论');
    for (const m of recent.slice(-4)) {
      fallbackLines.push(`• ${senderName(conv, m as any)}：${m.text.replace(/\s+/g, ' ').slice(0, 90)}`);
    }
    fallbackLines.push('', '接下来');
    fallbackLines.push(`• 上面这些点里，哪些和你的工作直接相关？`);
  } else {
    fallbackLines.push('群里还没有历史发言。');
  }
  fallbackLines.push('', `@${human.name} 你先看下上面的上下文，从${human.role || '你的角度'}看，有什么风险或补充？`);
  const fallback = fallbackLines.join('\n');

  const cfg = toConfig(getDefaultModel());
  if (!cfg?.baseUrl || !cfg.apiKey) return fallback;

  try {
    const reply = await completeChat(
      cfg,
      [
        {
          role: 'system',
          content: [
            `你是${asker.name}，${asker.role}。群聊「${conv.title}」刚加入真人同事 ${human.name}${human.role ? `（${human.role}）` : ''}。`,
            '请给 TA 写一段带排版的上下文摘要，让 TA 快速跟上，并在最后问 TA 的看法。',
            '格式要求：',
            '1. 第一行固定是：📋 群聊上下文摘要',
            '2. 依次写「最近在讨论」「已经对齐」「还需要确认」三段，没有内容的段可以省略',
            '3. 每段用 • 列 1~3 条，每条不超过 40 字',
            '4. 不要用 Markdown 的 #、**、表格，用空行分段',
            `5. 最后单独一行 @${human.name}，从 TA 的角色问一个具体问题`,
            '6. 总字数控制在 260 字以内，只输出摘要正文',
          ].join('\n'),
        },
        {
          role: 'user',
          content: `最近发言：\n${contextText || '（还没有历史发言）'}\n\n群成员：${names}`,
        },
      ],
      { temperature: 0.35, maxTokens: 520 },
    );

    let text = tidySummary(reply || fallback);
    if (!text.includes('摘要')) text = `📋 群聊上下文摘要\n\n${text}`;
    if (!text.includes(`@${human.name}`)) {
      text += `\n\n@${human.name} 你先看下上面的上下文，从${human.role || '你的角度'}看，有什么风险或补充？`;
    }
    return text.slice(0, 1200);
  } catch {
    return fallback;
  }
}

/** 新智能体加入后，按自己的擅长方向给群里做一段上下文摘要，并说明准备怎么参与 */
async function buildAgentJoinSummary(
  conv: Conversation,
  agent: { name: string; role: string; systemPrompt: string; skills: string[] },
  askerName: string,
  context: Array<{ text: string; authorType: string; authorId: string | null; authorName?: string | null }>,
): Promise<string> {
  const skill = agent.skills[0] ?? agent.role ?? '我的专业';
  const skills = (agent.skills.length ? agent.skills : [agent.role]).filter(Boolean).join('、');
  const recent = context.slice(-10);
  const contextText = recent
    .map((m) => `${senderName(conv, m as any)}：${m.text}`)
    .join('\n')
    .slice(0, 2600);

  const fallbackLines = [`📋 从${skill}视角看上下文`, ''];
  if (recent.length) {
    fallbackLines.push('最近在讨论');
    for (const m of recent.slice(-3)) {
      fallbackLines.push(`• ${senderName(conv, m as any)}：${m.text.replace(/\s+/g, ' ').slice(0, 90)}`);
    }
    fallbackLines.push('', '我的判断');
    fallbackLines.push(`• 结合${skills}，现在最需要先把讨论收敛成可执行的分工。`);
    fallbackLines.push('', '我能接的部分');
    fallbackLines.push(`• ${skill}相关的问题我来跟，先把上面的分歧拆成明确选项。`);
  } else {
    fallbackLines.push('群里还没有历史发言。');
    fallbackLines.push('', '我能接的部分');
    fallbackLines.push(`• ${skill}相关的部分我来接，等你们把目标丢进来。`);
  }
  fallbackLines.push('', `@${askerName} 我先从${skill}这块跟进，下一步建议把结论落成一条可执行的待办。`);
  const fallback = fallbackLines.join('\n');

  const cfg = toConfig(getDefaultModel());
  if (!cfg?.baseUrl || !cfg.apiKey) return fallback;

  try {
    const reply = await completeChat(
      cfg,
      [
        {
          role: 'system',
          content: [
            `你是${agent.name}，${agent.role}，擅长${skills}。你刚被拉进群聊「${conv.title}」。`,
            '请从你的专业视角，给群里所有人梳理一遍当前上下文，并说明你准备从哪里参与。',
            '格式要求：',
            `1. 第一行固定是：📋 从${skill}视角看上下文`,
            '2. 依次写「最近在讨论」「我的判断」「我能接的部分」三段，没有内容的段可以省略',
            '3. 每段用 • 列 1~3 条，每条不超过 40 字',
            '4. 不要用 Markdown 的 #、**、表格，用空行分段',
            `5. 最后单独一行 @${askerName}，给一个具体的下一步或分工建议`,
            '6. 总字数控制在 280 字以内，只输出摘要正文',
            agent.systemPrompt,
          ].join('\n'),
        },
        {
          role: 'user',
          content: `最近发言：\n${contextText || '（还没有历史发言）'}\n\n群成员：${conv.members.map((m) => m.name).join('、')}`,
        },
      ],
      { temperature: 0.4, maxTokens: 600 },
    );

    let text = tidySummary(reply || fallback);
    if (!text.includes('摘要') && !text.includes('视角看上下文')) text = `📋 从${skill}视角看上下文\n\n${text}`;
    if (!text.includes('@')) text += `\n\n@${askerName} 我先从${skill}这块跟进，下一步建议把结论落成一条可执行的待办。`;
    return text.slice(0, 1400);
  } catch {
    return fallback;
  }
}

/**
 * 成员加入群聊后给智能体发一个「事件」：
 * - 真人：让一个现有智能体给他发一段带排版的上下文摘要，并请他发表看法
 * - 智能体：新智能体按自己的擅长方向总结上下文，说明能接哪部分，并给出下一步
 */
async function sendJoinEvent(conversationId: string, kind: 'human' | 'agent', memberId: string): Promise<void> {
  const conv = getConversation(conversationId);
  if (!conv || conv.type !== 'group') return;

  const existingAgents = conv.members.filter((m) => m.memberType === 'agent' && m.memberId !== memberId && !m.muted);
  const askerMember = existingAgents[0];
  const asker = askerMember ? getAgent(askerMember.memberId) : null;

  if (kind === 'human') {
    if (!asker) return;
    const human = getHuman(memberId);
    if (!human) return;
    const context = joinContext(conversationId, 10);
    const summary = await buildContextSummary(conv, human, asker, context);
    addMessage({
      conversationId,
      authorType: 'agent',
      authorId: asker.id,
      role: 'assistant',
      text: summary,
      parts: [{ type: 'context-summary' }],
    });
    if (human.simulated) void scheduleSimulatedReply(conversationId, human.id, Date.now());
    return;
  }

  const newAgent = getAgent(memberId);
  if (!newAgent) return;
  const askerName = asker?.name
    ?? conv.members.find((m) => m.memberType === 'human')?.name
    ?? '大家';
  const context = joinContext(conversationId, 12);
  const summary = await buildAgentJoinSummary(conv, newAgent, askerName, context);
  addMessage({
    conversationId,
    authorType: 'agent',
    authorId: newAgent.id,
    role: 'assistant',
    text: summary,
    parts: [{ type: 'context-summary' }],
  });
}

function senderName(conv: Conversation, m: { authorId: string | null; authorName?: string | null; authorType: string }): string {
  if (m.authorType === 'user') return '用户';
  const mem = conv.members.find((x) => x.memberId === m.authorId);
  return mem?.name ?? m.authorName ?? '同事';
}

/** 把「人设 + 群聊最近发言 + 这次要回的话」拼成给 opencode 的 prompt */
function buildOpencodePrompt(
  conv: Conversation,
  agent: { id: string; name: string; role: string; systemPrompt: string },
  text: string,
  beforeAt: number,
  citations: Array<{ n: number; doc: string; text: string }> = [],
): string {
  const recent = listMessages(conv.id, 30)
    .filter((m) => m.createdAt < beforeAt && m.authorType === 'agent' && m.status === 'done' && m.authorId !== agent.id)
    .slice(-6);

  const context = recent
    .map((m) => `${senderName(conv, m)}：${m.text}`)
    .join('\n');

  const refs = citations.length
    ? citations.map((c) => `[${c.n}] ${c.doc}：${c.text}`).join('\n')
    : '';

  const humans = conv.members
    .filter((m) => m.memberType === 'human')
    .map((m) => `${m.name}${m.role ? `（${m.role}）` : ''}`);

  const persona = [
    `你是${agent.name}，${agent.role}。`,
    agent.systemPrompt,
    '你在一个多人会话里，成员包括用户和其他智能体。只代表你自己发言，不要替别人说话，不要在开头加自己的名字。',
    humans.length ? `群里还有真人同事：${humans.join('、')}。需要拍板时可以用 @名字 征求他们的意见。` : '',
    '回答控制在 260 字以内：先简要给出判断依据，再给结论，不要只回一句话。',
    refs ? '如果用了下面的资料，请在句末用 [1][2] 这样的角标标出来。' : '',
  ].filter(Boolean).join('\n');

  return [
    persona,
    '',
    `【${conv.type === 'group' ? '群聊' : '对话'}最近的发言】`,
    context || '（还没有）',
    '',
    '【用户刚刚说】',
    text || '（发了附件）',
    ...(refs ? ['', '【检索到的资料】', refs] : []),
    '',
    '现在轮到你发言。',
  ].join('\n');
}

function formatBytes(size?: number): string {
  const n = Number(size ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 把消息里上传的附件转成模型能读的上下文（文本文件读正文，图片只报文件名） */
function attachmentText(parts: unknown, totalLimit = 12_000): string {
  if (!Array.isArray(parts) || parts.length === 0) return '';
  const blocks: string[] = [];
  let budget = totalLimit;

  for (const raw of parts) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as { type?: string; name?: string; size?: number; mime?: string; text?: string };
    const name = p.name?.trim() || '附件';
    const meta = [p.mime, formatBytes(p.size)].filter(Boolean).join('，');

    if (p.type === 'image') {
      blocks.push(`[图片] ${name}${meta ? `（${meta}）` : ''}：当前模型读不到图片内容，只能看到文件名。`);
      continue;
    }

    const content = typeof p.text === 'string' ? p.text.trim() : '';
    if (content && budget > 0) {
      const clipped = content.slice(0, Math.min(6000, budget));
      budget -= clipped.length;
      blocks.push(
        `[文件] ${name}${meta ? `（${meta}）` : ''}\n\`\`\`\n${clipped}${content.length > clipped.length ? '\n…（内容已截断）' : ''}\n\`\`\``,
      );
    } else {
      blocks.push(`[文件] ${name}${meta ? `（${meta}）` : ''}：没有可读取的文本内容`);
    }
  }

  return blocks.length ? `用户上传了附件：\n\n${blocks.join('\n\n')}` : '';
}

function textWithAttachments(text: string, parts: unknown, limit = 12_000): string {
  const attachment = attachmentText(parts, limit);
  return [text.trim(), attachment].filter(Boolean).join('\n\n');
}

/* ---------- 评审 → 实现 → 再评审 ---------- */

interface ExecutionPlanPart {
  type: 'execution-plan';
  planId: string;
  conversationId: string;
  agentId: string;
  agentName: string;
  agentRole: string;
  agentColor: string;
  title: string;
  htmlName: string;
  sourceMessageId: string;
}

type ExecutionStatus = 'running' | 'done' | 'failed';
const executionRuns = new Map<string, ExecutionStatus>();

/** 找一个最像“实现者”的智能体：前端 / UI / 开发优先 */
function pickImplementer(conv: Conversation): Member | null {
  const ranked = conv.members
    .filter((m) => m.memberType === 'agent' && !m.muted)
    .map((m) => {
      const a = getAgent(m.memberId);
      const text = [m.name, m.role, a?.description ?? '', ...(a?.skills ?? [])].join(' ');
      let score = 0;
      if (/(前端|frontend|web|页面|界面|ui)/i.test(text)) score += 10;
      if (/(全栈|开发|实现|工程师)/i.test(text)) score += 3;
      if (/(架构|后端|数据|文案|产品|评审)/.test(text)) score -= 4;
      return { member: m, score };
    })
    .sort((a, b) => b.score - a.score);
  return ranked[0] && ranked[0].score > 0 ? ranked[0].member : null;
}

function hasImplementationIntent(text: string): boolean {
  return /(实现|开发|做一个|做一版|做出来|改版|搭建|落地|上线|按这个|照着|照着做|写个|写一版)/.test(text);
}

function htmlAttachment(parts: unknown): { name: string; text: string } | null {
  if (!Array.isArray(parts)) return null;
  for (const raw of parts) {
    const p = raw as { type?: string; name?: string; text?: string } | null;
    if (!p || typeof p.text !== 'string' || !p.text.trim()) continue;
    if (/\.html?$/i.test(String(p.name ?? ''))) return { name: String(p.name), text: p.text };
  }
  return null;
}

function makeExecutionPlan(
  conv: Conversation,
  text: string,
  parts: unknown,
  sourceMessageId: string,
): ExecutionPlanPart | null {
  if (conv.type !== 'group') return null;
  const html = htmlAttachment(parts);
  if (!html || !text.trim() || !hasImplementationIntent(text)) return null;
  const implementer = pickImplementer(conv);
  if (!implementer) return null;
  const agent = getAgent(implementer.memberId);
  if (!agent) return null;
  return {
    type: 'execution-plan',
    planId: `plan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    conversationId: conv.id,
    agentId: agent.id,
    agentName: agent.name,
    agentRole: agent.role,
    agentColor: agent.color,
    title: text.split(/\r?\n/)[0]!.trim().slice(0, 80) || `按 ${html.name} 实现`,
    htmlName: html.name,
    sourceMessageId,
  };
}

function findGeneratedHtml(dir: string, since: number, depth = 0): string | null {
  if (depth > 3) return null;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const files = entries
    .filter((e) => e.isFile() && /\.html?$/i.test(e.name))
    .map((e) => join(dir, e.name))
    .filter((p) => {
      try { return statSync(p).mtimeMs >= since - 3000; } catch { return false; }
    });
  const index = files.find((p) => basename(p).toLowerCase() === 'index.html');
  if (index) return index;
  if (files.length) return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]!;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findGeneratedHtml(join(dir, entry.name), since, depth + 1);
    if (found) return found;
  }
  return null;
}

function extractHtml(text: string): string {
  const fenced = text.match(/```html\s*\r?\n([\s\S]*?)```/i);
  if (fenced && fenced[1]!.trim()) return fenced[1]!.trim();
  const idx = text.search(/<!doctype html|<html[\s>]/i);
  return idx >= 0 ? text.slice(idx).trim() : '';
}

const PREVIEW_TEXT_EXT = /\.(html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|json|md|txt|yml|yaml|xml|svg|vue|svelte|py|go|java|kt|rs|c|cpp|h|hpp|sh|sql)$/i;

function collectChangedFiles(
  dir: string,
  since: number,
): Array<{ name: string; path: string; size: number; content?: string; truncated?: boolean }> {
  const files: Array<{ name: string; path: string; size: number; content?: string; truncated?: boolean }> = [];
  let budget = 80_000;

  const walk = (current: string, depth: number) => {
    if (depth > 3 || files.length >= 12) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= 12) break;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === 'prototype.html' || entry.name === 'brief.md') continue;
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.mtimeMs < since - 3000) continue;
      const rel = relative(dir, full).replace(/\\/g, '/');
      const item: { name: string; path: string; size: number; content?: string; truncated?: boolean } = {
        name: entry.name,
        path: rel,
        size: stat.size,
      };
      if (PREVIEW_TEXT_EXT.test(entry.name) && stat.size <= 300 * 1024 && budget > 0) {
        try {
          const raw = readFileSync(full, 'utf8');
          const clipped = raw.slice(0, Math.min(20_000, budget));
          budget -= clipped.length;
          item.content = clipped;
          if (raw.length > clipped.length) item.truncated = true;
        } catch {
          /* 读不了就只给文件名 */
        }
      }
      files.push(item);
    }
  };

  walk(dir, 0);
  return files;
}

function saveArtifact(conversationId: string, planId: string, title: string, html: string) {
  const dir = join(artifactRoot, conversationId);
  mkdirSync(dir, { recursive: true });
  const file = `${planId}.html`;
  writeFileSync(join(dir, file), html, 'utf8');
  const safeTitle = (title || '实现').replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 40) || '实现';
  return {
    url: `/api/artifacts/${encodeURIComponent(conversationId)}/${file}`,
    name: `${safeTitle}.html`,
    size: Buffer.byteLength(html),
  };
}

async function runExecution(plan: ExecutionPlanPart, allowTools: boolean): Promise<void> {
  if (executionRuns.get(plan.planId) === 'running') return;
  executionRuns.set(plan.planId, 'running');

  const conv = getConversation(plan.conversationId);
  const agent = getAgent(plan.agentId);
  if (!conv || !agent) {
    executionRuns.set(plan.planId, 'failed');
    return;
  }

  const source = listMessages(plan.conversationId, 200).find((m) => m.id === plan.sourceMessageId);
  const prototype = htmlAttachment(source?.parts);
  const context = joinContext(plan.conversationId, 12)
    .map((m) => `${senderName(conv, m)}：${m.text}`)
    .join('\n')
    .slice(0, 4000);

  addMessage({
    conversationId: plan.conversationId,
    authorType: 'agent',
    authorId: agent.id,
    role: 'assistant',
    text: allowTools
      ? `开始实现：${plan.title}。本次任务已允许工具操作，我直接写文件。`
      : `开始实现：${plan.title}。先产出可预览的单文件版本。`,
  });

  const startedAt = Date.now();
  const model = getDefaultModel();
  const cfg = toConfig(model);
  let html = '';
  let modeNote = '';
  let changedFiles: Array<{ name: string; path: string; size: number; content?: string; truncated?: boolean }> = [];

  if (allowTools) {
    let opencodeOn = false;
    try {
      opencodeOn = await ensureOpencode(model ?? null);
    } catch {
      opencodeOn = false;
    }
    if (opencodeOn) {
      try {
        const session = await ensureSession(plan.conversationId, agent);
        writeFileSync(join(session.workspace, 'prototype.html'), prototype?.text ?? '', 'utf8');
        writeFileSync(
          join(session.workspace, 'brief.md'),
          `# 需求\n\n${plan.title}\n\n## 群聊评审\n\n${context || '（无）'}\n`,
          'utf8',
        );
        const prompt = [
          `你是${agent.name}，${agent.role}。群里已经完成技术评审，现在请你直接实现，不要再问问题。`,
          '工作区根目录有 prototype.html（用户上传的原型）和 brief.md（需求与评审意见）。',
          '请产出一个可运行的单文件 index.html，CSS 和 JS 全部内联，保存到工作区根目录。',
          '不要修改 prototype.html 和 brief.md；完成后用一句话说明你实现了什么。',
        ].join('\n');
        for await (const ev of runAgent({
          sessionId: session.sessionId,
          prompt,
          signal: new AbortController().signal,
          autoApprove: true,
        })) {
          if (ev.type === 'error') break;
        }
        const file = findGeneratedHtml(session.workspace, startedAt);
        if (file) html = readFileSync(file, 'utf8');
        changedFiles = collectChangedFiles(session.workspace, startedAt);
        if (!html) modeNote = 'opencode 没有找到新生成的 HTML，已回退到模型产物。';
      } catch {
        modeNote = 'opencode 执行失败，已回退到模型产物。';
      }
    } else {
      modeNote = 'opencode 不可用，已改用模型产物。';
    }
  }

  if (!html) {
    if (!cfg?.apiKey) {
      addMessage({
        conversationId: plan.conversationId,
        authorType: 'agent',
        authorId: agent.id,
        role: 'assistant',
        text: '没有可用的模型，无法生成实现产物。请先在设置里配置模型，或开启 opencode。',
      });
      executionRuns.set(plan.planId, 'failed');
      return;
    }
    try {
      const reply = await completeChat(
        cfg,
        [
          {
            role: 'system',
            content: [
              `你是${agent.name}，${agent.role}。`,
              agent.systemPrompt,
              '根据用户原型和群聊评审意见，实现一个完整、可运行的单文件 HTML 页面，CSS 和 JS 全部内联。',
              '只输出一个 ```html 代码块，不要解释。',
            ].join('\n'),
          },
          {
            role: 'user',
            content: `需求：${plan.title}\n\n群聊上下文：\n${context || '（无）'}\n\n用户上传的原型：\n${(prototype?.text ?? '').slice(0, 12000)}`,
          },
        ],
        { temperature: 0.35, maxTokens: 6000 },
      );
      html = extractHtml(reply);
    } catch {
      /* 下面统一报错 */
    }
  }

  if (!html) {
    addMessage({
      conversationId: plan.conversationId,
      authorType: 'agent',
      authorId: agent.id,
      role: 'assistant',
      text: `实现失败：没有生成 HTML 产物。${modeNote}`,
    });
    executionRuns.set(plan.planId, 'failed');
    return;
  }

  const artifact = saveArtifact(plan.conversationId, plan.planId, plan.title, html);
  if (!changedFiles.length) {
    changedFiles = [{
      name: artifact.name,
      path: artifact.name,
      size: artifact.size,
      content: html.slice(0, 20_000),
      truncated: html.length > 20_000,
    }];
  }
  addMessage({
    conversationId: plan.conversationId,
    authorType: 'agent',
    authorId: agent.id,
    role: 'assistant',
    text: `实现完成：${plan.title}${modeNote ? `\n${modeNote}` : ''}`,
    parts: [
      { type: 'artifact', ...artifact },
      { type: 'file-changes', files: changedFiles },
    ],
  });

  // 其他智能体评审
  if (cfg?.apiKey) {
    const reviewers = conv.members
      .filter((m) => m.memberType === 'agent' && m.memberId !== agent.id && !m.muted)
      .slice(0, 3);
    for (const reviewer of reviewers) {
      const a = getAgent(reviewer.memberId);
      if (!a) continue;
      try {
        const review = await completeChat(
          cfg,
          [
            {
              role: 'system',
              content: [
                `你是${a.name}，${a.role}。`,
                a.systemPrompt,
                '你在评审一个刚完成的页面实现。只代表自己，给出一句明确结论和一个具体问题或可上线判断，不超过 80 字。',
              ].join('\n'),
            },
            {
              role: 'user',
              content: `任务：${plan.title}\n\n实现代码（截断）：\n${html.slice(0, 5000)}\n\n请评审。`,
            },
          ],
          { temperature: 0.35, maxTokens: 220 },
        );
        if (review.trim()) {
          addMessage({
            conversationId: plan.conversationId,
            authorType: 'agent',
            authorId: a.id,
            role: 'assistant',
            text: review.trim(),
          });
        }
      } catch {
        /* 单个评审失败不影响其他 */
      }
    }
  }

  // @ 所有真人做最终评审
  const humans = conv.members.filter((m) => m.memberType === 'human');
  if (humans.length) {
    const mentions = humans.map((h) => `@${h.name}`).join(' ');
    addMessage({
      conversationId: plan.conversationId,
      authorType: 'agent',
      authorId: agent.id,
      role: 'assistant',
      text: `${mentions} 实现已经完成，请评审。产物：${artifact.url}`,
    });
    for (const h of humans) {
      const human = getHuman(h.memberId);
      if (human?.simulated) void scheduleSimulatedReply(plan.conversationId, human.id, Date.now());
    }
  }

  executionRuns.set(plan.planId, 'done');
}

app.post('/api/executions/start', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  const plan: ExecutionPlanPart = {
    type: 'execution-plan',
    planId: String(b?.planId ?? ''),
    conversationId: String(b?.conversationId ?? ''),
    agentId: String(b?.agentId ?? ''),
    agentName: String(b?.agentName ?? ''),
    agentRole: String(b?.agentRole ?? ''),
    agentColor: String(b?.agentColor ?? ''),
    title: String(b?.title ?? ''),
    htmlName: String(b?.htmlName ?? ''),
    sourceMessageId: String(b?.sourceMessageId ?? ''),
  };
  if (!plan.planId || !plan.conversationId || !plan.agentId || !plan.sourceMessageId) {
    return c.json({ ok: false, error: '缺少执行计划参数' }, 400);
  }
  if (!getConversation(plan.conversationId) || !getAgent(plan.agentId)) {
    return c.json({ ok: false, error: '会话或智能体不存在' }, 404);
  }
  const status = executionRuns.get(plan.planId);
  if (status === 'running' || status === 'done') {
    return c.json({ ok: false, error: status === 'running' ? '这个任务已经在执行了' : '这个任务已经完成' }, 409);
  }
  void runExecution(plan, b?.allowTools === true);
  return c.json({ ok: true });
});

/** 预览实现产物：CSP sandbox 隔离，避免页面拿到 S-BOT 的同源权限 */
app.get('/api/artifacts/:convId/:file', (c) => {
  const convId = c.req.param('convId').replace(/[^a-zA-Z0-9_-]/g, '');
  const file = basename(c.req.param('file')).replace(/[^a-zA-Z0-9_.-]/g, '');
  if (!/\.html?$/i.test(file)) return c.json({ error: 'not found' }, 404);
  const path = join(artifactRoot, convId, file);
  if (!existsSync(path)) return c.json({ error: 'not found' }, 404);
  c.header('Content-Security-Policy', "sandbox allow-scripts allow-forms allow-popups");
  c.header('Cache-Control', 'no-store');
  return c.html(readFileSync(path, 'utf8'));
});

app.post('/api/conversations/:id/messages', async (c) => {
  const id = c.req.param('id');
  const conv = getConversation(id);
  if (!conv) return c.json({ error: 'conversation not found' }, 404);

  const body = await c.req.json().catch(() => ({} as any));
  const text = String(body?.text ?? '').trim();
  const parts = Array.isArray(body?.parts) ? body.parts : [];
  if (!text && parts.length === 0) return c.json({ error: 'text required' }, 400);

  const history = listMessages(id, 20)
    .filter((m) => m.status === 'done' && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => {
      const extra = m.authorType === 'user' ? attachmentText(m.parts, 2500) : '';
      return {
        role: m.role as 'user' | 'assistant',
        content: [m.text, extra].filter(Boolean).join('\n\n').slice(0, 12_000),
      };
    });

  const uid = c.req.header('x-sbot-user') || null;
  const author = uid ? getHuman(uid) : null;
  const userMessage = addMessage({
    conversationId: id,
    authorType: uid ? 'human' : 'user',
    authorId: uid,
    authorName: author?.name ?? null,
    authorColor: author?.color ?? null,
    authorInitial: author?.initial ?? null,
    role: 'user',
    text,
    parts,
  });

  // 真人回复正在软等待的那条发言：让原来的 run 继续，避免再起一轮重复回复
  const pendingWait = findHumanWaitForConversation(id);
  const isWaitedHuman = !!pendingWait && !!uid && pendingWait.humanId === uid;
  if (isWaitedHuman) pendingWait!.resolve('reply');
  const suppressRun = isWaitedHuman;

  // 用户直接 @ 模拟真人：稍后自动回一句
  for (const m of humansMentioned(text, conv)) {
    const h = getHuman(m.memberId);
    if (h?.simulated) void scheduleSimulatedReply(id, h.id, Date.now());
  }

  // 和模拟真人的单聊：不用 @，发消息就回
  if (conv.type === 'dm') {
    const hm = conv.members.find((m) => m.memberType === 'human');
    const h = hm ? getHuman(hm.memberId) : null;
    if (h?.simulated) void scheduleSimulatedReply(id, h.id, Date.now());
  }

  const targets = suppressRun ? [] : pickTargets(conv, text);
  // 群聊还没有任务时，把第一个议题理解成任务并绑定
  let autoTask: ReturnType<typeof createTask> | null = null;
  if (conv.type === 'group' && !suppressRun && text.trim()) {
    const existing = tasksForConversation(id).length;
    const prior = listMessages(id, 100).filter((m) => m.authorType !== 'system').length;
    if (!existing && prior <= 3) {
      try {
        autoTask = await inferTaskFromTopic(id, textWithAttachments(text, parts), author?.name ?? '我');
      } catch {
        autoTask = null;
      }
    }
  }

  const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const promptText = textWithAttachments(text, parts);
  const defaultModel = getDefaultModel();
  const fallback = toConfig(defaultModel);
  const runtimeMode = (process.env.SBOT_RUNTIME ?? 'auto').toLowerCase();
  const wantsOpencode =
    runtimeMode !== 'llm' &&
    runtimeMode !== 'mock' &&
    !!defaultModel?.apiKey &&
    !!defaultModel?.baseUrl;

  return streamSSE(c, async (stream) => {
    let aborted = false;
    const abortCtl = new AbortController();
    stream.onAbort(() => {
      aborted = true;
      abortCtl.abort();
      resolveHumanWait(runId, 'skip');
    });

    let opencodeOn = false;
    if (wantsOpencode) {
      try {
        opencodeOn = await ensureOpencode(defaultModel!);
      } catch {
        opencodeOn = false;
      }
    }

    await stream.writeSSE({
      event: 'run.start',
      data: JSON.stringify({
        runId,
        userMessageId: userMessage.id,
        conversationId: id,
        targets,
        runtime: opencodeOn ? 'opencode' : fallback ? 'llm' : 'mock',
      }),
    });

    // 群聊如果配了聊天逻辑图，按图执行
    if (autoTask) {
      await stream.writeSSE({
        event: 'task.bound',
        data: JSON.stringify({ task: autoTask }),
      });
    }

    const workflow = conv.type === 'group' && !suppressRun ? getWorkflow(id) : null;
    if (workflow?.enabled) {
      await runWorkflow({
        conv,
        graph: workflow,
        text: promptText,
        userMessageAt: userMessage.createdAt,
        userMessageId: userMessage.id,
        history,
        defaultModel,
        opencodeOn,
        aborted: () => aborted,
        signal: abortCtl.signal,
        stream,
      });

      if (!aborted) {
        const pendingTask = tasksForConversation(id, 'todo')[0];
        if (pendingTask) {
          try {
            if (await judgeTaskDone(pendingTask, defaultModel)) {
              updateTask(pendingTask.id, { status: 'awaiting' });
              const authorId = targets[targets.length - 1] ?? conv.members.find((m) => m.memberType === 'agent')?.memberId ?? null;
              const confirmMessage = addMessage({
                conversationId: id,
                authorType: 'agent',
                authorId,
                role: 'assistant',
                text: `任务「${pendingTask.title}」看起来已经完成，@${pendingTask.creatorName === '我' ? '你' : pendingTask.creatorName} 确认一下？`,
                parts: [{ type: 'task-confirm', taskId: pendingTask.id, title: pendingTask.title }],
              });
              await stream.writeSSE({
                event: 'task.confirm',
                data: JSON.stringify({ message: confirmMessage, task: getTask(pendingTask.id) }),
              });
            }
          } catch {
            /* 判断失败不影响主流程 */
          }
        }
      }

      await stream.writeSSE({ event: 'run.end', data: '{}' });
      return;
    }

    const produced: Array<ReturnType<typeof addMessage>> = [];
    const maxRounds = conv.maxTurns === 0 ? 2 : 1;
    let stopDiscussion = false;

    for (let round = 0; round < maxRounds && !stopDiscussion; round++) {
      const roundText = round === 0
        ? promptText
        : `${promptText}\n\n这是第 ${round + 1} 轮讨论。请直接回应其他智能体的观点：同意什么、反对什么、补充依据，不要重复上一轮。`;

      for (const agentId of targets) {
        if (aborted || stopDiscussion) break;
        const agent = getAgent(agentId);
        if (!agent) continue;

      // 绑定了知识库的智能体，先检索（超时/失败都不影响发言）
      let citations: Array<{ n: number; kb: string; doc: string; score: number; text: string }> = [];
      if (agent.kbIds.length) {
        await stream.writeSSE({ event: 'retrieval.start', data: JSON.stringify({ agentId }) });
        citations = await retrieve(text, agent.kbIds);
        await stream.writeSSE({ event: 'retrieval.done', data: JSON.stringify({ agentId, count: citations.length }) });
      }

      const picked =
        (conv.modelId ? getModel(conv.modelId) : null) ||
        (agent.modelId ? getModel(agent.modelId) : null) ||
        defaultModel;

      const messageId = `tmp_${agentId}_${Date.now().toString(36)}`;
      await stream.writeSSE({
        event: 'message.start',
        data: JSON.stringify({
          id: messageId,
          agentId,
          name: agent.name,
          role: agent.role,
          color: agent.color,
          initial: agent.initial,
          model: opencodeOn ? `opencode · ${picked?.name ?? ''}` : (picked?.name ?? 'mock'),
        }),
      });

      let full = '';
      let failed = false;
      let usedOpencode = false;
      const tools: Array<{ type: 'tool'; toolId: string; name: string; detail: string; status: string }> = [];

      if (opencodeOn) {
        try {
          const sess = await ensureSession(id, agent);
          usedOpencode = true;
          const prompt = buildOpencodePrompt(conv, agent, roundText, userMessage.createdAt, citations);

          for await (const ev of runAgent({ sessionId: sess.sessionId, prompt, signal: abortCtl.signal })) {
            if (aborted) break;
            if (ev.type === 'delta') {
              full += ev.text;
              await stream.writeSSE({ event: 'message.delta', data: JSON.stringify({ id: messageId, delta: ev.text }) });
            } else if (ev.type === 'tool') {
              const existing = tools.find((t) => t.toolId === ev.id);
              if (existing) {
                if (ev.name) existing.name = ev.name;
                if (ev.detail) existing.detail = ev.detail;
              } else {
                tools.push({ type: 'tool', toolId: ev.id, name: ev.name, detail: ev.detail ?? '', status: 'running' });
              }
              await stream.writeSSE({
                event: 'tool',
                data: JSON.stringify({
                  id: messageId,
                  toolId: ev.id,
                  name: ev.name,
                  detail: ev.detail ?? '',
                  status: 'running',
                }),
              });
            } else if (ev.type === 'tool-end') {
              const existing = tools.find((t) => t.toolId === ev.id);
              if (existing) existing.status = ev.ok ? 'ok' : 'failed';
              await stream.writeSSE({
                event: 'tool',
                data: JSON.stringify({ id: messageId, toolId: ev.id, status: ev.ok ? 'ok' : 'failed' }),
              });
            } else if (ev.type === 'permission') {
              await stream.writeSSE({
                event: 'permission.ask',
                data: JSON.stringify({
                  agentId,
                  messageId,
                  requestID: ev.requestID,
                  action: ev.action,
                  resources: ev.resources,
                }),
              });
            } else if (ev.type === 'error') {
              if (!full) {
                // 一个字都没出就失败 → 回退到普通模型
                usedOpencode = false;
                failed = false;
              } else {
                failed = true;
                await stream.writeSSE({ event: 'message.error', data: JSON.stringify({ id: messageId, error: ev.message }) });
              }
              break;
            } else if (ev.type === 'done') {
              break;
            }
          }

          touchAgentSession(id, agentId, Date.now());
        } catch (err) {
          if (!full && !aborted) {
            // 还没吐字就失败 → 回退到普通模型
            usedOpencode = false;
          } else {
            failed = true;
            await stream.writeSSE({ event: 'message.error', data: JSON.stringify({ id: messageId, error: String(err) }) });
          }
        }
      }

      if (!usedOpencode) {
        try {
          for await (const delta of generateReply(
            {
              agentName: agent.name,
              agentRole: agent.role,
              systemPrompt: agent.systemPrompt,
              skills: agent.skills,
              history,
              userText: roundText,
              modelConfig: picked && picked.id !== defaultModel?.id ? toConfig(picked) : fallback,
              references: citations.length
                ? citations.map((c) => `[${c.n}] ${c.doc}：${c.text}`).join('\n')
                : undefined,
              humanNames: targets.indexOf(agentId) === 0
                ? conv.members
                    .filter((m) => m.memberType === 'human')
                    .map((m) => ({ name: m.name, simulated: !!getHuman(m.memberId)?.simulated }))
                    .sort((a, b) => Number(b.simulated) - Number(a.simulated))
                    .map((m) => m.name)
                : undefined,
            },
            fallback,
          )) {
            if (aborted) break;
            full += delta;
            await stream.writeSSE({ event: 'message.delta', data: JSON.stringify({ id: messageId, delta }) });
          }
        } catch (err) {
          failed = true;
          if (!full) full = '这次没生成成功，稍后再试。';
          await stream.writeSSE({ event: 'message.error', data: JSON.stringify({ id: messageId, error: String(err) }) });
        }
      }

      // 一个字都没出就被停掉：不留空消息
      if (aborted && !full) continue;
      if (!full) {
        failed = true;
        full = '这次没生成成功，稍后再试。';
      }

      if (citations.length && !/\[\d+\]/.test(full)) {
        full += ' ' + citations.map((c) => `[${c.n}]`).join('');
      }
      const messageParts = [
        ...tools,
        ...citations.map((c) => ({ type: 'citation', ...c })),
      ];

      const saved = addMessage({
        conversationId: id,
        authorType: 'agent',
        authorId: agentId,
        role: 'assistant',
        text: full,
        modelId: picked?.id ?? null,
        status: failed ? 'error' : aborted ? 'interrupted' : 'done',
        parts: messageParts.length ? messageParts : undefined,
      });
      produced.push(saved);
      if (!failed) history.push({ role: 'assistant', content: full });

      await stream.writeSSE({
        event: 'message.end',
        data: JSON.stringify({
          id: messageId,
          agentId,
          savedId: saved.id,
          text: full,
          createdAt: saved.createdAt,
          status: saved.status,
          parts: messageParts,
        }),
      });

      // 智能体 @ 到真人：暂停后面的智能体，等真人回复 / 继续 / 跳过
      if (!aborted) {
        const decision = await maybeWaitForHuman(runId, conv, full, targets.length - targets.indexOf(agentId) - 1);
        if (decision === 'skip') {
          stopDiscussion = true;
          break;
        }
      }
      }
    }

    // 无限制模式：多轮讨论后由主持人智能体给出结论
    if (!aborted && conv.maxTurns === 0 && produced.length >= 2) {
      await postDiscussionConclusion(conv, produced, defaultModel);
    }

    // 技术评审结束后：如果用户上传了 HTML 并要“实现”，给一张执行卡片
    if (!aborted && conv.type === 'group') {
      const planPart = makeExecutionPlan(conv, text, parts, userMessage.id);
      if (planPart) {
        const card = addMessage({
          conversationId: id,
          authorType: 'agent',
          authorId: planPart.agentId,
          role: 'assistant',
          text: '技术评审结束，确认后可以开始实现。',
          parts: [planPart],
        });
        await stream.writeSSE({ event: 'execution.plan', data: JSON.stringify({ message: card }) });
      }
    }

    if (!aborted && targets.length) {
      const pendingTask = tasksForConversation(id, 'todo')[0];
      if (pendingTask) {
        try {
          if (await judgeTaskDone(pendingTask, defaultModel)) {
            updateTask(pendingTask.id, { status: 'awaiting' });
            const authorId = targets[targets.length - 1] ?? conv.members[0]?.memberId ?? null;
            const confirmMessage = addMessage({
              conversationId: id,
              authorType: 'agent',
              authorId,
              role: 'assistant',
              text: `任务「${pendingTask.title}」看起来已经完成，@${pendingTask.creatorName === '我' ? '你' : pendingTask.creatorName} 确认一下？`,
              parts: [{ type: 'task-confirm', taskId: pendingTask.id, title: pendingTask.title }],
            });
            await stream.writeSSE({
              event: 'task.confirm',
              data: JSON.stringify({ message: confirmMessage, task: getTask(pendingTask.id) }),
            });
          }
        } catch {
          /* 判断失败不影响主流程 */
        }
      }
    }

    await stream.writeSSE({ event: 'run.end', data: '{}' });
  });
});

/** 软等待：手动继续 / 跳过 */
app.post('/api/runs/:runId/resume', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  const action = b?.action === 'skip' ? 'skip' : 'continue';
  const ok = resolveHumanWait(c.req.param('runId'), action);
  if (!ok) return c.json({ ok: false, error: 'wait not found' }, 404);
  return c.json({ ok: true, action });
});

/** 软等待：以被 @ 真人的身份直接回一句，然后让原来的 run 继续 */
app.post('/api/runs/:runId/reply', async (c) => {
  const runId = c.req.param('runId');
  const entry = humanWaits.get(runId);
  if (!entry) return c.json({ error: 'wait not found' }, 404);

  const b = await c.req.json().catch(() => ({} as any));
  const text = String(b?.text ?? '').trim();
  if (!text) return c.json({ error: 'text required' }, 400);

  const human = getHuman(entry.humanId);
  if (!human) return c.json({ error: 'human not found' }, 404);

  const message = addMessage({
    conversationId: entry.conversationId,
    authorType: 'human',
    authorId: human.id,
    authorName: human.name,
    authorColor: human.color,
    authorInitial: human.initial,
    role: 'user',
    text,
  });
  resolveHumanWait(runId, 'reply');
  return c.json({ data: message });
});

const port = Number(process.env.PORT ?? 8787);
setLanPort(port);

const staticDir = process.env.SBOT_STATIC_DIR;
if (staticDir) {
  app.use('*', serveStatic({ root: staticDir }));
}

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[s-bot] server  http://localhost:${info.port}`);
  if (staticDir) console.log(`[s-bot] static  ${staticDir}`);
});

for (const sig of ['exit', 'SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    shutdownOpencode();
    if (sig !== 'exit') process.exit(0);
  });
}
