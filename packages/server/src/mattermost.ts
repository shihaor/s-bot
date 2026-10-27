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
  if (!configured) return { configured: false, ok: false, url, error: '还没配置 Mattermost 地址或 Token' };
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
  if (!config().configured) return [];
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
  const user = await mmFetch<RawUser>(`/users/username/${encodeURIComponent(name)}`);
  let status = 'offline';
  try {
    const st = await mmFetch<RawStatus>(`/users/${user.id}/status`);
    status = st.status;
  } catch { /* ignore */ }
  return toMattermostUser(user, status);
}

/** 给指定 Mattermost 账号发私信 */
export async function sendMattermostDm(username: string, message: string): Promise<{
  ok: boolean;
  user?: MattermostUser;
  postId?: string;
  error?: string;
}> {
  if (!config().configured) return { ok: false, error: '还没配置 Mattermost，请先在设置里填写地址和 Token' };
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
