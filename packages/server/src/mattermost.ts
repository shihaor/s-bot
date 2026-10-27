import { getSettings } from './repo.js';

export interface MattermostUser {
  id: string;
  username: string;
  name: string;
  role: string;
  status: string;
  online: boolean;
}

export interface MattermostStatus {
  configured: boolean;
  ok: boolean;
  mock?: boolean;
  url?: string;
  bot?: { id: string; username: string; name: string };
  error?: string;
}

function config(): { url: string; token: string; configured: boolean } {
  const s = getSettings();
  const url = (s.mattermostUrl ?? '').trim().replace(/\/+$/, '');
  const token = (s.mattermostToken ?? '').trim();
  return { url, token, configured: !!url && !!token };
}

export function isMattermostConfigured(): boolean {
  return config().configured;
}

/**
 * 没有配置真实 Mattermost 时使用的服务端模拟数据。
 * 后续接真实 Mattermost 只需要在设置里填地址和 Token，调用方不用改。
 */
const MOCK_USERS: MattermostUser[] = [
  { id: 'mock_u_zhoumin', username: 'zhoumin', name: '周敏', role: '产品经理', status: 'online', online: true },
  { id: 'mock_u_liqiang', username: 'liqiang', name: '李强', role: '后端工程师', status: 'offline', online: false },
  { id: 'mock_u_wanglu', username: 'wanglu', name: '王璐', role: 'UI 设计师', status: 'away', online: true },
];

let mockSeq = 0;
const mockPosts: Array<{ id: string; username: string; message: string; at: number }> = [];

export function getMockMattermostPosts() {
  return mockPosts.slice(-50);
}

function findMockUser(username: string): MattermostUser | null {
  const name = username.trim().replace(/^@/, '').toLowerCase();
  return MOCK_USERS.find((u) => u.username.toLowerCase() === name || u.name === username.trim()) ?? null;
}

async function mmFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { url, token } = config();
  if (!url || !token) throw new Error('还没配置 Mattermost 地址或 Token');

  const res = await fetch(`${url}/api/v4${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(10_000),
  });

  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }

  if (!res.ok) {
    const detail = body?.message ? String(body.message) : text.slice(0, 200);
    const err = new Error(`Mattermost ${res.status}${detail ? `：${detail}` : ''}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return body as T;
}

interface RawUser {
  id: string;
  username: string;
  first_name?: string;
  last_name?: string;
  nickname?: string;
  position?: string;
  delete_at?: number;
}

interface RawStatus {
  user_id: string;
  status: string;
}

function displayName(user: RawUser): string {
  const nickname = user.nickname?.trim();
  if (nickname) return nickname;
  const full = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return full || user.username;
}

function toMattermostUser(user: RawUser, status?: string): MattermostUser {
  const st = status || 'offline';
  return {
    id: user.id,
    username: user.username,
    name: displayName(user),
    role: user.position?.trim() || 'Mattermost 同事',
    status: st,
    online: st !== 'offline',
  };
}

export async function getMattermostStatus(): Promise<MattermostStatus> {
  const { configured, url } = config();
  if (!configured) {
    return {
      configured: false,
      mock: true,
      ok: true,
      url: 'mock://mattermost',
      bot: { id: 'mock_bot', username: 'sbot-mock', name: 'S-BOT 模拟' },
    };
  }
  try {
    const me = await mmFetch<RawUser>('/users/me');
    return {
      configured: true,
      ok: true,
      url,
      bot: { id: me.id, username: me.username, name: displayName(me) },
    };
  } catch (e) {
    return { configured: true, ok: false, url, error: String((e as Error).message ?? e) };
  }
}

/** 按关键字搜索 Mattermost 用户，并带上在线状态 */
export async function searchMattermostUsers(term: string, limit = 20): Promise<MattermostUser[]> {
  if (!config().configured) {
    const q = term.trim().toLowerCase();
    return MOCK_USERS.filter((u) => !q || `${u.username} ${u.name} ${u.role}`.toLowerCase().includes(q)).slice(0, limit);
  }
  const me = await mmFetch<RawUser>('/users/me');
  const users = await mmFetch<RawUser[]>('/users/search', {
    method: 'POST',
    body: JSON.stringify({ term, allow_inactive: true }),
  });

  const picked = users
    .filter((u) => u && u.id !== me.id && !(u.delete_at && u.delete_at > 0))
    .slice(0, limit);
  if (!picked.length) return [];

  let statuses: RawStatus[] = [];
  try {
    statuses = await mmFetch<RawStatus[]>('/users/status/ids', {
      method: 'POST',
      body: JSON.stringify(picked.map((u) => u.id)),
    });
  } catch {
    /* 状态接口失败就都按离线显示 */
  }
  const byId = new Map(statuses.map((s) => [s.user_id, s.status]));
  return picked.map((u) => toMattermostUser(u, byId.get(u.id)));
}

export async function findMattermostUser(username: string): Promise<MattermostUser> {
  const name = username.trim().replace(/^@/, '');
  if (!name) throw new Error('Mattermost 账号不能为空');
  if (!config().configured) {
    const user = findMockUser(name);
    if (!user) throw new Error(`模拟 Mattermost 里没有账号 @${name}`);
    return user;
  }
  const user = await mmFetch<RawUser>(`/users/username/${encodeURIComponent(name)}`);
  let status = 'offline';
  try {
    const st = await mmFetch<RawStatus>(`/users/${user.id}/status`);
    status = st.status;
  } catch { /* ignore */ }
  return toMattermostUser(user, status);
}

/** 给指定 Mattermost 账号发私信；未配置真实服务时走服务端模拟接口 */
export async function sendMattermostDm(username: string, message: string): Promise<{
  ok: boolean;
  mock?: boolean;
  user?: MattermostUser;
  postId?: string;
  error?: string;
}> {
  if (!config().configured) {
    const user = findMockUser(username);
    if (!user) return { ok: false, error: `模拟 Mattermost 里没有账号 @${username.replace(/^@/, '')}` };
    const postId = `mock_post_${++mockSeq}`;
    mockPosts.push({ id: postId, username: user.username, message, at: Date.now() });
    console.log(`[s-bot] mock mattermost → @${user.username}: ${message}`);
    return { ok: true, mock: true, user, postId };
  }
  try {
    const me = await mmFetch<RawUser>('/users/me');
    const target = await findMattermostUser(username);
    const channel = await mmFetch<{ id: string }>('/channels/direct', {
      method: 'POST',
      body: JSON.stringify([me.id, target.id]),
    });
    const post = await mmFetch<{ id: string }>('/posts', {
      method: 'POST',
      body: JSON.stringify({ channel_id: channel.id, message }),
    });
    return { ok: true, user: target, postId: post.id };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}
