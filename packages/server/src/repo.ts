import { db } from './db.js';
import { broadcast } from './events.js';
import type { Agent, Conversation, Member, Message, ModelInfo, Task } from '@sbot/shared';

const mapAgent = (r: any): Agent => ({
  id: r.id,
  name: r.name,
  role: r.role,
  color: r.color,
  initial: r.initial,
  modelId: r.model_id ?? null,
  systemPrompt: r.system_prompt ?? '',
  description: r.description ?? '',
  visibility: r.visibility ?? 'team',
  ownerId: r.owner_id ?? null,
  tools: JSON.parse(r.tools || '{}'),
  skills: JSON.parse(r.skills || '[]'),
  kbIds: JSON.parse(r.kb_ids || '[]'),
  createdAt: r.created_at,
});

const mapMessage = (r: any): Message => ({
  id: r.id,
  conversationId: r.conversation_id,
  authorType: r.author_type,
  authorId: r.author_id ?? null,
  authorName: r.author_name ?? null,
  authorColor: r.author_color ?? null,
  authorInitial: r.author_initial ?? null,
  role: r.role,
  text: r.text,
  parts: JSON.parse(r.parts || '[]'),
  modelId: r.model_id ?? null,
  status: r.status,
  createdAt: r.created_at,
});

export function listAgents(): Agent[] {
  return db.prepare('SELECT * FROM agents ORDER BY created_at ASC').all().map(mapAgent);
}

export function getAgent(id: string): Agent | null {
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as any;
  return row ? mapAgent(row) : null;
}

function membersOf(conversationId: string): Member[] {
  const rows = db
    .prepare(
      `SELECT m.conversation_id, m.member_type, m.member_id, m.muted, m.talk,
              COALESCE(a.name, h.name, m.member_id) AS name,
              COALESCE(a.role, h.role, '') AS role,
              COALESCE(a.color, h.color, '#6B7385') AS color,
              COALESCE(a.initial, h.initial, '人') AS initial
         FROM conversation_members m
         LEFT JOIN agents a ON a.id = m.member_id
         LEFT JOIN humans h ON h.id = m.member_id
        WHERE m.conversation_id = ?
        ORDER BY m.rowid ASC`,
    )
    .all(conversationId) as any[];

  return rows.map((r) => ({
    conversationId: r.conversation_id,
    memberId: r.member_id,
    memberType: r.member_type,
    name: r.name,
    role: r.role,
    color: r.color,
    initial: r.initial,
    muted: !!r.muted,
    talk: r.talk,
    online: true,
  }));
}

function lastMessageOf(conversationId: string) {
  const r = db
    .prepare(
      'SELECT text, author_type, author_id, author_name, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1',
    )
    .get(conversationId) as any;
  if (!r || !r.text) return null;
  let authorName = '我';
  if (r.author_type === 'agent' && r.author_id) authorName = getAgent(r.author_id)?.name ?? '智能体';
  else if (r.author_type === 'human') authorName = r.author_name ?? getHuman(r.author_id ?? '')?.name ?? '同事';
  return { text: r.text, authorName, at: r.created_at };
}

const mapConversation = (r: any, withMembers = true): Conversation => ({
  id: r.id,
  type: r.type,
  title: r.title,
  modelId: r.model_id ?? null,
  pinned: !!r.pinned,
  muted: !!r.muted,
  autoReply: r.auto_reply === undefined ? true : !!r.auto_reply,
  supModel: r.sup_model ?? null,
  maxTurns: r.max_turns ?? 3,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  members: withMembers ? membersOf(r.id) : [],
  lastMessage: lastMessageOf(r.id),
});

export function listConversations(): Conversation[] {
  const rows = db
    .prepare('SELECT * FROM conversations ORDER BY pinned DESC, updated_at DESC')
    .all() as any[];
  return rows.map((r) => mapConversation(r));
}

export function getConversation(id: string): Conversation | null {
  const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as any;
  return row ? mapConversation(row) : null;
}

export function listMessages(conversationId: string, limit = 200): Message[] {
  const rows = db
    .prepare(
      'SELECT * FROM (SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at ASC',
    )
    .all(conversationId, limit) as any[];
  return rows.map(mapMessage);
}

let seq = 0;
export function addMessage(input: {
  conversationId: string;
  authorType: Message['authorType'];
  authorId: string | null;
  authorName?: string | null;
  authorColor?: string | null;
  authorInitial?: string | null;
  role: Message['role'];
  text: string;
  modelId?: string | null;
  status?: Message['status'];
  parts?: unknown[];
  createdAt?: number;
}): Message {
  const id = `msg_${Date.now().toString(36)}_${(seq++).toString(36)}`;
  const createdAt = input.createdAt ?? Date.now();
  db.prepare(
    `INSERT INTO messages (id, conversation_id, author_type, author_id, author_name, author_color, author_initial, role, text, parts, model_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.conversationId,
    input.authorType,
    input.authorId,
    input.authorName ?? null,
    input.authorColor ?? null,
    input.authorInitial ?? null,
    input.role,
    input.text,
    JSON.stringify(input.parts ?? []),
    input.modelId ?? null,
    input.status ?? 'done',
    createdAt,
  );
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Math.max(createdAt, Date.now()), input.conversationId);
  broadcast(
    'message',
    {
      id,
      conversationId: input.conversationId,
      authorType: input.authorType,
      authorId: input.authorId,
      authorName: input.authorName ?? null,
      text: input.text,
      createdAt,
    },
    input.conversationId,
  );
  return {
    id,
    conversationId: input.conversationId,
    authorType: input.authorType,
    authorId: input.authorId,
    authorName: input.authorName ?? null,
    authorColor: input.authorColor ?? null,
    authorInitial: input.authorInitial ?? null,
    role: input.role,
    text: input.text,
    parts: input.parts ?? [],
    modelId: input.modelId ?? null,
    status: input.status ?? 'done',
    createdAt,
  };
}

export function createAgent(input: {
  name: string;
  role: string;
  color: string;
  initial: string;
  systemPrompt: string;
  description?: string;
  visibility?: 'team' | 'private';
  tools?: { read?: boolean; web?: boolean; shell?: boolean };
  modelId?: string | null;
  skills: string[];
  kbIds?: string[];
  ownerId?: string | null;
}): Agent {
  const id = `ag_${Date.now().toString(36)}`;
  const createdAt = Date.now();
  db.prepare(
    'INSERT INTO agents (id, name, role, color, initial, model_id, system_prompt, description, visibility, tools, skills, kb_ids, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    input.name,
    input.role,
    input.color,
    input.initial,
    input.modelId ?? null,
    input.systemPrompt,
    input.description ?? '',
    input.visibility ?? 'team',
    JSON.stringify(input.tools ?? {}),
    JSON.stringify(input.skills),
    JSON.stringify(input.kbIds ?? []),
    input.ownerId ?? null,
    createdAt,
  );
  return getAgent(id)!;
}

export function updateAgent(
  id: string,
  patch: {
    name?: string;
    role?: string;
    color?: string;
    initial?: string;
    systemPrompt?: string;
    description?: string;
    visibility?: 'team' | 'private';
    tools?: { read?: boolean; web?: boolean; shell?: boolean };
    modelId?: string | null;
    skills?: string[];
    kbIds?: string[];
  },
): void {
  const map: Record<string, unknown> = {
    name: patch.name,
    role: patch.role,
    color: patch.color,
    initial: patch.initial,
    system_prompt: patch.systemPrompt,
    description: patch.description,
    visibility: patch.visibility,
    tools: patch.tools === undefined ? undefined : JSON.stringify(patch.tools),
    model_id: patch.modelId,
    skills: patch.skills === undefined ? undefined : JSON.stringify(patch.skills),
    kb_ids: patch.kbIds === undefined ? undefined : JSON.stringify(patch.kbIds),
  };
  const fields: string[] = [];
  const values: Array<string | number | null> = [];
  for (const [col, val] of Object.entries(map)) {
    if (val !== undefined) {
      fields.push(`${col} = ?`);
      values.push(val as string | number | null);
    }
  }
  if (!fields.length) return;
  values.push(id);
  db.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteAgent(id: string): void {
  db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  db.prepare('DELETE FROM conversation_members WHERE member_id = ?').run(id);
}

/* ---------- 模型 ---------- */

const mapModel = (r: any): ModelInfo => ({
  id: r.id,
  name: r.name,
  model: r.model,
  baseUrl: r.base_url,
  apiKey: r.api_key ?? '',
  tools: !!r.tools,
  stream: !!r.stream,
  isDefault: !!r.is_default,
  createdAt: r.created_at,
});

export function listModels(): ModelInfo[] {
  return db.prepare('SELECT * FROM models ORDER BY is_default DESC, created_at ASC').all().map(mapModel);
}

export function getModel(id: string): ModelInfo | null {
  const row = db.prepare('SELECT * FROM models WHERE id = ?').get(id) as any;
  return row ? mapModel(row) : null;
}

export function getDefaultModel(): ModelInfo | null {
  const row = db.prepare('SELECT * FROM models ORDER BY is_default DESC, created_at ASC LIMIT 1').get() as any;
  return row ? mapModel(row) : null;
}

export function createModel(input: {
  name: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  tools?: boolean;
  stream?: boolean;
}): ModelInfo {
  const id = `m_${Date.now().toString(36)}`;
  const isFirst = (db.prepare('SELECT count(*) AS c FROM models').get() as { c: number }).c === 0;
  db.prepare(
    'INSERT INTO models (id, name, model, base_url, api_key, tools, stream, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, input.name, input.model, input.baseUrl, input.apiKey ?? '', input.tools === false ? 0 : 1, input.stream === false ? 0 : 1, isFirst ? 1 : 0, Date.now());
  return getModel(id)!;
}

export function updateModel(
  id: string,
  patch: { name?: string; model?: string; baseUrl?: string; apiKey?: string; tools?: boolean; stream?: boolean },
): void {
  const map: Record<string, unknown> = {
    name: patch.name,
    model: patch.model,
    base_url: patch.baseUrl,
    api_key: patch.apiKey,
    tools: patch.tools === undefined ? undefined : patch.tools ? 1 : 0,
    stream: patch.stream === undefined ? undefined : patch.stream ? 1 : 0,
  };
  const fields: string[] = [];
  const values: Array<string | number | null> = [];
  for (const [col, val] of Object.entries(map)) {
    if (val !== undefined) {
      fields.push(`${col} = ?`);
      values.push(val as string | number | null);
    }
  }
  if (!fields.length) return;
  values.push(id);
  db.prepare(`UPDATE models SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteModel(id: string): void {
  db.prepare('DELETE FROM models WHERE id = ?').run(id);
  db.prepare('UPDATE agents SET model_id = NULL WHERE model_id = ?').run(id);
  db.prepare('UPDATE conversations SET model_id = NULL WHERE model_id = ?').run(id);
  const remaining = db.prepare('SELECT count(*) AS c FROM models WHERE is_default = 1').get() as { c: number };
  if (remaining.c === 0) {
    const first = db.prepare('SELECT id FROM models ORDER BY created_at ASC LIMIT 1').get() as { id: string } | undefined;
    if (first) db.prepare('UPDATE models SET is_default = 1 WHERE id = ?').run(first.id);
  }
}

export function setDefaultModel(id: string): void {
  db.prepare('UPDATE models SET is_default = 0').run();
  db.prepare('UPDATE models SET is_default = 1 WHERE id = ?').run(id);
}

/* ---------- 成员 ---------- */

export function updateMember(conversationId: string, agentId: string, patch: { muted?: boolean; talk?: string }): void {
  if (patch.muted !== undefined) {
    db.prepare('UPDATE conversation_members SET muted = ? WHERE conversation_id = ? AND member_id = ?').run(
      patch.muted ? 1 : 0,
      conversationId,
      agentId,
    );
  }
  if (patch.talk !== undefined) {
    db.prepare('UPDATE conversation_members SET talk = ? WHERE conversation_id = ? AND member_id = ?').run(
      patch.talk,
      conversationId,
      agentId,
    );
  }
}

export function createGroup(title: string, memberIds: string[]): Conversation {
  const id = `cv_g_${Date.now().toString(36)}`;
  const at = Date.now();
  db.prepare(
    'INSERT INTO conversations (id, type, title, model_id, pinned, muted, created_at, updated_at) VALUES (?, ?, ?, NULL, 0, 0, ?, ?)',
  ).run(id, 'group', title, at, at);
  for (const agentId of memberIds) addMember(id, agentId);
  const names = memberIds.map((m) => getAgent(m)?.name).filter(Boolean).join('、');
  addMessage({
    conversationId: id,
    authorType: 'system',
    authorId: null,
    role: 'system',
    text: `群聊已创建 · ${names} 已加入`,
  });
  return getConversation(id)!;
}

/* ---------- 任务 ---------- */

const mapTask = (r: any): Task => ({
  id: r.id,
  title: r.title,
  description: r.description ?? '',
  conversationId: r.conversation_id ?? null,
  creatorName: r.creator_name ?? '我',
  status: r.status,
  priority: r.priority,
  createdAt: r.created_at,
  completedAt: r.completed_at ?? null,
});

export function listTasks(): Task[] {
  return db
    .prepare("SELECT * FROM tasks ORDER BY CASE status WHEN 'done' THEN 1 ELSE 0 END, created_at DESC")
    .all()
    .map(mapTask);
}

export function getTask(id: string): Task | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
  return row ? mapTask(row) : null;
}

export function createTask(input: {
  title: string;
  description?: string;
  conversationId?: string | null;
  creatorName?: string;
  priority?: 'high' | 'mid' | 'low';
}): Task {
  const id = `task_${Date.now().toString(36)}`;
  db.prepare(
    'INSERT INTO tasks (id, title, description, conversation_id, creator_name, status, priority, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)',
  ).run(
    id,
    input.title,
    input.description ?? '',
    input.conversationId ?? null,
    input.creatorName ?? '我',
    'todo',
    input.priority ?? 'mid',
    Date.now(),
  );
  return getTask(id)!;
}

export function updateTask(
  id: string,
  patch: {
    title?: string;
    description?: string;
    conversationId?: string | null;
    priority?: string;
    status?: Task['status'];
  },
): void {
  const fields: string[] = [];
  const values: Array<string | number | null> = [];
  if (patch.title !== undefined) { fields.push('title = ?'); values.push(patch.title); }
  if (patch.description !== undefined) { fields.push('description = ?'); values.push(patch.description); }
  if (patch.conversationId !== undefined) { fields.push('conversation_id = ?'); values.push(patch.conversationId); }
  if (patch.priority !== undefined) { fields.push('priority = ?'); values.push(patch.priority); }
  if (patch.status !== undefined) {
    fields.push('status = ?');
    values.push(patch.status);
    fields.push('completed_at = ?');
    values.push(patch.status === 'done' ? Date.now() : null);
  }
  if (!fields.length) return;
  values.push(id);
  db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteTask(id: string): void {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
}

export function tasksForConversation(conversationId: string, status?: Task['status']): Task[] {
  const rows = status
    ? (db.prepare('SELECT * FROM tasks WHERE conversation_id = ? AND status = ? ORDER BY created_at DESC').all(conversationId, status) as any[])
    : (db.prepare('SELECT * FROM tasks WHERE conversation_id = ? ORDER BY created_at DESC').all(conversationId) as any[]);
  return rows.map(mapTask);
}

/* ---------- opencode 会话映射 ---------- */

export interface AgentSession {
  conversationId: string;
  agentId: string;
  sessionId: string;
  workspace: string;
  lastMessageAt: number;
  createdAt: number;
}

const mapAgentSession = (r: any): AgentSession => ({
  conversationId: r.conversation_id,
  agentId: r.agent_id,
  sessionId: r.session_id,
  workspace: r.workspace,
  lastMessageAt: r.last_message_at ?? 0,
  createdAt: r.created_at,
});

export function getAgentSession(conversationId: string, agentId: string): AgentSession | null {
  const row = db
    .prepare('SELECT * FROM agent_sessions WHERE conversation_id = ? AND agent_id = ?')
    .get(conversationId, agentId) as any;
  return row ? mapAgentSession(row) : null;
}

export function saveAgentSession(input: {
  conversationId: string;
  agentId: string;
  sessionId: string;
  workspace: string;
  lastMessageAt?: number;
}): void {
  db.prepare(
    `INSERT INTO agent_sessions (conversation_id, agent_id, session_id, workspace, last_message_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(conversation_id, agent_id) DO UPDATE SET
       session_id = excluded.session_id,
       workspace = excluded.workspace,
       last_message_at = excluded.last_message_at`,
  ).run(
    input.conversationId,
    input.agentId,
    input.sessionId,
    input.workspace,
    input.lastMessageAt ?? Date.now(),
    Date.now(),
  );
}

export function touchAgentSession(conversationId: string, agentId: string, lastMessageAt: number): void {
  db.prepare('UPDATE agent_sessions SET last_message_at = ? WHERE conversation_id = ? AND agent_id = ?')
    .run(lastMessageAt, conversationId, agentId);
}

export function clearAgentSessions(conversationId: string): void {
  db.prepare('DELETE FROM agent_sessions WHERE conversation_id = ?').run(conversationId);
}

export function ensureDm(agentId: string): Conversation {
  const existing = listConversations().find(
    (c) => c.type === 'dm' && c.members.some((m) => m.memberId === agentId),
  );
  if (existing) return existing;

  const agent = getAgent(agentId);
  if (!agent) throw new Error('agent not found');

  const id = `cv_dm_${agentId}`;
  const at = Date.now();
  db.prepare(
    'INSERT INTO conversations (id, type, title, model_id, pinned, muted, created_at, updated_at) VALUES (?, ?, ?, NULL, 0, 0, ?, ?)',
  ).run(id, 'dm', agent.name, at, at);
  db.prepare(
    "INSERT INTO conversation_members (conversation_id, member_type, member_id, muted, talk) VALUES (?, 'agent', ?, 0, 'normal')",
  ).run(id, agentId);

  return getConversation(id)!;
}

/* ---------- 设置 ---------- */

export interface AppSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  opencodeUrl: string;
  opencodeBin: string;
  ragflowBaseUrl: string;
  ragflowApiKey: string;
  ragflowEnabledKbs: string[];
}

export const DEFAULT_OPENCODE_URL = 'http://10.201.1.19:80/artifactory/installer/opencode/OpenCode.zip';
export const DEFAULT_RAGFLOW_URL = 'http://10.200.25.16:8080';

export function getSettings(): AppSettings {
  const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>;
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  let enabled: string[] = [];
  try {
    const parsed = JSON.parse(map.ragflow_enabled_kbs ?? '[]');
    if (Array.isArray(parsed)) enabled = parsed.map(String);
  } catch { /* ignore */ }
  return {
    baseUrl: map.llm_base_url ?? process.env.LLM_BASE_URL ?? '',
    apiKey: map.llm_api_key ?? process.env.LLM_API_KEY ?? '',
    model: map.llm_model ?? process.env.LLM_MODEL ?? 'deepseek-chat',
    opencodeUrl: map.opencode_url ?? DEFAULT_OPENCODE_URL,
    opencodeBin: map.opencode_bin ?? '',
    ragflowBaseUrl: map.ragflow_base_url ?? DEFAULT_RAGFLOW_URL,
    ragflowApiKey: map.ragflow_api_key ?? process.env.RAGFLOW_API_KEY ?? '',
    ragflowEnabledKbs: enabled,
  };
}

export function saveSettings(next: Partial<AppSettings>): void {
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  if (next.baseUrl !== undefined) stmt.run('llm_base_url', next.baseUrl);
  if (next.apiKey !== undefined) stmt.run('llm_api_key', next.apiKey);
  if (next.model !== undefined) stmt.run('llm_model', next.model);
  if (next.opencodeUrl !== undefined) stmt.run('opencode_url', next.opencodeUrl);
  if (next.opencodeBin !== undefined) stmt.run('opencode_bin', next.opencodeBin);
  if (next.ragflowBaseUrl !== undefined) stmt.run('ragflow_base_url', next.ragflowBaseUrl);
  if (next.ragflowApiKey !== undefined) stmt.run('ragflow_api_key', next.ragflowApiKey);
  if (next.ragflowEnabledKbs !== undefined) stmt.run('ragflow_enabled_kbs', JSON.stringify(next.ragflowEnabledKbs));
}

/* ---------- 会话维护 ---------- */

export function updateConversation(
  id: string,
  patch: {
    title?: string;
    pinned?: boolean;
    muted?: boolean;
    modelId?: string | null;
    autoReply?: boolean;
    supModel?: string | null;
    maxTurns?: number;
  },
): void {
  const fields: string[] = [];
  const values: Array<string | number | null> = [];
  if (patch.title !== undefined) {
    fields.push('title = ?');
    values.push(patch.title);
  }
  if (patch.pinned !== undefined) {
    fields.push('pinned = ?');
    values.push(patch.pinned ? 1 : 0);
  }
  if (patch.muted !== undefined) {
    fields.push('muted = ?');
    values.push(patch.muted ? 1 : 0);
  }
  if (patch.modelId !== undefined) {
    fields.push('model_id = ?');
    values.push(patch.modelId);
  }
  if (patch.autoReply !== undefined) {
    fields.push('auto_reply = ?');
    values.push(patch.autoReply ? 1 : 0);
  }
  if (patch.supModel !== undefined) {
    fields.push('sup_model = ?');
    values.push(patch.supModel);
  }
  if (patch.maxTurns !== undefined) {
    fields.push('max_turns = ?');
    values.push(patch.maxTurns);
  }
  if (!fields.length) return;
  values.push(id);
  db.prepare(`UPDATE conversations SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteConversation(id: string): void {
  db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
  db.prepare('DELETE FROM conversation_members WHERE conversation_id = ?').run(id);
  db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
}

export function addMember(conversationId: string, agentId: string, memberType: 'agent' | 'human' = 'agent'): void {
  db.prepare(
    "INSERT OR IGNORE INTO conversation_members (conversation_id, member_type, member_id, muted, talk) VALUES (?, ?, ?, 0, 'normal')",
  ).run(conversationId, memberType, agentId);
}

export function removeMember(conversationId: string, agentId: string): void {
  db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND member_id = ?').run(
    conversationId,
    agentId,
  );
}

/* ---------- 真人 ---------- */

export interface Human {
  id: string;
  name: string;
  role: string;
  color: string;
  initial: string;
  createdAt: number;
}

const HUMAN_COLORS = ['#5B8CFF', '#3DDC97', '#F5A524', '#C77DFF', '#FF7A9C', '#37C3D6', '#A0E85C', '#FF9F5A'];

const mapHuman = (r: any): Human => ({
  id: r.id,
  name: r.name,
  role: r.role ?? '',
  color: r.color ?? '#5B8CFF',
  initial: r.initial ?? '人',
  createdAt: r.created_at,
});

export function getHuman(id: string): Human | null {
  const row = db.prepare('SELECT * FROM humans WHERE id = ?').get(id) as any;
  return row ? mapHuman(row) : null;
}

export function listHumans(): Human[] {
  return (db.prepare('SELECT * FROM humans ORDER BY created_at ASC').all() as any[]).map(mapHuman);
}

/** 按名字找或建一个真人（登录时调用） */
export function upsertHuman(input: { name: string; role?: string }): Human {
  const name = input.name.trim();
  const existing = db.prepare('SELECT * FROM humans WHERE name = ?').get(name) as any;
  if (existing) {
    if (input.role !== undefined) {
      db.prepare('UPDATE humans SET role = ? WHERE id = ?').run(input.role, existing.id);
    }
    return getHuman(existing.id)!;
  }
  const id = `hu_${Date.now().toString(36)}`;
  const color = HUMAN_COLORS[Math.abs([...name].reduce((n, ch) => n + ch.charCodeAt(0), 0)) % HUMAN_COLORS.length]!;
  db.prepare('INSERT INTO humans (id, name, role, color, initial, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    name,
    input.role ?? '',
    color,
    name.slice(0, 1) || '人',
    Date.now(),
  );
  return getHuman(id)!;
}
