import { useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, Conversation, GroupWorkflow, Message, ModelInfo, Task } from '@sbot/shared';
import { previewGroupWorkflow } from './api';
import WorkflowEditor from './WorkflowEditor';

export interface MenuItem {
  label: string;
  danger?: boolean;
  onClick: () => void;
}

export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('mousedown', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [onClose]);

  return (
    <div
      className="ctx-menu"
      style={{ left: Math.min(x, window.innerWidth - 230), top: Math.min(y, window.innerHeight - 280) }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((it, i) => (
        <button
          key={i}
          className={`ctx-item ${it.danger ? 'danger' : ''}`}
          onClick={() => {
            onClose();
            it.onClick();
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function RenameDialog({
  current,
  onCancel,
  onSave,
}: {
  current: string;
  onCancel: () => void;
  onSave: (value: string) => void;
}) {
  const [value, setValue] = useState(current);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="sheet narrow">
        <div className="sheet-head"><h3>重命名</h3><p>名称会同步到所有成员。</p></div>
        <div className="sheet-body">
          <label className="field"><span>名称</span>
            <input className="input" autoFocus value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) onSave(value.trim()); }} />
          </label>
        </div>
        <div className="sheet-foot">
          <button className="btn" onClick={onCancel}>取消</button>
          <button className="btn primary" disabled={!value.trim()} onClick={() => onSave(value.trim())}>保存</button>
        </div>
      </div>
    </div>
  );
}

export function SearchPanel({
  messages,
  members,
  onJump,
  onClose,
}: {
  messages: Message[];
  members: Conversation['members'];
  onJump: (id: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return messages.slice(-12).reverse();
    return messages.filter((m) => m.text.toLowerCase().includes(needle)).slice(-60).reverse();
  }, [q, messages]);

  function personOf(id: string | null) {
    return members.find((m) => m.memberId === id);
  }

  return (
    <div className="overlay top" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="search-panel">
        <div className="search-head">
          <span className="ico">⌕</span>
          <input autoFocus placeholder="搜索聊天记录…" value={q} onChange={(e) => setQ(e.target.value)} />
          <kbd>Esc</kbd>
        </div>
        <div className="search-results">
          {results.length === 0 && <div className="search-empty">没有找到匹配的消息</div>}
          {results.map((m) => {
            const p = personOf(m.authorId);
            const name = m.authorType === 'user' ? '我' : p?.name ?? '系统';
            return (
              <button key={m.id} className="search-row" onClick={() => { onJump(m.id); onClose(); }}>
                <span className="who" style={{ color: p?.color }}>{name}</span>
                <span className="text">{m.text}</span>
              </button>
            );
          })}
        </div>
        <div className="search-foot">{q ? `${results.length} 条结果` : '最近消息'} · ↑ 点击跳转</div>
      </div>
    </div>
  );
}

export interface LocalProfile {
  name: string;
  role: string;
  color: string;
  initial: string;
  status: 'online' | 'busy' | 'away';
}

const PROFILE_COLORS = ['#5B8CFF', '#3DDC97', '#F5A524', '#C77DFF', '#FF7A9C', '#37C3D6', '#A0E85C', '#FF9F5A'];
const STATUS_LABEL: Record<LocalProfile['status'], string> = { online: '在线', busy: '忙碌', away: '离开' };

export function LoginDialog({
  user,
  profile,
  onClose,
  onLogout,
  onSaveProfile,
}: {
  user: { name: string; role: string; initial: string } | null;
  profile: LocalProfile;
  onClose: () => void;
  onLogout: () => void;
  onSaveProfile: (next: LocalProfile) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<LocalProfile>(profile);
  const [error, setError] = useState('');

  useEffect(() => { setDraft(profile); }, [profile]);

  function saveProfile() {
    const name = draft.name.trim();
    if (!name) {
      setError('名字不能为空');
      return;
    }
    onSaveProfile({
      ...draft,
      name,
      role: draft.role.trim(),
      initial: name.slice(0, 1) || '我',
    });
    setEditing(false);
    setError('');
  }

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet profile-sheet">
        <div className="sheet-head">
          <h3>我</h3>
          <p>本地身份用于内网发现和聊天；登录后解锁云端服务。</p>
        </div>

        <div className="sheet-body">
          {!editing ? (
            <>
              <div className="profile-hero">
                <div className="profile-avatar" style={{ background: `${profile.color}22`, borderColor: profile.color, color: profile.color }}>
                  {profile.initial || profile.name.slice(0, 1)}
                  {profile.status === 'online' && <span className="human-online" />}
                </div>
                <div className="profile-meta">
                  <h3>{profile.name}</h3>
                  <p>{profile.role || '同事'} · <span className={`profile-status ${profile.status}`}>{STATUS_LABEL[profile.status]}</span></p>
                </div>
                <button className="btn" onClick={() => setEditing(true)}>编辑资料</button>
              </div>

              <div className="profile-local">
                <b>本地身份</b>
                <span>局域网可发现 · 资料只存在这台电脑</span>
              </div>

              <div className="profile-cloud">
                <div className="profile-cloud-head">
                  <b>{user ? '云端账号' : '登录享受更多服务'}</b>
                  <span>{user ? `已登录：${user.name}` : '不登录也能继续用本地和内网功能'}</span>
                </div>
                <div className="cloud-list">
                  {['云端智能体库', '跨设备同步', '团队通讯录', '外网中继'].map((item) => (
                    <div key={item} className="cloud-row">
                      <span>{item}</span>
                      <em>即将上线</em>
                    </div>
                  ))}
                </div>

                {user ? (
                  <div className="profile-account">
                    <span>{user.name} · {user.role}</span>
                    <button className="btn" onClick={onLogout}>退出登录</button>
                  </div>
                ) : (
                  <>
                    <div className="profile-actions">
                      <button
                        className="btn primary"
                        onClick={() => setError('XABP OIDC 登录还在接入中，当前继续使用本地身份')}
                      >
                        使用 XABP OIDC 登录
                      </button>
                    </div>
                    {error && <div className="profile-error">{error}</div>}
                    <p className="profile-hint">全局登录后续统一走 XABP 服务的 OIDC 模式；当前先使用本地身份。</p>
                  </>
                )}
              </div>
            </>
          ) : (
            <div className="profile-edit">
              <div className="two">
                <label className="field"><span>名字</span>
                  <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="你的名字" />
                </label>
                <label className="field"><span>职位</span>
                  <input className="input" value={draft.role} onChange={(e) => setDraft({ ...draft, role: e.target.value })} placeholder="比如 前端工程师" />
                </label>
              </div>
              <label className="field"><span>在线状态</span>
                <select className="input" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as LocalProfile['status'] })}>
                  <option value="online">在线</option>
                  <option value="busy">忙碌</option>
                  <option value="away">离开</option>
                </select>
              </label>
              <label className="field"><span>头像颜色</span>
                <div className="swatches">
                  {PROFILE_COLORS.map((c) => (
                    <button key={c} type="button" className={`swatch ${draft.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setDraft({ ...draft, color: c })} />
                  ))}
                </div>
              </label>
              {error && <div className="profile-error">{error}</div>}
              <div className="profile-actions">
                <button className="btn" onClick={() => { setDraft(profile); setEditing(false); setError(''); }}>取消</button>
                <button className="btn primary" onClick={saveProfile}>保存资料</button>
              </div>
            </div>
          )}
        </div>

        <div className="sheet-foot">
          <span className="foot-note">本地资料不会上传</span>
          <button className="btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

export function NewGroupDialog({
  agents,
  onCancel,
  onCreate,
}: {
  agents: Agent[];
  onCancel: () => void;
  onCreate: (title: string, memberIds: string[], workflow: GroupWorkflow | null) => void;
}) {
  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [graph, setGraph] = useState<GroupWorkflow | null>(null);
  const [graphBusy, setGraphBusy] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < 6) next.add(id);
      return next;
    });
  }

  useEffect(() => {
    if (picked.size < 2) {
      setGraph(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setGraphBusy(true);
      try {
        const g = await previewGroupWorkflow([...picked], true);
        if (!cancelled) setGraph(g);
      } catch {
        if (!cancelled) setGraph(null);
      } finally {
        if (!cancelled) setGraphBusy(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [picked]);

  const name = title.trim() || (picked.size === 2 ? '新的评审组' : '新建群聊');
  const stages = graph?.nodes.filter((n) => n.type !== 'start' && n.type !== 'end') ?? [];

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="sheet">
        <div className="sheet-head"><h3>新建群聊</h3><p>选 2~6 个智能体，系统会按他们的角色生成一张聊天逻辑图。</p></div>
        <div className="sheet-body">
          <label className="field"><span>群名称</span>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="留空自动生成，比如「首页改版评审」" />
          </label>
          <div className="field"><span>选择智能体（{picked.size}/6）</span>
            <div className="pick-grid">
              {agents.map((a) => (
                <button key={a.id} className={`pick-item ${picked.has(a.id) ? 'sel' : ''}`} onClick={() => toggle(a.id)}>
                  <div className="av" style={{ width: 26, height: 26, flexBasis: 26, fontSize: 10.5, background: `${a.color}22`, border: `2px solid ${a.color}`, color: a.color }}>{a.initial}</div>
                  <div><div className="pick-name">{a.name}</div><div className="pick-role">{a.role}</div></div>
                  <span className="tick">{picked.has(a.id) ? '✓' : ''}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <span>聊天逻辑（自动生成，可调整）</span>
            <div className="wf-preview">
              {graphBusy && <span className="wf-preview-hint">正在生成…</span>}
              {!graphBusy && picked.size < 2 && <span className="wf-preview-hint">选满 2 人后自动生成</span>}
              {!graphBusy && stages.length > 0 && (
                <div className="wf-preview-chain">
                  {stages.map((n, i) => (
                    <span key={n.id} className={`wf-step ${n.type}`}>
                      {i > 0 && <span className="wf-arrow">→</span>}
                      {n.label}
                    </span>
                  ))}
                </div>
              )}
              <button className="btn" disabled={!graph} onClick={() => setEditorOpen(true)}>编辑聊天逻辑</button>
            </div>
          </div>
        </div>
        <div className="sheet-foot">
          <button className="btn" onClick={onCancel}>取消</button>
          <button className="btn primary" disabled={picked.size < 2} onClick={() => onCreate(name, [...picked], graph)}>创建群聊</button>
        </div>
      </div>

      {editorOpen && graph && (
        <div className="overlay wf-editor-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setEditorOpen(false); }}>
          <WorkflowEditor
            graph={graph}
            agents={agents.filter((a) => picked.has(a.id))}
            onClose={() => setEditorOpen(false)}
            onSave={(g) => { setGraph(g); setEditorOpen(false); }}
          />
        </div>
      )}
    </div>
  );
}

export function TaskDialog({
  task,
  conversations,
  defaultConversationId,
  onCancel,
  onSave,
}: {
  task: Task | null;
  conversations: Conversation[];
  defaultConversationId: string | null;
  onCancel: () => void;
  onSave: (input: { title: string; description: string; conversationId: string | null; priority: 'high' | 'mid' | 'low' }) => void;
}) {
  const groups = conversations.filter((c) => c.type === 'group');
  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [conversationId, setConversationId] = useState<string>(task?.conversationId ?? defaultConversationId ?? '');
  const [priority, setPriority] = useState<'high' | 'mid' | 'low'>(task?.priority ?? 'mid');
  const [error, setError] = useState('');

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="sheet">
        <div className="sheet-head">
          <h3>{task ? '编辑任务' : '新建任务'}</h3>
          <p>把任务分给一个群聊，智能体和同事都能在群里看到它。</p>
        </div>
        <div className="sheet-body">
          <label className="field"><span>任务标题 <i className="req">*</i></span>
            <input
              className="input"
              value={title}
              onChange={(e) => { setTitle(e.target.value); setError(''); }}
              placeholder="比如 整理首页改版的评审结论"
            />
          </label>
          <label className="field"><span>描述</span>
            <textarea
              className="input"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="补充背景、验收标准"
            />
          </label>
          <label className="field"><span>分配给群聊</span>
            <select className="input" value={conversationId} onChange={(e) => setConversationId(e.target.value)}>
              <option value="">不分配</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
            </select>
          </label>
          <div className="field" style={{ marginBottom: 4 }}><span>优先级</span>
            <div className="seg" style={{ width: 'fit-content' }}>
              {([['high', '高'], ['mid', '中'], ['low', '低']] as const).map(([k, n]) => (
                <button key={k} type="button" className={priority === k ? 'on' : ''} onClick={() => setPriority(k)}>{n}</button>
              ))}
            </div>
          </div>
        </div>
        <div className="sheet-foot">
          {error && <span className="foot-error">{error}</span>}
          <button className="btn" onClick={onCancel}>取消</button>
          <button
            className="btn primary"
            onClick={() => {
              const t = title.trim();
              if (!t) { setError('任务标题不能为空'); return; }
              onSave({ title: t, description: description.trim(), conversationId: conversationId || null, priority });
            }}
          >
            {task ? '保存' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function GroupDrawer({
  conv,
  agents,
  models,
  tasks,
  onClose,
  onPatch,
  onMemberPatch,
  onAdd,
  onRemove,
  onDissolve,
  onLinkTask,
  onUnassignTask,
  onExport,
  onImport,
  onToast,
  user,
  onInviteHuman,
  onEditWorkflow,
}: {
  conv: Conversation;
  agents: Agent[];
  models: ModelInfo[];
  tasks: Task[];
  onClose: () => void;
  onPatch: (patch: { title?: string; autoReply?: boolean; supModel?: string | null; maxTurns?: number; modelId?: string | null }) => void;
  onMemberPatch: (agentId: string, patch: { muted?: boolean; talk?: 'low' | 'normal' | 'high' }) => void;
  onAdd: (agentId: string) => void;
  onRemove: (agentId: string) => void;
  onDissolve: () => void;
  onLinkTask: (taskId: string) => void;
  onUnassignTask: (taskId: string) => void;
  onExport: () => void;
  onImport: (pkg: unknown) => void;
  onToast: (msg: string) => void;
  user: { id?: string; name: string; role: string; initial: string } | null;
  onInviteHuman: (name: string, role: string) => void;
  onEditWorkflow: () => void;
}) {
  const [title, setTitle] = useState(conv.title);
  const [picking, setPicking] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const memberIds = new Set(conv.members.map((m) => m.memberId));
  const available = agents.filter((a) => !memberIds.has(a.id));

  const convTasks = tasks.filter((t) => t.conversationId === conv.id);
  const activeTasks = convTasks.filter((t) => t.status !== 'done');
  const doneTasks = convTasks.filter((t) => t.status === 'done');
  const unassigned = tasks.filter((t) => t.status !== 'done' && !t.conversationId);

  async function readHandoff(file: File | undefined | null) {
    if (!file) return;
    try {
      const pkg = JSON.parse(await file.text());
      if (pkg?.kind !== 's-bot-handoff') {
        onToast('这不是 S-BOT 的交接文件');
        return;
      }
      onImport(pkg);
    } catch {
      onToast('文件解析失败，请选择导出的 .json');
    }
  }

  return (
    <aside className="drawer">
      <div className="drawer-head">
        <div><h3>群聊设置</h3><p>{conv.members.length} 个智能体</p></div>
        <button className="icon-btn" onClick={onClose}>✕</button>
      </div>
      <div className="drawer-body">
        <div className="dsec">
          <div className="dsec-title">群名称</div>
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => { if (title.trim() && title.trim() !== conv.title) onPatch({ title: title.trim() }); }}
          />
        </div>

        <div className="dsec">
          <div className="dsec-title">发言规则</div>
          <div className="drow">
            <div><div className="k">主持人决定谁说话</div><div className="d">关闭后只有被 @ 才会触发</div></div>
            <div className={`sw ${conv.autoReply ? 'on' : ''}`} onClick={() => onPatch({ autoReply: !conv.autoReply })} />
          </div>
          <div className="drow">
            <div><div className="k">主持人模型</div><div className="d">每轮多一次调用</div></div>
            <select className="dselect" value={conv.supModel ?? ''} onChange={(e) => onPatch({ supModel: e.target.value || null })}>
              <option value="">跟随默认</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          <div className="drow">
            <div><div className="k">会话模型</div><div className="d">覆盖所有智能体</div></div>
            <select className="dselect" value={conv.modelId ?? ''} onChange={(e) => onPatch({ modelId: e.target.value || null })}>
              <option value="">跟随默认</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          <div className="drow">
            <div><div className="k">单条消息最多发言</div><div className="d">无限制 = 两轮讨论，最后给结论；冲突 @ 所有真人</div></div>
            <select className="dselect" value={conv.maxTurns} onChange={(e) => onPatch({ maxTurns: Number(e.target.value) })}>
              {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n} 个</option>)}
              <option value={0}>无限制</option>
            </select>
          </div>
        </div>

        <div className="dsec">
          <div className="dsec-title">成员</div>
          {conv.members.map((m) => (
            <div key={m.memberId} className="mem">
              <div className="mem-top">
                <div className="av" style={{ width: 28, height: 28, flexBasis: 28, fontSize: 11, background: `${m.color}22`, border: `2px solid ${m.color}`, color: m.color }}>{m.initial}</div>
                <div><div className="mem-name" style={{ color: m.color }}>{m.name}</div><div className="mem-role">{m.role}</div></div>
                <button className="mini danger" title="移出群聊" onClick={() => { if (conv.members.length <= 1) return; onRemove(m.memberId); }}>−</button>
              </div>
              <div className="mem-bot">
                <span className="lbl">发言</span>
                <div className="seg">
                  {([['low', '少'], ['normal', '正常'], ['high', '多']] as const).map(([k, n]) => (
                    <button key={k} className={m.talk === k ? 'on' : ''} onClick={() => onMemberPatch(m.memberId, { talk: k })}>{n}</button>
                  ))}
                </div>
                <span className="lbl" style={{ marginLeft: 'auto' }}>静音</span>
                <div className={`sw ${m.muted ? 'on' : ''}`} onClick={() => onMemberPatch(m.memberId, { muted: !m.muted })} />
              </div>
            </div>
          ))}
        </div>

        <div className="dsec">
          <div className="dsec-title">添加智能体</div>
          {available.length === 0 && <div className="dsec-empty">所有智能体都在群里了</div>}
          {available.map((a) => (
            <button key={a.id} className="add-row" onClick={() => onAdd(a.id)}>
              <div className="av" style={{ width: 22, height: 22, flexBasis: 22, fontSize: 9.5, background: `${a.color}22`, border: `2px solid ${a.color}`, color: a.color }}>{a.initial}</div>
              <div><div className="add-name">{a.name}</div><div className="add-role">{a.role}</div></div>
              <span className="plus">+</span>
            </button>
          ))}
        </div>

        <div className="dsec">
          <div className="dsec-title">邀请同事</div>
          {!user && <div className="dsec-empty">登录后可以拉真人进群</div>}
          {user && conv.members.some((m) => m.memberId === user.id) && (
            <div className="dsec-empty">{user.name} 已经在群里了</div>
          )}
          {user && !conv.members.some((m) => m.memberId === user.id) && (
            <button className="add-row" onClick={() => onInviteHuman(user.name, user.role)}>
              <div className="av" style={{ width: 22, height: 22, flexBasis: 22, fontSize: 9.5, background: '#5B8CFF22', border: '2px solid #5B8CFF', color: '#5B8CFF' }}>{user.initial}</div>
              <div><div className="add-name">{user.name}</div><div className="add-role">{user.role} · 真人</div></div>
              <span className="plus">+</span>
            </button>
          )}
        </div>

        <div className="dsec">
          <div className="dsec-title">任务</div>
          {activeTasks.length === 0 && <div className="dsec-empty">这个群还没有进行中的任务</div>}
          {activeTasks.map((t) => (
            <div key={t.id} className="dtask">
              <span className={`dpri ${t.priority}`} />
              <div className="dtask-t">{t.title}</div>
              {t.status === 'awaiting' && <span className="dchip">待确认</span>}
              <button
                className="dlink"
                title="取消执行，回到待分配，让其他群接手"
                onClick={() => onUnassignTask(t.id)}
              >
                取消执行
              </button>
            </div>
          ))}
          {doneTasks.length > 0 && (
            <div className="dsec-hint">已完成 {doneTasks.length} 个（工作台可查看）</div>
          )}

          <button className="task-link-toggle" onClick={() => setPicking((v) => !v)}>
            {picking ? '收起待分配任务' : `+ 关联待分配任务${unassigned.length ? `（${unassigned.length}）` : ''}`}
          </button>
          {picking && (
            <div className="task-pick">
              {unassigned.length === 0 && <div className="dsec-empty">没有待分配的任务</div>}
              {unassigned.map((t) => (
                <div key={t.id} className="task-pick-row">
                  <span className={`dpri ${t.priority}`} />
                  <div className="dtask-t">{t.title}</div>
                  <button className="dlink" onClick={() => { onLinkTask(t.id); setPicking(false); }}>关联</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="dsec">
          <div className="dsec-title">交接</div>
          <div className="dsec-hint" style={{ marginTop: 0 }}>
            导出后到另一个群导入，聊天记录和任务会一起带过去，那个群可以直接接着做。
          </div>
          <div className="handoff-row">
            <button className="btn" onClick={onExport}>导出聊天记录</button>
            <button className="btn" onClick={() => fileRef.current?.click()}>导入到本群</button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => { void readHandoff(e.target.files?.[0]); e.target.value = ''; }}
            />
          </div>
        </div>

        <div className="dsec">
          <div className="dsec-title">聊天逻辑</div>
          <div className="dsec-hint" style={{ marginTop: 0 }}>这张图决定群里谁在什么时候说话，以及什么时候停。</div>
          <button className="btn" onClick={onEditWorkflow}>编辑聊天逻辑</button>
        </div>

        <div className="dsec danger-zone">
          <button className="btn danger" onClick={onDissolve}>解散群聊</button>
        </div>
      </div>
    </aside>
  );
}

/* ---------- opencode 审批 ---------- */

const ACTION_TEXT: Record<string, string> = {
  edit: '写入文件',
  shell: '执行命令',
  external_directory: '访问外部目录',
  read: '读取文件',
  webfetch: '访问网页',
  websearch: '联网搜索',
};

export function PermissionDialog({
  request,
  agentName,
  onDecide,
}: {
  request: { action: string; resources: string[] };
  agentName: string;
  onDecide: (decision: 'once' | 'always' | 'reject') => void;
}) {
  const action = ACTION_TEXT[request.action] ?? request.action;
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onDecide('reject'); }}>
      <div className="sheet perm-sheet">
        <div className="sheet-head">
          <h3>需要你确认</h3>
          <p>{agentName} 想 {action}，需要你拍板。</p>
        </div>
        <div className="sheet-body">
          <div className="perm-action">{action}</div>
          <div className="perm-list">
            {request.resources.map((r) => <code key={r}>{r}</code>)}
          </div>
          <div className="perm-hint">允许后它才会继续；60 秒不处理会按拒绝处理。</div>
        </div>
        <div className="sheet-foot perm-foot">
          <button className="btn" onClick={() => onDecide('reject')}>拒绝</button>
          <button className="btn" onClick={() => onDecide('always')}>总是允许</button>
          <button className="btn primary" onClick={() => onDecide('once')}>允许一次</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- 聊天逻辑：真人确认 ---------- */

export function WorkflowApprovalDialog({
  title,
  nodeLabel,
  onDecide,
}: {
  title: string;
  nodeLabel: string;
  onDecide: (decision: 'pass' | 'changes') => void;
}) {
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) return; }}>
      <div className="sheet perm-sheet">
        <div className="sheet-head">
          <h3>{title || '需要你确认'}</h3>
          <p>聊天逻辑走到了「{nodeLabel || '真人确认'}」这一步。</p>
        </div>
        <div className="sheet-body">
          <div className="perm-action">确认这一步的结果</div>
          <div className="perm-hint">通过就继续往下走；要改会回到修订节点。120 秒不处理按超时处理。</div>
        </div>
        <div className="sheet-foot perm-foot">
          <button className="btn" onClick={() => onDecide('changes')}>要改</button>
          <button className="btn primary" onClick={() => onDecide('pass')}>通过</button>
        </div>
      </div>
    </div>
  );
}
