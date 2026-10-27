import type { Agent, ChatIntro, Conversation, HandoffPackage, Message, ModelInfo, Task } from '@sbot/shared';

/** 可以指向内网服务器（设置里保存），留空就是本地内置服务 */
export function apiBase(): string {
  return localStorage.getItem('sbot.server') ?? '';
}

export function apiUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${apiBase().replace(/\/$/, '')}${path}`;
}

export function apiIdentity(): string | null {
  return localStorage.getItem('sbot.user');
}

function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const user = apiIdentity();
  if (user) headers.set('x-sbot-user', user);
  return globalThis.fetch(apiUrl(path), { ...init, headers });
}

async function getJson<T>(url: string): Promise<T> {
  const res = await apiFetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export async function fetchAgents(): Promise<Agent[]> {
  const r = await getJson<{ data: Agent[] }>('/api/agents');
  return r.data;
}

export async function fetchConversations(): Promise<Conversation[]> {
  const r = await getJson<{ data: Conversation[] }>('/api/conversations');
  return r.data;
}

export async function fetchMessages(conversationId: string): Promise<Message[]> {
  const r = await getJson<{ data: Message[] }>(`/api/conversations/${conversationId}/messages`);
  return r.data;
}

export async function fetchRuntime(): Promise<{ mode: string; label: string }> {
  return getJson('/api/runtime');
}

export async function fetchIntro(conversationId: string): Promise<ChatIntro> {
  const r = await getJson<{ data: ChatIntro }>(`/api/conversations/${conversationId}/intro`);
  return r.data;
}

/* ---------- 真人 ---------- */

export interface HumanInfo {
  id: string;
  name: string;
  role: string;
  color: string;
  initial: string;
  simulated?: boolean;
  online?: boolean;
  createdAt: number;
}

export async function loginHuman(name: string, role: string): Promise<HumanInfo> {
  const res = await apiFetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, role }),
  });
  if (!res.ok) throw new Error('登录失败');
  const r = (await res.json()) as { data: HumanInfo };
  return r.data;
}

export async function addHumanMember(conversationId: string, name: string, role: string): Promise<Conversation> {
  const res = await apiFetch(`/api/conversations/${conversationId}/humans`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, role }),
  });
  const body = (await res.json().catch(() => ({}))) as { data?: Conversation; error?: string };
  if (!res.ok) throw new Error(body.error ?? '邀请失败');
  return body.data!;
}

export async function createAgent(input: {
  name: string;
  role: string;
  color: string;
  description: string;
  skills: string[];
  systemPrompt: string;
  modelId: string | null;
  visibility: 'team' | 'private';
  tools: { read?: boolean; web?: boolean; shell?: boolean };
  kbIds?: string[];
}): Promise<Agent> {
  const res = await apiFetch('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error('创建智能体失败');
  const r = (await res.json()) as { data: Agent };
  return r.data;
}

export async function ensureDm(agentId: string): Promise<Conversation> {  const res = await apiFetch('/api/conversations/dm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId }),
  });
  if (!res.ok) throw new Error('打开单聊失败');
  const r = (await res.json()) as { data: Conversation };
  return r.data;
}

/** 和真人的单聊，没有就新建 */
export async function ensureHumanDm(humanId: string): Promise<Conversation> {
  const res = await apiFetch('/api/conversations/dm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ humanId }),
  });
  if (!res.ok) throw new Error('打开真人单聊失败');
  const r = (await res.json()) as { data: Conversation };
  return r.data;
}

export async function createGroup(title: string, memberIds: string[]): Promise<Conversation> {
  const res = await apiFetch('/api/conversations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, memberIds }),
  });
  if (!res.ok) throw new Error('创建群聊失败');
  const r = (await res.json()) as { data: Conversation };
  return r.data;
}

export async function updateConversation(
  id: string,
  patch: { title?: string; pinned?: boolean; muted?: boolean; modelId?: string | null },
): Promise<Conversation> {
  const res = await apiFetch(`/api/conversations/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error('更新会话失败');
  const r = (await res.json()) as { data: Conversation };
  return r.data;
}

export async function deleteConversation(id: string): Promise<void> {
  const res = await apiFetch(`/api/conversations/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('删除会话失败');
}

export async function addMember(id: string, agentId: string): Promise<Conversation> {
  const res = await apiFetch(`/api/conversations/${id}/members`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId }),
  });
  if (!res.ok) throw new Error('添加成员失败');
  const r = (await res.json()) as { data: Conversation };
  return r.data;
}

export async function removeMember(id: string, agentId: string): Promise<Conversation> {
  const res = await apiFetch(`/api/conversations/${id}/members/${agentId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('移除成员失败');
  const r = (await res.json()) as { data: Conversation };
  return r.data;
}

export async function updateMember(
  id: string,
  agentId: string,
  patch: { muted?: boolean; talk?: 'low' | 'normal' | 'high' },
): Promise<Conversation> {
  const res = await apiFetch(`/api/conversations/${id}/members/${agentId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error('更新成员失败');
  const r = (await res.json()) as { data: Conversation };
  return r.data;
}

export async function updateAgent(
  id: string,
  patch: Record<string, unknown>,
): Promise<Agent> {
  const res = await apiFetch(`/api/agents/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error('更新智能体失败');
  const r = (await res.json()) as { data: Agent };
  return r.data;
}

export async function deleteAgent(id: string): Promise<void> {
  const res = await apiFetch(`/api/agents/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('删除智能体失败');
}

/* ---------- 模型 ---------- */

export async function fetchModels(): Promise<ModelInfo[]> {
  const r = await getJson<{ data: ModelInfo[] }>('/api/models');
  return r.data;
}

export async function createModel(input: {
  name: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  tools: boolean;
  stream: boolean;
}): Promise<ModelInfo> {
  const res = await apiFetch('/api/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error('创建模型失败');
  const r = (await res.json()) as { data: ModelInfo };
  return r.data;
}

export async function updateModel(
  id: string,
  patch: { name?: string; model?: string; baseUrl?: string; apiKey?: string; tools?: boolean; stream?: boolean },
): Promise<ModelInfo> {
  const res = await apiFetch(`/api/models/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error('更新模型失败');
  const r = (await res.json()) as { data: ModelInfo };
  return r.data;
}

export async function deleteModel(id: string): Promise<void> {
  const res = await apiFetch(`/api/models/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('删除模型失败');
}

export async function setDefaultModel(id: string): Promise<void> {
  const res = await apiFetch(`/api/models/${id}/default`, { method: 'POST' });
  if (!res.ok) throw new Error('设置默认模型失败');
}

export async function testModel(id: string): Promise<{ ok: boolean; error?: string; ms?: number; status?: number }> {
  const res = await apiFetch(`/api/models/${id}/test`, { method: 'POST' });
  return (await res.json()) as { ok: boolean; error?: string; ms?: number; status?: number };
}

/* ---------- 任务 ---------- */

export async function fetchTasks(): Promise<Task[]> {
  const r = await getJson<{ data: Task[] }>('/api/tasks');
  return r.data;
}

export async function createTask(input: {
  title: string;
  description?: string;
  conversationId?: string | null;
  priority?: 'high' | 'mid' | 'low';
}): Promise<Task> {
  const res = await apiFetch('/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error('创建任务失败');
  const r = (await res.json()) as { data: Task };
  return r.data;
}

export async function updateTask(
  id: string,
  patch: { title?: string; description?: string; conversationId?: string | null; priority?: string; status?: Task['status'] },
): Promise<Task> {
  const res = await apiFetch(`/api/tasks/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error('更新任务失败');
  const r = (await res.json()) as { data: Task };
  return r.data;
}

export async function deleteTask(id: string): Promise<void> {
  const res = await apiFetch(`/api/tasks/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('删除任务失败');
}

/* ---------- 交接 ---------- */

export async function exportConversation(id: string): Promise<HandoffPackage> {
  const r = await getJson<{ data: HandoffPackage }>(`/api/conversations/${id}/export`);
  return r.data;
}

export async function importConversation(
  id: string,
  pkg: unknown,
): Promise<{ importedMessages: number; importedTasks: number }> {
  const res = await apiFetch(`/api/conversations/${id}/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(pkg),
  });
  const body = (await res.json().catch(() => ({}))) as { data?: { importedMessages: number; importedTasks: number }; error?: string };
  if (!res.ok) throw new Error(body.error ?? '导入失败');
  return body.data ?? { importedMessages: 0, importedTasks: 0 };
}

/* ---------- opencode ---------- */

export async function replyPermission(requestID: string, decision: 'once' | 'always' | 'reject'): Promise<void> {
  const res = await apiFetch(`/api/permissions/${requestID}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision }),
  });
  if (!res.ok) throw new Error('审批回复失败');
}

export interface OpencodeStatusData {
  available: boolean;
  running: boolean;
  bin?: string;
  version?: string;
  url?: string;
  error?: string;
  dataDir?: string;
  sidecarDir?: string;
  configFile?: string;
}

export async function fetchOpencodeStatus(): Promise<OpencodeStatusData> {
  const r = await getJson<{ data: OpencodeStatusData }>('/api/opencode/status');
  return r.data;
}

export interface OpencodeCandidate {
  bin: string;
  version: string;
}

/** 扫描 opencode 安装位置；save=true 时把 path 保存为手动指定的可执行文件/安装目录 */
export async function detectOpencode(path?: string, save = false): Promise<{
  ok: boolean;
  bin?: string;
  error?: string;
  status: OpencodeStatusData;
  candidates: OpencodeCandidate[];
}> {
  const res = await apiFetch('/api/opencode/detect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, save }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    data?: { ok?: boolean; bin?: string; error?: string; status?: OpencodeStatusData; candidates?: OpencodeCandidate[] };
    error?: string;
  };
  const d = body.data;
  if (!d) throw new Error(body.error ?? `检测失败（${res.status}）`);
  return {
    ok: d.ok !== false,
    bin: d.bin,
    error: d.error,
    status: d.status ?? (await fetchOpencodeStatus()),
    candidates: d.candidates ?? [],
  };
}

export async function openOpencodeDataDir(): Promise<{ ok: boolean; path: string; error?: string }> {
  const res = await apiFetch('/api/opencode/open-data', { method: 'POST' });
  return (await res.json().catch(() => ({ ok: false, path: '', error: '打开失败' }))) as {
    ok: boolean;
    path: string;
    error?: string;
  };
}

export interface OpencodeSkill {
  id: string;
  name: string;
  description?: string;
  autoinvoke?: boolean;
  path: string;
  content: string;
}

export async function fetchOpencodeSkills(): Promise<OpencodeSkill[]> {
  const res = await apiFetch('/api/skills');
  const body = (await res.json().catch(() => ({}))) as { data?: OpencodeSkill[]; error?: string };
  if (!res.ok) throw new Error(body.error ?? `读取技能失败（${res.status}）`);
  return body.data ?? [];
}

export interface SkillDraft {
  id: string;
  name: string;
  description: string;
  content: string;
  scope: 'global' | 'project';
}

export interface SkillCoachReply {
  reply: string;
  verification: {
    ok: boolean;
    host: string;
    port: number;
    ms: number;
    error?: string;
  } | null;
}

export async function coachSkill(messages: { role: 'user' | 'assistant'; content: string }[]): Promise<SkillCoachReply> {
  const res = await apiFetch('/api/skills/coach', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages }),
  });
  const body = (await res.json().catch(() => ({}))) as { data?: SkillCoachReply; error?: string };
  if (!res.ok || !body.data) throw new Error(body.error ?? `技能教练不可用（${res.status}）`);
  return body.data;
}

export async function verifySkillEndpoint(input: { host?: string; port?: number; address?: string }): Promise<{
  ok: boolean;
  host: string;
  port: number;
  ms: number;
  error?: string;
}> {
  const res = await apiFetch('/api/skills/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return (await res.json().catch(() => ({ ok: false, host: input.host ?? '', port: input.port ?? 0, ms: 0, error: '返回解析失败' }))) as {
    ok: boolean;
    host: string;
    port: number;
    ms: number;
    error?: string;
  };
}

export async function createSkill(input: SkillDraft & { overwrite?: boolean }): Promise<{ id: string; path: string; scope: 'global' | 'project' }> {
  const res = await apiFetch('/api/skills', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => ({}))) as { data?: { id: string; path: string; scope: 'global' | 'project' }; error?: string };
  if (!res.ok || !body.data) throw new Error(body.error ?? '保存技能失败');
  return body.data;
}

export async function syncModelsToOpencode(): Promise<{ count: number; path: string }> {
  const res = await apiFetch('/api/models/sync', { method: 'POST' });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; count?: number; path?: string; error?: string };
  if (!res.ok || !body.ok) throw new Error(body.error ?? '同步失败');
  return { count: body.count ?? 0, path: body.path ?? '' };
}

export async function fetchHumans(): Promise<HumanInfo[]> {
  const r = await getJson<{ data: HumanInfo[] }>('/api/humans');
  return r.data;
}

/** 登录后每 30 秒打一次心跳，其他客户端就能看到你在线 */
export async function heartbeatPresence(): Promise<void> {
  await apiFetch('/api/presence', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
}

export interface Colleague {
  source: 'local' | 'mattermost';
  id: string;
  name: string;
  role: string;
  online: boolean;
  status: string;
  simulated?: boolean;
  username?: string | null;
  color?: string | null;
  initial?: string;
}

export interface MattermostMeta {
  configured: boolean;
  ok: boolean;
  url?: string;
  bot?: { id: string; username: string; name: string };
  error?: string;
}

/** 服务端找同事：S-BOT 本地真人 + Mattermost 用户 */
export async function fetchColleagues(query: string): Promise<{ data: Colleague[]; mattermost: MattermostMeta }> {
  const res = await apiFetch(`/api/colleagues?q=${encodeURIComponent(query)}`);
  const body = (await res.json().catch(() => ({}))) as {
    data?: Colleague[];
    meta?: { mattermost?: MattermostMeta };
    error?: string;
  };
  if (!res.ok) throw new Error(body.error ?? `搜索失败（${res.status}）`);
  return {
    data: body.data ?? [],
    mattermost: body.meta?.mattermost ?? { configured: false, ok: false },
  };
}

export async function fetchMattermostStatus(): Promise<MattermostMeta> {
  const r = await getJson<{ data: MattermostMeta }>('/api/mattermost/status');
  return r.data;
}

export async function inviteMattermostUser(username: string, message: string): Promise<{
  ok: boolean;
  postId?: string;
  user?: { id: string; username: string; name: string; online: boolean };
  error?: string;
}> {
  const res = await apiFetch('/api/mattermost/invite', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, message }),
  });
  return (await res.json().catch(() => ({ ok: false, error: '返回解析失败' }))) as {
    ok: boolean;
    postId?: string;
    user?: { id: string; username: string; name: string; online: boolean };
    error?: string;
  };
}

export async function resumeHumanWait(runId: string, action: 'continue' | 'skip'): Promise<void> {
  const res = await apiFetch(`/api/runs/${runId}/resume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  if (!res.ok) throw new Error(`继续失败（${res.status}）`);
}

/** 软等待时以被 @ 真人的身份直接回复，随后原来的智能体发言继续 */
export async function replyHumanWait(runId: string, text: string): Promise<Message> {
  const res = await apiFetch(`/api/runs/${runId}/reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const body = (await res.json().catch(() => ({}))) as { data?: Message; error?: string };
  if (!res.ok || !body.data) throw new Error(body.error ?? `回复失败（${res.status}）`);
  return body.data;
}

/* ---------- 设置 / 运行时 / 知识库 ---------- */

export interface AppSettingsData {
  baseUrl: string;
  apiKey: string;
  model: string;
  opencodeUrl: string;
  opencodeBin: string;
  ragflowBaseUrl: string;
  ragflowApiKey: string;
  ragflowEnabledKbs: string[];
  mattermostUrl: string;
  mattermostToken: string;
}

export async function fetchSettings(): Promise<AppSettingsData> {
  const r = await getJson<{ data: AppSettingsData }>('/api/settings');
  return r.data;
}

export async function patchSettings(patch: Partial<AppSettingsData>): Promise<AppSettingsData> {
  const res = await apiFetch('/api/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error('保存设置失败');
  const r = (await res.json()) as { data: AppSettingsData };
  return r.data;
}

export async function installOpencodeRuntime(url: string): Promise<{
  ok: boolean;
  version?: string;
  error?: string;
  status?: { available: boolean; running: boolean; version?: string; bin?: string };
}> {
  const res = await apiFetch('/api/opencode/install', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  return (await res.json()) as {
    ok: boolean;
    version?: string;
    error?: string;
    status?: { available: boolean; running: boolean; version?: string; bin?: string };
  };
}

export interface ImportableModel {
  provider: string;
  providerName: string;
  model: string;
  name: string;
  baseUrl: string;
  isDefault?: boolean;
}

export async function fetchImportableModels(): Promise<ImportableModel[]> {
  const r = await getJson<{ data: ImportableModel[] }>('/api/opencode/importable');
  return r.data;
}

export interface KbDataset {
  id: string;
  name: string;
  description: string;
  documentCount: number;
  chunkCount: number;
  enabled: boolean;
}

export async function fetchKbStatus(): Promise<{
  ok: boolean;
  configured: boolean;
  baseUrl: string;
  error?: string;
  datasets?: number;
}> {
  const r = await getJson<{ data: { ok: boolean; configured: boolean; baseUrl: string; error?: string; datasets?: number } }>(
    '/api/kb/status',
  );
  return r.data;
}

export async function fetchKbDatasets(): Promise<KbDataset[]> {
  const res = await apiFetch('/api/kb/datasets');
  const body = (await res.json().catch(() => ({}))) as { data?: KbDataset[]; error?: string };
  if (!res.ok) throw new Error(body.error ?? '读取知识库失败');
  return body.data ?? [];
}

export async function saveEnabledKbs(ids: string[]): Promise<void> {
  const res = await apiFetch('/api/kb/enabled', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) throw new Error('保存知识库失败');
}

export interface SettingsInfo {
  baseUrl: string;
  model: string;
  configured: boolean;
  apiKeyMasked: string;
}

export async function getSettings(): Promise<SettingsInfo> {
  const r = await getJson<{ data: SettingsInfo }>('/api/settings');
  return r.data;
}

export async function saveSettings(patch: { baseUrl?: string; model?: string; apiKey?: string }): Promise<void> {
  const res = await apiFetch('/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error('保存设置失败');
}

export async function testSettings(): Promise<{ ok: boolean; error?: string; ms?: number; status?: number }> {
  const res = await apiFetch('/api/settings/test', { method: 'POST' });
  return (await res.json()) as { ok: boolean; error?: string; ms?: number; status?: number };
}

export type ChatEvent =
  | { type: 'human.wait'; runId: string; conversationId: string; humanId: string; name: string; role: string; color: string; initial: string; seconds: number; remaining: number }
  | { type: 'human.resume'; runId: string; conversationId: string; humanId: string; name: string; decision: 'continue' | 'skip' | 'reply' | 'timeout' }
  | { type: 'run.start'; runId: string; userMessageId: string; conversationId: string; targets: string[] }
  | {
      type: 'message.start';
      id: string;
      agentId: string;
      name: string;
      role: string;
      color: string;
      initial: string;
      model?: string;
    }
  | { type: 'message.delta'; id: string; delta: string }
  | { type: 'message.error'; id: string; error: string }
  | { type: 'message.end'; id: string; agentId: string; savedId: string; text: string; createdAt: number; status: string; parts?: unknown[] }
  | { type: 'tool'; id: string; toolId: string; name?: string; detail?: string; status: 'running' | 'ok' | 'failed' }
  | { type: 'retrieval.start'; agentId: string }
  | { type: 'retrieval.done'; agentId: string; count: number }
  | { type: 'permission.ask'; agentId: string; messageId: string; requestID: string; action: string; resources: string[] }
  | { type: 'task.confirm'; message: Message; task: Task }
  | { type: 'run.end' };

export async function sendMessage(
  conversationId: string,
  payload: { text: string; parts?: unknown[] },
  onEvent: (e: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await apiFetch(`/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`send failed: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);

      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
      if (!data.length) continue;
      try {
        onEvent({ type: event, ...JSON.parse(data.join('\n')) } as ChatEvent);
      } catch {
        // 忽略无法解析的帧
      }
    }
  }
}
