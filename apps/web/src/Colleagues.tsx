import { useEffect, useRef, useState } from 'react';
import {
  addLanPeer,
  fetchColleagues,
  fetchLanPeers,
  fetchLanSelf,
  fetchMattermostStatus,
  inviteMattermostUser,
  type Colleague,
  type LanPeer,
  type LanSelf,
  type MattermostMeta,
} from './api';

const STATUS_LABEL: Record<string, string> = {
  online: '在线',
  away: '离开',
  dnd: '勿扰',
  offline: '离线',
};

export function ColleagueSearchDialog({
  onClose,
  onOpenLocal,
  onInviteMattermost,
  inviteConversationId,
  onInviteLan,
  onToast,
}: {
  onClose: () => void;
  onOpenLocal: (id: string) => void;
  onInviteMattermost: (username: string) => void;
  inviteConversationId?: string;
  onInviteLan?: (peer: LanPeer) => void;
  onToast: (msg: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<Colleague[]>([]);
  const [mm, setMm] = useState<MattermostMeta | null>(null);
  const [lanPeers, setLanPeers] = useState<LanPeer[]>([]);
  const [lanSelf, setLanSelf] = useState<LanSelf | null>(null);
  const [manualAddr, setManualAddr] = useState('');
  const [manualBusy, setManualBusy] = useState(false);
  const [manualError, setManualError] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 飞秋式内网发现：每 4 秒刷新一次在线客户端
  useEffect(() => {
    let alive = true;
    const load = () => {
      void fetchLanPeers()
        .then((list) => { if (alive) setLanPeers(list); })
        .catch(() => { /* 本地服务不支持时忽略 */ });
      void fetchLanSelf()
        .then((self) => { if (alive) setLanSelf(self); })
        .catch(() => { /* ignore */ });
    };
    load();
    const timer = window.setInterval(load, 4000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  async function addManualPeer() {
    const raw = manualAddr.trim();
    if (!raw || manualBusy) return;
    // 支持「10.201.2.5:8787」或「10.201.2.5 8787」
    const m = raw.match(/^([0-9a-zA-Z.\-]+?)[\s:：]+(\d{2,5})$/);
    if (!m) {
      setManualError('格式：IP:端口，例如 10.201.2.5:8787');
      return;
    }
    const host = m[1]!;
    const port = Number(m[2]);
    setManualBusy(true);
    setManualError('');
    try {
      const peer = await addLanPeer(host, port);
      onToast(`已添加 ${peer.name}（${host}）`);
      setManualAddr('');
      setLanPeers((prev) => {
        const next = prev.filter((p) => p.id !== peer.id);
        return [...next, peer];
      });
    } catch (e) {
      setManualError(String((e as Error).message ?? e));
    } finally {
      setManualBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError('');
      try {
        const r = await fetchColleagues(query.trim());
        if (cancelled) return;
        setRows(r.data);
        setMm(r.mattermost);
      } catch (e) {
        if (!cancelled) {
          setError(String(e));
          onToast('搜索同事失败');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, query ? 260 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const onlineCount = rows.filter((r) => r.online).length;

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet colleague-sheet">
        <div className="sheet-head">
          <h3>找同事</h3>
          <p>
            服务端搜索 S-BOT 同事和 Mattermost 账号，在线 / 离线都会列出来。
            {mm?.mock ? ' 当前使用服务端模拟 Mattermost。' : mm?.configured ? ` Mattermost 已连接${mm.bot ? ` · ${mm.bot.name}` : ''}。` : ''}
          </p>
        </div>

        <div className="colleague-body">
          <div className="colleague-search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
            </svg>
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="输入姓名、角色或 Mattermost 账号"
            />
            {loading && <span className="colleague-loading">搜索中…</span>}
          </div>

          {mm?.mock && (
            <div className="colleague-note">
              Mattermost 还没接真实服务，当前用服务端模拟数据（周敏/李强/王璐）。填了地址和 Token 后自动切换。
            </div>
          )}
          {mm && !mm.mock && !mm.configured && (
            <div className="colleague-note">
              还没配置 Mattermost，现在只能搜到 S-BOT 里的同事。配置地址和 Token 后，这里会同时搜索公司通讯录。
            </div>
          )}
          {mm?.configured && !mm.ok && (
            <div className="colleague-note warn">Mattermost 连接失败：{mm.error ?? '请检查地址和 Token'}</div>
          )}
          {error && <div className="colleague-note warn">{error}</div>}

          <div className="lan-manual">
            <div className="colleague-count">手动添加同事 <span className="lan-tag">内网互通</span></div>
            {lanSelf && lanSelf.addrs.length > 0 && (
              <div className="lan-self">
                本机地址：<b>{lanSelf.addrs.map((a) => `${a}:${lanSelf.port}`).join('　')}</b>
              </div>
            )}
            <div className="lan-manual-row">
              <input
                className="input"
                value={manualAddr}
                onChange={(e) => setManualAddr(e.target.value)}
                placeholder="对方 IP:端口，如 10.201.2.5:8787"
                onKeyDown={(e) => { if (e.key === 'Enter') void addManualPeer(); }}
              />
              <button className="btn" disabled={manualBusy || !manualAddr.trim()} onClick={() => void addManualPeer()}>
                {manualBusy ? '添加中…' : '添加'}
              </button>
            </div>
            {manualError && <div className="colleague-note warn">{manualError}</div>}
            {lanPeers.length === 0 && (
              <div className="colleague-note">
                没自动发现到同事？如果公司网络屏蔽了广播/组播，把上面的「本机地址」告诉对方，让对方在这里手动添加即可。
              </div>
            )}
          </div>

          {lanPeers.length > 0 && (
            <div className="lan-peers">
              <div className="colleague-count">
                内网发现 {lanPeers.length} 位同事 <span className="lan-tag">自动发现</span>
              </div>
              {lanPeers.map((p) => (
                <div
                  key={p.id}
                  className="colleague-row"
                  title={`${p.host} · ${p.role || '同事'}`}
                  onClick={() => {
                    if (inviteConversationId && onInviteLan) onInviteLan(p);
                    else onToast('打开一个群聊后，可以把内网同事邀请进来');
                  }}
                >
                  <span
                    className="colleague-av"
                    style={{ background: `${p.color}22`, borderColor: p.color, color: p.color }}
                  >
                    {p.initial || p.name.slice(0, 1)}
                    <i className="human-online" />
                  </span>
                  <span className="colleague-main">
                    <span className="colleague-name">{p.name}</span>
                    <span className="colleague-role">{p.role || '同事'} · {p.host}</span>
                  </span>
                  <span className="colleague-state on">在线</span>
                  <span className="colleague-action">{inviteConversationId ? '邀请入群' : '已发现'}</span>
                </div>
              ))}
            </div>
          )}

          <div className="colleague-count">
            {rows.length ? `${rows.length} 个结果 · ${onlineCount} 个在线` : query ? '没有匹配的同事' : 'S-BOT 里的同事'}
          </div>

          <div className="colleague-list">
            {rows.map((r) => (
              <div
                key={`${r.source}-${r.id}`}
                className={`colleague-row ${r.online ? 'on' : 'off'}`}
                onClick={() => {
                  if (r.source === 'local') onOpenLocal(r.id);
                  else onInviteMattermost(r.username ?? r.name);
                }}
                title={r.source === 'local' ? '打开单聊' : '用 Mattermost 给 TA 发消息'}
              >
                <span
                  className="colleague-av"
                  style={r.color ? { background: `${r.color}22`, borderColor: r.color, color: r.color } : undefined}
                >
                  {r.initial || r.name.slice(0, 1)}
                  {r.online && <i className="human-online" />}
                </span>
                <span className="colleague-main">
                  <span className="colleague-name">
                    {r.name}
                    {r.source === 'mattermost' && <em>@{r.username}</em>}
                    {r.simulated && <i className="colleague-sim">模拟</i>}
                  </span>
                  <span className="colleague-role">{r.role}</span>
                </span>
                <span className={`colleague-state ${r.online ? 'on' : ''}`}>
                  {STATUS_LABEL[r.status] ?? (r.online ? '在线' : '离线')}
                </span>
                <span className="colleague-action">
                  {r.source === 'local' ? '单聊' : '发消息'}
                </span>
              </div>
            ))}
            {!rows.length && !loading && (
              <div className="colleague-empty">
                {query ? '换个名字或账号再试试' : '还没有同事，去「邀请更多」发个 Mattermost 邀请。'}
              </div>
            )}
          </div>

          <div className="sheet-foot" style={{ padding: '12px 0 0', background: 'transparent', border: 0 }}>
            <span className="foot-note">点击本地同事直接单聊；Mattermost 账号走私信邀请。</span>
            <button className="btn" onClick={onClose}>关闭</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function MattermostInviteDialog({
  username: initialUsername = '',
  message: initialMessage = '',
  onClose,
  onOpenSettings,
  onToast,
}: {
  username?: string;
  message?: string;
  onClose: () => void;
  onOpenSettings: () => void;
  onToast: (msg: string) => void;
}) {
  const [username, setUsername] = useState(initialUsername);
  const [message, setMessage] = useState(initialMessage || '来 S-BOT 一起协作吧，打开就能看到我们的会话。');
  const [status, setStatus] = useState<MattermostMeta | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    void fetchMattermostStatus().then(setStatus).catch(() => setStatus({ configured: false, ok: false }));
  }, []);

  async function send() {
    const name = username.trim().replace(/^@/, '');
    if (!name) {
      setError('请填写 Mattermost 账号');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const r = await inviteMattermostUser(name, message.trim());
      if (!r.ok) {
        setError(r.error ?? '发送失败');
        onToast(r.error ?? '发送失败');
        return;
      }
      onToast(r.mock
        ? `模拟发送成功：@${r.user?.username ?? name}（服务端已记录）`
        : `已通过 Mattermost 发给 @${r.user?.username ?? name}`);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet">
        <div className="sheet-head">
          <h3>邀请更多同事</h3>
          <p>服务端会通过 Mattermost 给指定账号发一条私信。</p>
        </div>
        <div className="sheet-body">
          {status?.mock && (
            <div className="colleague-note">
              当前使用服务端模拟 Mattermost：邀请会记录在服务端，不会真的发到 Mattermost。填了地址和 Token 后自动切到真实发送。
            </div>
          )}
          {status && !status.mock && !status.configured && (
            <div className="colleague-note warn">
              还没配置 Mattermost。先在设置里填地址和 Token，才能给账号发消息。
            </div>
          )}
          {status?.configured && !status.ok && (
            <div className="colleague-note warn">Mattermost 连接失败：{status.error ?? '请检查配置'}</div>
          )}
          {status?.ok && !status.mock && status.bot && (
            <div className="colleague-note">Mattermost 已连接 · 发送身份 {status.bot.name}</div>
          )}

          <label className="field">
            <span>Mattermost 账号</span>
            <input
              ref={inputRef}
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="例如 zhangsan 或 @zhangsan"
              onKeyDown={(e) => { if (e.key === 'Enter') void send(); }}
            />
          </label>

          <label className="field">
            <span>邀请消息</span>
            <textarea
              className="input"
              rows={4}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="告诉对方为什么邀请他，以及去哪里打开"
            />
          </label>

          {error && <div className="colleague-note warn">{error}</div>}
        </div>
        <div className="sheet-foot">
          <button className="btn" onClick={onOpenSettings}>打开设置</button>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={busy} onClick={() => void send()}>
            {busy ? '发送中…' : '发送邀请'}
          </button>
        </div>
      </div>
    </div>
  );
}
