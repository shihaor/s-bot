import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import type { ChatIntro, Conversation } from '@sbot/shared';
import {
  addMember,
  addMessage,
  clearAgentSessions,
  createAgent,
  createGroup,
  createModel,
  createTask,
  deleteAgent,
  deleteConversation,
  deleteModel,
  deleteTask,
  ensureDm,
  getAgent,
  getConversation,
  getDefaultModel,
  getModel,
  getSettings,
  getTask,
  getHuman,
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
import { generateReply, type ModelConfig } from './runtime.js';
import {
  ensureSession,
  ensureStarted as ensureOpencode,
  getStatus as getOpencodeStatus,
  importableModels,
  installFromZip,
  resetBinaryCache,
  resolvePermission,
  runAgent,
  shutdown as shutdownOpencode,
} from './opencode.js';
import { listDatasets, ragflowStatus, retrieve } from './ragflow.js';
import { broadcast, bus } from './events.js';

const app = new Hono();
app.use('*', cors());

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

app.get('/api/opencode/importable', (c) => c.json({ data: importableModels() }));

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

/** 原型级登录：按名字建/找真人，不做密码校验；身份通过 x-sbot-user 头传递 */
app.post('/api/login', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
  const name = String(b?.name ?? '').trim();
  if (!name) return c.json({ error: 'name required' }, 400);
  const human = upsertHuman({ name, role: String(b?.role ?? '') });
  return c.json({ data: human });
});

app.get('/api/humans', (c) => c.json({ data: listHumans() }));

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
  return c.json({ data: getModel(id) });
});

app.delete('/api/models/:id', (c) => {
  const id = c.req.param('id');
  if (!getModel(id)) return c.json({ error: 'model not found' }, 404);
  deleteModel(id);
  return c.json({ ok: true });
});

app.post('/api/models/:id/default', (c) => {
  const id = c.req.param('id');
  if (!getModel(id)) return c.json({ error: 'model not found' }, 404);
  setDefaultModel(id);
  return c.json({ ok: true });
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
  return c.json({ data: createGroup(title, memberIds) }, 201);
});

app.post('/api/conversations/dm', async (c) => {
  const b = await c.req.json().catch(() => ({} as any));
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
  return c.json({ data: getConversation(id) });
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
  removeMember(id, agentId);
  addMessage({
    conversationId: id,
    authorType: 'system',
    authorId: null,
    role: 'system',
    text: `${agent?.name ?? '成员'} 被移出群聊`,
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

  const who =
    conv.type === 'dm'
      ? (() => {
          const m = conv.members[0];
          const a = m ? getAgent(m.memberId) : null;
          const skills = (a?.skills ?? []).slice(0, 3).map((s) => `，擅长${s}`).join('');
          return `${a?.name ?? m?.name ?? '智能体'}（${a?.role ?? m?.role ?? ''}${skills}）`;
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
            content: `用户第一次${conv.type === 'dm' ? '和这个智能体单聊' : '进入这个群聊'}：${who}。生成 3 条用户最可能发的问题或任务。`,
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

async function judgeTaskDone(task: { id: string; title: string; conversationId: string | null; createdAt: number }, model: ReturnType<typeof getDefaultModel>): Promise<boolean> {
  if (!task.conversationId) return false;
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
  return agents.slice(0, Math.min(conv.maxTurns || 3, agents.length)).map((a) => a.memberId);
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

  const persona = [
    `你是${agent.name}，${agent.role}。`,
    agent.systemPrompt,
    '你在一个多人会话里，成员包括用户和其他智能体。只代表你自己发言，不要替别人说话，不要在开头加自己的名字。',
    '回答简短具体，控制在 120 字以内。',
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
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.text }));

  const userMessage = addMessage({
    conversationId: id,
    authorType: c.req.header('x-sbot-user') ? 'human' : 'user',
    authorId: c.req.header('x-sbot-user') || null,
    authorName: (() => {
      const uid = c.req.header('x-sbot-user');
      return uid ? getHuman(uid)?.name ?? null : null;
    })(),
    authorColor: (() => {
      const uid = c.req.header('x-sbot-user');
      return uid ? getHuman(uid)?.color ?? null : null;
    })(),
    authorInitial: (() => {
      const uid = c.req.header('x-sbot-user');
      return uid ? getHuman(uid)?.initial ?? null : null;
    })(),
    role: 'user',
    text,
    parts,
  });

  const targets = pickTargets(conv, text);
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
        userMessageId: userMessage.id,
        conversationId: id,
        targets,
        runtime: opencodeOn ? 'opencode' : fallback ? 'llm' : 'mock',
      }),
    });

    for (const agentId of targets) {
      if (aborted) break;
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
          const prompt = buildOpencodePrompt(conv, agent, text, userMessage.createdAt, citations);

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
              userText: text,
              modelConfig: picked && picked.id !== defaultModel?.id ? toConfig(picked) : fallback,
              references: citations.length
                ? citations.map((c) => `[${c.n}] ${c.doc}：${c.text}`).join('\n')
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
    }

    if (!aborted) {
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

const port = Number(process.env.PORT ?? 8787);

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
