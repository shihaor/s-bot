import { useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, ChatIntro, Conversation, Member, Message, ModelInfo, Task } from '@sbot/shared';
import confetti from 'canvas-confetti';
import {
  addHumanMember,
  addMember as addMemberApi,
  createAgent as createAgentApi,
  createGroup as createGroupApi,
  createTask as createTaskApi,
  deleteAgent as deleteAgentApi,
  deleteConversation as deleteConversationApi,
  deleteTask as deleteTaskApi,
  ensureDm as ensureDmApi,
  ensureHumanDm,
  exportConversation as exportConversationApi,
  fetchAgents,
  fetchConversations,
  fetchHumans,
  fetchMessages,
  fetchModels,
  fetchKbDatasets,
  fetchOpencodeStatus,
  fetchSettings,
  installOpencodeRuntime,
  fetchIntro,
  fetchRuntime,
  fetchTasks,
  importConversation as importConversationApi,
  heartbeatPresence,
  loginHuman,
  apiUrl,
  removeMember as removeMemberApi,
  replyHumanWait,
  replyPermission,
  resumeHumanWait,
  sendMessage,
  updateAgent as updateAgentApi,
  updateConversation,
  updateMember as updateMemberApi,
  updateTask as updateTaskApi,
  type KbDataset,
  type HumanInfo,
} from './api';
import { hasMemberDrag, readMemberDrag, setMemberDrag, type MemberPayload } from './drag';
import Home from './Home';
import Intro from './Intro';
import AgentsPage from './AgentsPage';
import SkillsPage from './SkillsPage';
import SettingsPage from './SettingsPage';
import { ColleagueSearchDialog, MattermostInviteDialog } from './Colleagues';
import { animateDrawer, animateIntro, animateOverlay, animatePanel, animateToast } from './anim';
import {
  ContextMenu,
  GroupDrawer,
  LoginDialog,
  NewGroupDialog,
  PermissionDialog,
  RenameDialog,
  SearchPanel,
  TaskDialog,
  type MenuItem,
} from './Panels';
import './styles.css';

interface Streaming {
  id: string;
  agentId: string;
  name: string;
  role: string;
  color: string;
  initial: string;
  text: string;
  tools: Array<{ toolId: string; name: string; detail: string; status: 'running' | 'ok' | 'failed' }>;
}

type Attachment = { type: 'image' | 'file'; name: string; size: number; dataUrl?: string };

function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtTime(ts: number) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function celebrate() {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) return;
  confetti({ particleCount: 120, spread: 70, startVelocity: 42, origin: { x: 0.5, y: 0.7 } });
  window.setTimeout(() => {
    confetti({ particleCount: 60, angle: 60, spread: 60, origin: { x: 0.15, y: 0.75 } });
    confetti({ particleCount: 60, angle: 120, spread: 60, origin: { x: 0.85, y: 0.75 } });
  }, 180);
}

function matchQuery(c: Conversation, q: string) {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;  return (
    c.title.toLowerCase().includes(needle) ||
    c.members.some((m) => m.name.toLowerCase().includes(needle) || m.role.toLowerCase().includes(needle)) ||
    (c.lastMessage?.text.toLowerCase().includes(needle) ?? false)
  );
}

const TOOL_LABELS: Record<string, string> = {
  read: '读取',
  write: '写入',
  edit: '修改',
  patch: '修改',
  shell: '执行',
  bash: '执行',
  glob: '查找',
  grep: '搜索',
  webfetch: '抓取',
  websearch: '搜索',
  list: '列出',
};

function toolLabel(name: string, detail?: string) {
  const label = TOOL_LABELS[name] ?? name;
  return detail ? `${label} ${detail}` : label;
}

function ToolRow({ tools }: { tools: Array<{ toolId: string; name: string; detail?: string; status: 'running' | 'ok' | 'failed' }> }) {
  if (!tools.length) return null;
  return (
    <div className="tool-row">
      {tools.map((t) => (
        <span key={t.toolId} className={`tool-chip ${t.status}`} title={t.name}>
          <span className="dot" />
          {toolLabel(t.name, t.detail)}
        </span>
      ))}
    </div>
  );
}

function RichText({ text }: { text: string }) {
  const parts = text.split(/(\[\d+\])/g);
  return (
    <>
      {parts.map((p, i) => (/^\[\d+\]$/.test(p)
        ? <sup key={i} className="cite-mark">{p}</sup>
        : <span key={i}>{p}</span>))}
    </>
  );
}

function renderParts(
  m: Message,
  onTaskAction: (id: string, status: Task['status']) => void,
  decisions: Record<string, 'done' | 'todo'>,
  onCitation: (c: { n: number; kb: string; doc: string; score: number; text: string }) => void,
) {
  if (!Array.isArray(m.parts) || m.parts.length === 0) return null;

  const files: any[] = [];
  const cards: any[] = [];
  const tools: Array<{ toolId: string; name: string; detail?: string; status: 'running' | 'ok' | 'failed' }> = [];
  const citations: Array<{ n: number; kb: string; doc: string; score: number; text: string }> = [];

  m.parts.forEach((p, i) => {
    const part = p as {
      type?: string;
      name?: string;
      size?: number;
      dataUrl?: string;
      taskId?: string;
      title?: string;
      toolId?: string;
      detail?: string;
      status?: 'running' | 'ok' | 'failed';
      n?: number;
      kb?: string;
      doc?: string;
      score?: number;
      text?: string;
    };
    if (part.type === 'task-confirm' && part.taskId) {
      const decided = decisions[part.taskId];
      cards.push(
        <div className="task-confirm-card" key={`t${i}`}>
          <div className="tc-head">任务确认</div>
          <div className="tc-title">{part.title}</div>
          <div className="tc-actions">
            <button className="btn" disabled={!!decided} onClick={() => onTaskAction(part.taskId!, 'todo')}>还没完</button>
            <button className="btn primary" disabled={!!decided} onClick={() => onTaskAction(part.taskId!, 'done')}>确认完成</button>
          </div>
          {decided && <div className="tc-done">{decided === 'done' ? '已确认完成' : '已标记未完成'}</div>}
        </div>,
      );
    } else if (part.type === 'tool' && part.toolId) {
      tools.push({
        toolId: part.toolId,
        name: part.name ?? 'tool',
        detail: part.detail,
        status: part.status ?? 'ok',
      });
    } else if (part.type === 'citation' && part.n) {
      citations.push({
        n: part.n,
        kb: part.kb ?? '知识库',
        doc: part.doc ?? '未命名文档',
        score: part.score ?? 0,
        text: part.text ?? '',
      });
    } else if (part.type === 'image' && part.dataUrl) {
      files.push(<img key={i} className="msg-img" src={part.dataUrl} alt="" onClick={() => window.open(part.dataUrl, '_blank')} />);
    } else {
      files.push(<div key={i} className="msg-file">📄 {part.name} · {fmtSize(Number(part.size ?? 0))}</div>);
    }
  });

  return (
    <>
      {files.length > 0 && <div className="msg-files">{files}</div>}
      <ToolRow tools={tools} />
      {citations.length > 0 && (
        <div className="cites">
          {citations.map((c) => (
            <button key={c.n} className="cite" onClick={() => onCitation(c)}>
              <span className="n">{c.n}</span>
              <span className="doc">{c.doc}</span>
            </button>
          ))}
        </div>
      )}
      {cards}
    </>
  );
}

function Avatar({ name, initial, color, size = 36 }: { name: string; initial: string; color: string; size?: number }) {
  return (
    <div
      className="av"
      title={name}
      style={{
        width: size,
        height: size,
        flexBasis: size,
        fontSize: size <= 24 ? 10 : size <= 30 ? 11.5 : 13,
        background: `${color}22`,
        border: `2px solid ${color}`,
        color,
      }}
    >
      {initial || name.slice(0, 1)}
    </div>
  );
}

function memberOf(conv: Conversation | null, id: string | null, agents: Agent[]): Member | Agent | null {
  if (!id) return null;
  const m = conv?.members.find((x) => x.memberId === id);
  if (m) return m;
  return agents.find((a) => a.id === id) ?? null;
}

export default function App() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [humans, setHumans] = useState<HumanInfo[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState<Streaming | null>(null);
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState('');
  const [runtime, setRuntime] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'chat' | 'home' | 'agents' | 'skills' | 'settings'>('chat');
  const [toast, setToast] = useState('');
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; conv: Conversation } | null>(null);
  const [renameTarget, setRenameTarget] = useState<Conversation | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [kbs, setKbs] = useState<KbDataset[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskDialog, setTaskDialog] = useState<{ task: Task | null } | null>(null);
  const [taskDecisions, setTaskDecisions] = useState<Record<string, 'done' | 'todo'>>({});
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [findColleaguesOpen, setFindColleaguesOpen] = useState(false);
  const [inviteExternalOpen, setInviteExternalOpen] = useState(false);
  const [inviteExternalUser, setInviteExternalUser] = useState('');
  const [intro, setIntro] = useState<ChatIntro | null>(null);
  const [introLoading, setIntroLoading] = useState(false);
  const [permissionReq, setPermissionReq] = useState<{
    requestID: string;
    action: string;
    resources: string[];
    agentId: string;
  } | null>(null);
  const [retrievingAgent, setRetrievingAgent] = useState<string | null>(null);
  const [selectedCitation, setSelectedCitation] = useState<{ n: number; kb: string; doc: string; score: number; text: string } | null>(null);
  const [ocSetup, setOcSetup] = useState<{ url: string; busy: boolean; error?: string } | null>(null);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const activeIdRef = useRef<string | null>(null);
  const runningRef = useRef(false);
  const [draggingMember, setDraggingMember] = useState<MemberPayload | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [chatDrop, setChatDrop] = useState(false);
  const [humanWait, setHumanWait] = useState<{
    runId: string;
    conversationId: string;
    humanId: string;
    name: string;
    role: string;
    color: string;
    seconds: number;
    deadline: number;
  } | null>(null);
  const [waitLeft, setWaitLeft] = useState(0);
  const [waitReply, setWaitReply] = useState('');
  const [waitBusy, setWaitBusy] = useState(false);
  const [user, setUser] = useState<{ id?: string; name: string; role: string; initial: string } | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [mention, setMention] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const active = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId],
  );
  const aiCount = active ? active.members.filter((m) => m.memberType === 'agent').length : 0;
  const humanCount = active ? active.members.length - aiCount : 0;
  const activeTaskCount = (conversationId: string) =>
    tasks.filter((t) => t.conversationId === conversationId && t.status !== 'done').length;

  // 已确认过的任务在刷新后仍保持卡片状态（不需要本地记忆）
  const decidedTasks = useMemo(() => {
    const map: Record<string, 'done' | 'todo'> = { ...taskDecisions };
    for (const t of tasks) {
      if (t.status === 'done' && !map[t.id]) map[t.id] = 'done';
    }
    return map;
  }, [taskDecisions, tasks]);

  // 离开群聊（切页 / 换会话）时收起群设置抽屉
  useEffect(() => {
    setDrawerOpen(false);
    setSearchOpen(false);
  }, [view, activeId]);

  useEffect(() => {
    activeIdRef.current = activeId;
    if (activeId) {
      setUnread((prev) => (prev[activeId] ? { ...prev, [activeId]: 0 } : prev));
    }
  }, [activeId]);

  // 服务端推送：别的客户端发消息 / 任务变化时刷新
  useEffect(() => {
    const es = new EventSource(apiUrl('/api/events'));
    const onEvent = (ev: MessageEvent) => {
      try {
        const e = JSON.parse(ev.data) as { type: string; conversationId?: string; data?: any };
        if (e.type === 'message' && e.data) {
          const p = e.data as {
            id?: string;
            conversationId: string;
            authorType: string;
            authorId?: string | null;
            authorName?: string | null;
            authorColor?: string | null;
            authorInitial?: string | null;
            role?: Message['role'];
            text?: string;
            createdAt?: number;
          };
          if (p.conversationId !== activeIdRef.current && (p.authorType === 'agent' || p.authorType === 'human')) {
            setUnread((prev) => ({ ...prev, [p.conversationId]: (prev[p.conversationId] ?? 0) + 1 }));
          }
          if (p.conversationId === activeIdRef.current && !runningRef.current) {
            void fetchMessages(p.conversationId).then(setMessages).catch(() => {});
          } else if (
            p.conversationId === activeIdRef.current &&
            p.authorType === 'human' &&
            p.authorId &&
            p.authorId !== localStorage.getItem('sbot.user')
          ) {
            // 软等待/模拟真人回复：run 还在进行时也把这条消息插进来
            setMessages((prev) => {
              if (!p.id || prev.some((m) => m.id === p.id)) return prev;
              return [
                ...prev,
                {
                  id: p.id,
                  conversationId: p.conversationId,
                  authorType: 'human',
                  authorId: p.authorId,
                  authorName: p.authorName ?? null,
                  authorColor: p.authorColor ?? null,
                  authorInitial: p.authorInitial ?? null,
                  role: p.role ?? 'user',
                  text: p.text ?? '',
                  parts: [],
                  modelId: null,
                  status: 'done',
                  createdAt: p.createdAt ?? Date.now(),
                } as Message,
              ];
            });
          }
          void refreshConversations();
        } else if (e.type === 'task') {
          void refreshTasks();
        } else if (e.type === 'presence') {
          void fetchHumans().then(setHumans).catch(() => {});
        } else if (e.type === 'human.wait') {
          const p = e.data as { runId: string; conversationId: string; humanId: string; name: string; role: string; color: string; seconds: number };
          setHumanWait({
            runId: p.runId,
            conversationId: p.conversationId,
            humanId: p.humanId,
            name: p.name,
            role: p.role,
            color: p.color,
            seconds: p.seconds,
            deadline: Date.now() + p.seconds * 1000,
          });
          setWaitReply('');
        } else if (e.type === 'human.resume') {
          const p = e.data as { runId: string };
          setHumanWait((cur) => (cur?.runId === p.runId ? null : cur));
        }
      } catch {
        /* ignore */
      }
    };
    es.addEventListener('message', onEvent);
    es.addEventListener('task', onEvent);
    es.addEventListener('presence', onEvent);
    es.addEventListener('human.wait', onEvent);
    es.addEventListener('human.resume', onEvent);
    return () => es.close();
  }, []);

  // 空会话第一次进入：拉开场白和推荐问题；有历史时同一份问题显示在输入框上方
  useEffect(() => {
    setIntro(null);
    if (loading || !activeId) {
      setIntroLoading(false);
      return;
    }
    let cancelled = false;
    setIntroLoading(true);
    fetchIntro(activeId)
      .then((d) => { if (!cancelled) setIntro(d); })
      .catch(() => {
        if (cancelled) return;
        const conv = conversations.find((c) => c.id === activeId);
        if (conv) {
          setIntro({
            kind: conv.type === 'dm' ? 'dm' : 'group',
            title: conv.title,
            greeting: conv.type === 'dm'
              ? `Hi，我是${conv.title}。有什么想让我帮你做的，直接说就行。`
              : `Hi，我们是「${conv.title}」团队。把目标丢进来，我们分头推进。`,
            suggestions: [],
          });
        }
      })
      .finally(() => { if (!cancelled) setIntroLoading(false); });
    return () => { cancelled = true; };
  }, [activeId, loading]);

  // 审批卡片 60 秒没点 → 自动关闭（服务端也会按拒绝处理）
  useEffect(() => {
    if (!permissionReq) return;
    const timer = window.setTimeout(() => {
      setPermissionReq(null);
      showToast('审批超时，已按拒绝处理');
    }, 62000);
    return () => window.clearTimeout(timer);
  }, [permissionReq]);

  // 登录后每 30 秒报一次在线，别的客户端就能看到「真人在线」
  useEffect(() => {
    if (!user?.id) return;
    let alive = true;
    const tick = () => { if (alive) void heartbeatPresence().catch(() => {}); };
    tick();
    const timer = window.setInterval(tick, 30000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [user?.id]);

  // 软等待倒计时
  useEffect(() => {
    if (!humanWait) {
      setWaitLeft(0);
      return;
    }
    const tick = () => setWaitLeft(Math.max(0, Math.ceil((humanWait.deadline - Date.now()) / 1000)));
    tick();
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [humanWait]);

  // 托盘退出时中断当前会话
  useEffect(() => {
    const sbot = (window as any).sbot;
    if (!sbot?.onAbort) return;
    return sbot.onAbort(() => {
      abortRef.current?.abort();
      setRunning(false);
      setStreaming(null);
    });
  }, []);

  // GSAP：弹窗渐显、抽屉滑入、开场白、toast
  const dialogKey = `${loginOpen}|${newGroupOpen}|${findColleaguesOpen}|${inviteExternalOpen}|${!!taskDialog}|${!!permissionReq}|${!!renameTarget}|${!!selectedCitation}|${!!ocSetup}`;
  useEffect(() => {
    const overlays = document.querySelectorAll('.overlay');
    animateOverlay((overlays[overlays.length - 1] as HTMLElement) ?? null);
    const panel = document.querySelector('.search-panel') as HTMLElement | null;
    if (panel) animatePanel(panel);
  }, [dialogKey]);

  useEffect(() => {
    animateDrawer(document.querySelector('.drawer') as HTMLElement | null);
  }, [drawerOpen]);

  useEffect(() => {
    animateIntro(document.querySelector('.intro') as HTMLElement | null);
  }, [intro]);

  useEffect(() => {
    animateToast(document.querySelector('.toast') as HTMLElement | null);
  }, [toast]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('sbot.userInfo');
      if (saved) setUser(JSON.parse(saved));
    } catch { /* ignore */ }
    (async () => {
      try {
        const [a, c, r, ms, ts, hs] = await Promise.all([
          fetchAgents(),
          fetchConversations(),
          fetchRuntime(),
          fetchModels(),
          fetchTasks(),
          fetchHumans(),
        ]);
        setAgents(a);
        setConversations(c);
        setModels(ms);
        setTasks(ts);
        setHumans(hs);
        setRuntime(r.mode === 'mock' ? '本地模式' : r.label);
        setActiveId(c.find((x) => x.type === 'group')?.id ?? c[0]?.id ?? null);
        void loadKbs();
        // 首次启动探测 opencode：没有就提示装离线包
        void fetchOpencodeStatus()
          .then(async (oc) => {
            if (oc.available) return;
            let url = 'http://10.201.1.19:80/artifactory/installer/opencode/OpenCode.zip';
            try { url = (await fetchSettings()).opencodeUrl || url; } catch { /* ignore */ }
            setOcSetup({ url, busy: false });
          })
          .catch(() => {});
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await fetchMessages(activeId);
        if (!cancelled) setMessages(list);
        requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        });
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, streaming?.text]);

  const groups = conversations.filter((c) => c.type === 'group' && matchQuery(c, searchQuery));
  const dms = conversations.filter(
    (c) => c.type === 'dm' && c.members[0]?.memberType === 'agent' && matchQuery(c, searchQuery),
  );

  /** 消息列里的同事：排除自己，在线优先；已经开过单聊的带上最近一条消息 */
  const humanColleagues = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return humans
      .filter((h) => h.id !== user?.id)
      .filter((h) => !q || h.name.toLowerCase().includes(q) || h.role.toLowerCase().includes(q))
      .map((human) => ({
        human,
        conv: conversations.find((c) => c.type === 'dm' && c.members.some((m) => m.memberId === human.id)),
      }))
      .sort((a, b) => Number(!!b.human.online) - Number(!!a.human.online));
  }, [humans, conversations, user?.id, searchQuery]);

  async function refreshConversations() {
    try {
      const c = await fetchConversations();
      setConversations(c);
    } catch {
      /* ignore */
    }
  }

  /** 从消息列打开和同事的单聊，没有就建一个 */
  async function openHumanDm(human: HumanInfo) {
    const existing = conversations.find(
      (c) => c.type === 'dm' && c.members.some((m) => m.memberId === human.id),
    );
    if (existing) {
      setActiveId(existing.id);
      setView('chat');
      return;
    }
    try {
      const conv = await ensureHumanDm(human.id);
      await refreshConversations();
      setActiveId(conv.id);
      setView('chat');
    } catch (e) {
      showToast(String(e));
    }
  }

  async function openHumanDmById(id: string) {
    const human = humans.find((h) => h.id === id);
    if (human) {
      await openHumanDm(human);
      return;
    }
    try {
      const conv = await ensureHumanDm(id);
      await refreshConversations();
      setActiveId(conv.id);
      setView('chat');
    } catch (e) {
      showToast(String(e));
    }
  }

  function showToast(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? '' : t)), 2200);
  }

  async function openAgentDm(agentId: string) {
    try {
      const conv = await ensureDmApi(agentId);
      setConversations((prev) => (prev.some((c) => c.id === conv.id) ? prev : [conv, ...prev]));
      setActiveId(conv.id);
      setView('chat');
    } catch (e) {
      showToast(String(e));
    }
  }

  async function handleCreateAgent(input: {
    name: string;
    role: string;
    color: string;
    description: string;
    skills: string[];
    systemPrompt: string;
    modelId: string | null;
    visibility: 'team' | 'private';
    tools: { read?: boolean; web?: boolean; shell?: boolean };
    kbIds: string[];
  }) {
    try {
      const agent = await createAgentApi(input);
      setAgents((prev) => [...prev, agent]);
      showToast(`已创建「${agent.name}」`);
    } catch (e) {
      showToast(String(e));
    }
  }

  async function handleUpdateAgent(id: string, input: Parameters<typeof handleCreateAgent>[0]) {
    try {
      const agent = await updateAgentApi(id, input);
      setAgents((prev) => prev.map((a) => (a.id === id ? agent : a)));
      showToast('已保存');
    } catch (e) {
      showToast(String(e));
    }
  }

  async function handleDeleteAgent(id: string) {
    try {
      await deleteAgentApi(id);
      setAgents((prev) => prev.filter((a) => a.id !== id));
      const list = await fetchConversations();
      setConversations(list);
      showToast('已删除');
    } catch (e) {
      showToast(String(e));
    }
  }

  async function handleDuplicateAgent(agent: Agent) {
    try {
      const copy = await createAgentApi({
        name: `${agent.name} 2`,
        role: agent.role,
        color: agent.color,
        description: agent.description,
        skills: agent.skills,
        systemPrompt: agent.systemPrompt,
        modelId: agent.modelId,
        visibility: agent.visibility,
        tools: agent.tools,
        kbIds: agent.kbIds,
      } as any);
      setAgents((prev) => [...prev, copy]);
      showToast(`已复制为「${copy.name}」`);
    } catch (e) {
      showToast(String(e));
    }
  }

  async function handleCreateGroup(title: string, memberIds: string[]) {
    try {
      const conv = await createGroupApi(title, memberIds);
      setConversations((prev) => [conv, ...prev]);
      setActiveId(conv.id);
      setView('chat');
      setNewGroupOpen(false);
      showToast('群聊已创建');
    } catch (e) {
      showToast(String(e));
    }
  }

  async function refreshTasks() {
    try {
      setTasks(await fetchTasks());
    } catch {
      /* ignore */
    }
  }

  async function loadKbs() {
    try {
      setKbs(await fetchKbDatasets());
    } catch {
      /* RAGFlow 不可达时不影响其他功能 */
    }
  }

  async function saveTask(input: {
    title: string;
    description: string;
    conversationId: string | null;
    priority: 'high' | 'mid' | 'low';
  }) {
    const editing = taskDialog?.task ?? null;
    try {
      if (editing) await updateTaskApi(editing.id, input);
      else await createTaskApi(input);
      await refreshTasks();
      setTaskDialog(null);
      showToast(editing ? '任务已更新' : '任务已创建');
    } catch (e) {
      showToast(String(e));
    }
  }

  async function toggleTaskDone(task: Task) {
    await handleTaskStatus(task.id, task.status === 'done' ? 'todo' : 'done');
  }

  async function handleTaskStatus(id: string, status: Task['status']) {
    try {
      await updateTaskApi(id, { status });
      await refreshTasks();
      if (status === 'done') {
        setTaskDecisions((prev) => ({ ...prev, [id]: 'done' }));
        celebrate();
        showToast('任务已完成 🎉');
      } else {
        setTaskDecisions((prev) => ({ ...prev, [id]: 'todo' }));
      }
    } catch (e) {
      showToast(String(e));
    }
  }

  async function handleDeleteTask(id: string) {
    if (!window.confirm('删除这个任务？')) return;
    try {
      await deleteTaskApi(id);
      await refreshTasks();
      showToast('任务已删除');
    } catch (e) {
      showToast(String(e));
    }
  }

  function openTaskConv(conversationId: string) {
    if (!conversations.some((c) => c.id === conversationId)) {
      showToast('关联的群聊已不存在');
      return;
    }
    setActiveId(conversationId);
    setView('chat');
  }

  async function linkTaskToActive(taskId: string) {
    if (!active) return;
    try {
      await updateTaskApi(taskId, { conversationId: active.id });
      await refreshTasks();
      showToast('任务已关联到本群');
    } catch (e) {
      showToast(String(e));
    }
  }

  async function unassignTask(taskId: string) {
    const t = tasks.find((x) => x.id === taskId);
    if (t && !window.confirm(`取消执行「${t.title}」？\n它会回到待分配，其他群可以接手。`)) return;
    try {
      await updateTaskApi(taskId, { conversationId: null, status: 'todo' });
      await refreshTasks();
      showToast('已取消执行，任务回到待分配');
    } catch (e) {
      showToast(String(e));
    }
  }

  async function importIntoActive(pkg: unknown) {
    if (!active) return;
    try {
      const r = await importConversationApi(active.id, pkg);
      await refreshTasks();
      setMessages(await fetchMessages(active.id));
      setConversations(await fetchConversations());
      showToast(`已导入 ${r.importedMessages} 条记录${r.importedTasks ? `、${r.importedTasks} 个任务` : ''}`);
    } catch (e) {
      showToast(String(e));
    }
  }

  async function reloadActive() {
    try {
      const list = await fetchConversations();
      setConversations(list);
      if (activeId) setMessages(await fetchMessages(activeId));
    } catch (e) {
      showToast(String(e));
    }
  }

  async function refreshRuntimeInfo() {
    try {
      const r = await fetchRuntime();
      setRuntime(r.mode === 'mock' ? '本地模式' : r.label);
    } catch {
      /* ignore */
    }
  }

  async function patchConv(c: Conversation, patch: { title?: string; pinned?: boolean; muted?: boolean }) {
    try {
      await updateConversation(c.id, patch);
      await reloadActive();
      showToast('已更新');
    } catch (e) {
      showToast(String(e));
    }
  }

  async function removeConversation(c: Conversation) {
    if (!window.confirm(`删除「${c.title}」？聊天记录会一起删除。`)) return;
    try {
      await deleteConversationApi(c.id);
      const list = await fetchConversations();
      setConversations(list);
      if (activeId === c.id) setActiveId(list[0]?.id ?? null);
      setDrawerOpen(false);
      showToast('已删除');
    } catch (e) {
      showToast(String(e));
    }
  }

  async function exportConversation(c: Conversation) {
    try {
      const pkg = await exportConversationApi(c.id);
      const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      const a = document.createElement('a');
      a.href = url;
      a.download = `${c.title.replace(/[\\/:*?"<>|]/g, '_')}-交接-${stamp}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(`已导出 ${pkg.messages.length} 条记录${pkg.tasks.length ? `、${pkg.tasks.length} 个任务` : ''}`);
    } catch (e) {
      showToast(String(e));
    }
  }

  function jumpToMessage(id: string) {
    const el = document.getElementById(`m-${id}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('flash');
    window.setTimeout(() => el.classList.remove('flash'), 1600);
  }

  async function addMemberToActive(agentId: string) {
    if (!active) return;
    try {
      await addMemberApi(active.id, agentId);
      await reloadActive();
      showToast('已加入群聊');
    } catch (e) {
      showToast(String(e));
    }
  }

  async function inviteHumanToActive(name: string, role: string) {
    if (!active) return;
    try {
      await addHumanMember(active.id, name, role);
      await reloadActive();
      showToast(`${name} 已加入群聊`);
    } catch (e) {
      showToast(String(e));
    }
  }

  /** 把智能体或真人拖到群聊上（左侧列表 / 聊天详情页都走这里） */
  async function dropMemberIntoGroup(convId: string, payload: MemberPayload) {
    const conv = conversations.find((c) => c.id === convId);
    if (!conv || conv.type !== 'group') return;

    if (payload.kind === 'agent') {
      const agent = agents.find((a) => a.id === payload.id);
      if (!agent) return;
      if (conv.members.some((m) => m.memberId === agent.id)) {
        showToast(`「${agent.name}」已经在「${conv.title}」里了`);
        return;
      }
      if (conv.members.filter((m) => m.memberType === 'agent').length >= 6) {
        showToast('群聊最多 6 个智能体');
        return;
      }
      try {
        await addMemberApi(convId, agent.id);
        showToast(`「${agent.name}」已加入「${conv.title}」`);
      } catch (e) {
        showToast(String(e));
        return;
      }
    } else {
      const human = humans.find((h) => h.id === payload.id);
      const name = human?.name ?? payload.name;
      if (!name) return;
      if (conv.members.some((m) => m.memberType === 'human' && (m.memberId === payload.id || m.name === name))) {
        showToast(`「${name}」已经在「${conv.title}」里了`);
        return;
      }
      try {
        await addHumanMember(convId, name, human?.role ?? '');
        setHumans(await fetchHumans());
        showToast(`「${name}」已加入「${conv.title}」`);
      } catch (e) {
        showToast(String(e));
        return;
      }
    }

    await refreshConversations();
    if (activeId === convId) setMessages(await fetchMessages(convId));
  }

  async function removeMemberFromActive(agentId: string) {
    if (!active) return;
    try {
      await removeMemberApi(active.id, agentId);
      await reloadActive();
      showToast('已移出群聊');
    } catch (e) {
      showToast(String(e));
    }
  }

  async function patchMember(agentId: string, patch: { muted?: boolean; talk?: 'low' | 'normal' | 'high' }) {
    if (!active) return;
    try {
      await updateMemberApi(active.id, agentId, patch);
      await reloadActive();
    } catch (e) {
      showToast(String(e));
    }
  }

  function convMenuItems(c: Conversation): MenuItem[] {
    const items: MenuItem[] = [
      { label: c.pinned ? '取消置顶' : '置顶聊天', onClick: () => void patchConv(c, { pinned: !c.pinned }) },
      { label: c.muted ? '取消免打扰' : '消息免打扰', onClick: () => void patchConv(c, { muted: !c.muted }) },
      { label: '重命名', onClick: () => setRenameTarget(c) },
    ];
    if (c.type === 'group') {
      items.push({ label: '群聊设置', onClick: () => { setActiveId(c.id); setView('chat'); setDrawerOpen(true); } });
    }
    items.push({ label: '导出聊天记录', onClick: () => void exportConversation(c) });
    items.push({
      label: c.type === 'group' ? '解散群聊' : '删除会话',
      danger: true,
      onClick: () => void removeConversation(c),
    });
    return items;
  }

  function readFile(file: File): Promise<Attachment> {
    return new Promise((resolve) => {
      const base: Attachment = { type: 'file', name: file.name, size: file.size };
      if (file.type.startsWith('image/')) {
        base.type = 'image';
        const reader = new FileReader();
        reader.onload = () => resolve({ ...base, dataUrl: String(reader.result) });
        reader.readAsDataURL(file);
      } else {
        resolve(base);
      }
    });
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const room = Math.max(0, 5 - attachments.length);
    if (room === 0) { showToast('最多 5 个附件'); return; }
    const picked = [...files].slice(0, room);
    const items = await Promise.all(picked.map(readFile));
    setAttachments((prev) => [...prev, ...items]);
  }

  function insertMention(name: string) {
    setInput((prev) => prev.replace(/@([^\s@]*)$/, `@${name} `));
    setMention(null);
  }

  function insertAtSign() {
    const el = inputRef.current;
    const pos = el?.selectionStart ?? input.length;
    setInput(input.slice(0, pos) + '@' + input.slice(pos));
    setMention('');
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos + 1, pos + 1);
    });
  }

  const mentionCandidates = useMemo(() => {
    if (mention === null || !active) return [];
    const q = mention.toLowerCase();
    return active.members
      .filter((m) => m.memberType === 'agent')
      .filter((m) => !q || m.name.toLowerCase().includes(q) || m.role.includes(q));
  }, [mention, active]);

  async function submitHumanWait() {
    if (!humanWait || waitBusy) return;
    const text = waitReply.trim();
    if (!text) return;
    setWaitBusy(true);
    try {
      const msg = await replyHumanWait(humanWait.runId, text);
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
      setWaitReply('');
      setHumanWait(null);
    } catch (e) {
      showToast(String(e));
    } finally {
      setWaitBusy(false);
    }
  }

  async function decideHumanWait(action: 'continue' | 'skip') {
    if (!humanWait || waitBusy) return;
    setWaitBusy(true);
    try {
      await resumeHumanWait(humanWait.runId, action);
      setHumanWait(null);
    } catch (e) {
      showToast(String(e));
    } finally {
      setWaitBusy(false);
    }
  }

  async function handleSend(override?: string) {
    const text = (override ?? input).trim();
    const parts = override ? [] : attachments.map((a) => ({ ...a }));
    if ((!text && parts.length === 0) || !activeId || running) return;

    const runConv = activeId;
    if (!override) setInput('');
    setRunning(true);
    runningRef.current = true;
    setError('');
    setAttachments([]);

    const optimistic: Message = {
      id: `local_${Date.now()}`,
      conversationId: activeId,
      authorType: 'user',
      authorId: null,
      role: 'user',
      text,
      parts,
      modelId: null,
      status: 'done',
      createdAt: Date.now(),
    };
    setMessages((prev) => [...prev, optimistic]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await sendMessage(
        activeId,
        { text, parts },
        (e) => {
          if (e.type === 'message.start') {
            setRetrievingAgent(null);
            setStreaming({
              id: e.id,
              agentId: e.agentId,
              name: e.name,
              role: e.role,
              color: e.color,
              initial: e.initial,
              text: '',
              tools: [],
            });
          } else if (e.type === 'retrieval.start') {
            setRetrievingAgent(e.agentId);
          } else if (e.type === 'retrieval.done') {
            setRetrievingAgent(null);
          } else if (e.type === 'message.delta') {
            setStreaming((s) => (s ? { ...s, text: s.text + e.delta } : s));
          } else if (e.type === 'tool') {
            setStreaming((s) => {
              if (!s) return s;
              const tools = [...s.tools];
              const idx = tools.findIndex((t) => t.toolId === e.toolId);
              if (idx >= 0) {
                tools[idx] = {
                  ...tools[idx]!,
                  name: e.name ?? tools[idx]!.name,
                  detail: e.detail ?? tools[idx]!.detail,
                  status: e.status,
                };
              } else {
                tools.push({ toolId: e.toolId, name: e.name ?? 'tool', detail: e.detail ?? '', status: e.status });
              }
              return { ...s, tools };
            });
          } else if (e.type === 'permission.ask') {
            setPermissionReq({
              requestID: e.requestID,
              action: e.action,
              resources: e.resources,
              agentId: e.agentId,
            });
          } else if (e.type === 'human.wait') {
            setHumanWait({
              runId: e.runId,
              conversationId: e.conversationId,
              humanId: e.humanId,
              name: e.name,
              role: e.role,
              color: e.color,
              seconds: e.seconds,
              deadline: Date.now() + e.seconds * 1000,
            });
            setWaitReply('');
            if (document.hidden || !document.hasFocus()) {
              const where = conversations.find((c) => c.id === runConv)?.title ?? 'S-BOT';
              (window as any).sbot?.notify?.(`${e.name} · ${where}`, '智能体在等你拍板');
            }
          } else if (e.type === 'human.resume') {
            setHumanWait((cur) => (cur?.runId === e.runId ? null : cur));
          } else if (e.type === 'message.end') {
            setStreaming(null);
            if (document.hidden || !document.hasFocus()) {
              const who = agents.find((a) => a.id === e.agentId)?.name ?? '智能体';
              const where = conversations.find((c) => c.id === runConv)?.title ?? 'S-BOT';
              (window as any).sbot?.notify?.(`${who} · ${where}`, e.text.slice(0, 90));
            }
            if (activeIdRef.current === runConv) {
              setMessages((prev) => [
                ...prev,
                {
                  id: e.savedId,
                  conversationId: runConv,
                  authorType: 'agent',
                  authorId: e.agentId,
                  role: 'assistant',
                  text: e.text,
                  parts: e.parts ?? [],
                  modelId: null,
                  status: 'done',
                  createdAt: e.createdAt,
                },
              ]);
            } else {
              setUnread((prev) => ({ ...prev, [runConv]: (prev[runConv] ?? 0) + 1 }));
            }
          } else if (e.type === 'task.confirm') {
            if (document.hidden || !document.hasFocus()) {
              (window as any).sbot?.notify?.('S-BOT', '有任务等你确认');
            }
            if (activeIdRef.current === runConv) setMessages((prev) => [...prev, e.message]);
            else setUnread((prev) => ({ ...prev, [runConv]: (prev[runConv] ?? 0) + 1 }));
            void refreshTasks();
            showToast('有任务等你确认');
          }
        },
        controller.signal,
      );
    } catch (e) {
      if (!controller.signal.aborted) setError(String(e));
    } finally {
      setRunning(false);
      runningRef.current = false;
      setStreaming(null);
      setPermissionReq(null);
      setHumanWait(null);
      abortRef.current = null;
      refreshConversations();
    }
  }

  function handleStop() {
    if (streaming?.text) {
      const s = streaming;
      setMessages((prev) => [
        ...prev,
        {
          id: `partial_${Date.now()}`,
          conversationId: activeId ?? '',
          authorType: 'agent',
          authorId: s.agentId,
          role: 'assistant',
          text: s.text,
          parts: [],
          modelId: null,
          status: 'interrupted',
          createdAt: Date.now(),
        },
      ]);
    }
    setStreaming(null);
    runningRef.current = false;
    abortRef.current?.abort();
  }

  if (loading) return <div className="boot">正在启动 S-BOT…</div>;

  const isElectron = /Electron/.test(navigator.userAgent);

  return (
    <div className="app">
      <div className="titlebar">
        <div className="brand">
          <div className="logo"><span>S</span></div>
          <b>S-BOT</b>
          <span
            className="mode"
            title="点击去设置里配置模型"
            style={{ cursor: 'pointer' }}
            onClick={() => setView('settings')}
          >
            {runtime || '本地'}
          </span>
        </div>
        {!isElectron && <div className="winbtns"><i>–</i><i>□</i><i>×</i></div>}
      </div>

      <div className="body">
        <nav className="rail">
          <div className="rail-logo" title="工作台" onClick={() => setView('home')}><span>S</span></div>
          <button className={`rail-btn ${view === 'chat' ? 'active' : ''}`} title="消息" onClick={() => setView('chat')}>
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.8-.8L3 20l1-4.3A8.4 8.4 0 0 1 12 3a8.4 8.4 0 0 1 9 8.5z" /></svg>
          </button>
          <button className={`rail-btn ${view === 'agents' ? 'active' : ''}`} title="智能体" onClick={() => setView('agents')}>
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="8" r="3.2" /><path d="M2.8 20a6.2 6.2 0 0 1 12.4 0" /><path d="M16.5 5.5a3 3 0 0 1 0 5.6" /><path d="M18 20a5.4 5.4 0 0 0-2.2-4.3" /></svg>
          </button>
          <button className={`rail-btn ${view === 'skills' ? 'active' : ''}`} title="技能" onClick={() => setView('skills')}>
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12z" /></svg>
          </button>
          <div className="spacer" />
          <button className={`rail-btn ${view === 'settings' ? 'active' : ''}`} title="设置" onClick={() => setView('settings')}>
            <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" /></svg>
          </button>
          <div className="me" title={user ? `${user.name} · 点击管理账号` : '点击登录'} onClick={() => setLoginOpen(true)}>
            {user ? user.initial : '我'}
            {user ? <span className="online-dot" /> : <span className="badge">未</span>}
          </div>
        </nav>

        <aside
          className="sidebar"
          style={{ display: view === 'agents' || view === 'skills' || view === 'settings' ? 'none' : 'flex' }}
        >
          <div className="side-head">
            <h1>消息</h1>
            <button className="side-add" title="发起群聊" aria-label="发起群聊" onClick={() => setNewGroupOpen(true)}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>
          <div className="search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input
              placeholder="搜索智能体或群聊"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && <button className="clear" title="清空" onClick={() => setSearchQuery('')}>×</button>}
          </div>
          <div className="side-scroll">
            <div className="sec">群聊 <span>{groups.length}</span></div>
            {groups.map((c) => (
              <div
                key={c.id}
                className={`conv ${activeId === c.id ? 'active' : ''} ${dropTargetId === c.id ? 'drop-target' : ''}`}
                onClick={() => { setActiveId(c.id); setView('chat'); setDrawerOpen(false); setSearchOpen(false); }}
                onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, conv: c }); }}
                onDragOver={(e) => {
                  if (!hasMemberDrag(e)) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'copy';
                  setDropTargetId(c.id);
                }}
                onDragLeave={(e) => {
                  if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) {
                    setDropTargetId((prev) => (prev === c.id ? null : prev));
                  }
                }}
                onDrop={(e) => {
                  if (!hasMemberDrag(e)) return;
                  e.preventDefault();
                  const payload = readMemberDrag(e);
                  setDropTargetId(null);
                  setDraggingMember(null);
                  if (payload) void dropMemberIntoGroup(c.id, payload);
                }}
              >
                <div className="stack">
                  {c.members.slice(0, 3).map((m) => (
                    <Avatar key={m.memberId} name={m.name} initial={m.initial} color={m.color} size={22} />
                  ))}
                </div>
                <div className="conv-main">
                  <div className="conv-top">
                    <span className="conv-name">{c.title}</span>
                    <span className="conv-right">
                      <span className="conv-time">{c.lastMessage ? fmtTime(c.lastMessage.at) : ''}</span>
                      <span className="conv-badges">
                        {activeTaskCount(c.id) > 0 && <span className="cb-task">{activeTaskCount(c.id)} 任务</span>}
                        {(unread[c.id] ?? 0) > 0 && <span className="cb-unread">{unread[c.id]}</span>}
                      </span>
                    </span>
                  </div>
                  <div className="conv-sub">
                    {c.lastMessage ? `${c.lastMessage.authorName}：${c.lastMessage.text}` : '还没有消息'}
                  </div>
                </div>
              </div>
            ))}

            <div className="sec">智能体 <span>{dms.length}</span></div>
            {dms.map((c) => {
              const m = c.members[0];
              return (
                <div
                  key={c.id}
                  className={`conv ${activeId === c.id ? 'active' : ''} ${draggingMember?.id === m?.memberId ? 'dragging' : ''}`}
                  draggable={!!m}
                  onDragStart={(e) => {
                    if (!m) return;
                    const payload: MemberPayload = { kind: 'agent', id: m.memberId, name: m.name };
                    setMemberDrag(e, payload);
                    setDraggingMember(payload);
                  }}
                  onDragEnd={() => { setDraggingMember(null); setDropTargetId(null); }}
                  onClick={() => { setActiveId(c.id); setView('chat'); setDrawerOpen(false); setSearchOpen(false); }}
                  onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, conv: c }); }}
                >
                  {m && <Avatar name={m.name} initial={m.initial} color={m.color} />}
                  <div className="conv-main">
                    <div className="conv-top">
                      <span className="conv-name">{c.title}</span>
                      <span className="conv-right">
                        <span className="conv-time">{c.lastMessage ? fmtTime(c.lastMessage.at) : ''}</span>
                        <span className="conv-badges">
                          {activeTaskCount(c.id) > 0 && <span className="cb-task">{activeTaskCount(c.id)} 任务</span>}
                          {(unread[c.id] ?? 0) > 0 && <span className="cb-unread">{unread[c.id]}</span>}
                        </span>
                      </span>
                    </div>
                    <div className="conv-sub">{c.lastMessage?.text ?? m?.role ?? ''}</div>
                  </div>
                </div>
              );
            })}

            {user && humanColleagues.length > 0 && (
              <>
                <div className="sec">同事 <span>{humanColleagues.filter(({ human }) => human.online).length} 在线</span></div>
                {humanColleagues.map(({ human: h, conv }) => (
                  <div
                    key={h.id}
                    className={`conv human ${conv && activeId === conv.id ? 'active' : ''}`}
                    draggable
                    title="点击单聊，拖到群聊可拉进群"
                    onDragStart={(e) => {
                      const payload: MemberPayload = { kind: 'human', id: h.id, name: h.name };
                      setMemberDrag(e, payload);
                      setDraggingMember(payload);
                    }}
                    onDragEnd={() => { setDraggingMember(null); setDropTargetId(null); }}
                    onClick={() => void openHumanDm(h)}
                  >
                    <span className="av-online-wrap">
                      <Avatar name={h.name} initial={h.initial} color={h.color} />
                      {h.online && <span className="human-online" />}
                    </span>
                    <div className="conv-main">
                      <div className="conv-top">
                        <span className="conv-name">{h.name}</span>
                        <span className="conv-right">
                          <span className={`conv-time ${h.online ? 'online-text' : ''}`}>{h.online ? '在线' : '离线'}</span>
                        </span>
                      </div>
                      <div className="conv-sub">
                        {conv?.lastMessage
                          ? `${conv.lastMessage.authorName}：${conv.lastMessage.text}`
                          : (h.role || '同事')}
                      </div>
                    </div>
                  </div>
                ))}
              </>
            )}

            {searchQuery && groups.length === 0 && dms.length === 0 && humanColleagues.length === 0 && (
              <div className="side-empty">没有匹配的会话</div>
            )}

            {!user && (
              <div className="locked-row" onClick={() => setLoginOpen(true)}>
                <div className="lk">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                    <rect x="4" y="10" width="16" height="10" rx="2" />
                    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
                  </svg>
                </div>
                <div>
                  <div className="t">登录后发现同事</div>
                  <div className="s">和真人单聊、拉群协作</div>
                </div>
              </div>
            )}
          </div>
        </aside>

        <main
          className={`main ${chatDrop ? 'drop-member' : ''}`}
          onDragOver={(e) => {
            if (view !== 'chat' || !active || active.type !== 'group' || !hasMemberDrag(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            setChatDrop(true);
          }}
          onDragLeave={(e) => {
            if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setChatDrop(false);
          }}
          onDrop={(e) => {
            if (view !== 'chat' || !active || active.type !== 'group' || !hasMemberDrag(e)) return;
            e.preventDefault();
            const payload = readMemberDrag(e);
            setChatDrop(false);
            setDraggingMember(null);
            if (payload) void dropMemberIntoGroup(active.id, payload);
          }}
        >
          {chatDrop && active?.type === 'group' && (
            <div className="chat-drop">
              <div className="chat-drop-card">
                <span>松开加入「{active.title}」</span>
                <b>{draggingMember?.name ?? '这位成员'}</b>
              </div>
            </div>
          )}
          {view === 'home' ? (
            <Home
              agents={agents}
              humans={humans}
              conversations={conversations}
              tasks={tasks}
              userName={user?.name ?? null}
              onOpenConv={openTaskConv}
              onOpenAgent={openAgentDm}
              onGoAgents={() => setView('agents')}
              onNewGroup={() => setNewGroupOpen(true)}
              onNewAgent={() => setView('agents')}
              onInvite={() => setLoginOpen(true)}
              onFindColleagues={() => setFindColleaguesOpen(true)}
              onInviteExternal={() => { setInviteExternalUser(''); setInviteExternalOpen(true); }}
              onToast={showToast}
              onNewTask={() => setTaskDialog({ task: null })}
              onEditTask={(t) => setTaskDialog({ task: t })}
              onToggleTask={(t) => void toggleTaskDone(t)}
              onDeleteTask={(id) => void handleDeleteTask(id)}
              onDragMember={setDraggingMember}
            />
          ) : view === 'agents' ? (
            <AgentsPage
              agents={agents}
              models={models}
              kbs={kbs}
              userId={user?.id}
              onOpen={openAgentDm}
              onCreate={handleCreateAgent}
              onUpdate={handleUpdateAgent}
              onDelete={handleDeleteAgent}
              onDuplicate={handleDuplicateAgent}
            />
          ) : view === 'skills' ? (
            <SkillsPage />
          ) : view === 'settings' ? (
            <SettingsPage
              onToast={showToast}
              onSaved={() => {
                void refreshRuntimeInfo();
                void fetchModels().then(setModels).catch(() => { /* ignore */ });
              }}
              onKbChanged={() => void loadKbs()}
            />
          ) : !active ? (
            <div className="empty">选一个会话开始</div>
          ) : (
            <>
              <header className="chat-head">
                <div>
                  <h2>{active.title}</h2>
                  <p>
                    {active.type === 'group'
                      ? `${aiCount} 个 AI · ${humanCount} 个真人${active.pinned ? ' · 已置顶' : ''}`
                      : (() => {
                          const m = active.members[0];
                          const h = m ? humans.find((x) => x.id === m.memberId) : null;
                          return h ? `${h.online ? '在线' : '离线'} · ${h.role || '同事'}` : m?.role;
                        })()}
                  </p>
                </div>
                <div className="spacer" />
                <div className="chip">{runtime || '本地'}</div>
                {active.type === 'group' && (
                  <button className="members-pill" title="成员 / 群聊设置" onClick={() => setDrawerOpen(true)}>
                    <span className="stack">
                      {active.members.slice(0, 3).map((m) => (
                        <span
                          key={m.memberId}
                          className="av"
                          style={{ width: 20, height: 20, flexBasis: 20, fontSize: 9, background: `${m.color}22`, border: `2px solid ${m.color}`, color: m.color }}
                        >
                          {m.initial}
                        </span>
                      ))}
                    </span>
                    <span>{aiCount} AI · {humanCount} 真人</span>
                  </button>
                )}
                <button className="icon-btn" title="搜索聊天记录" onClick={() => setSearchOpen(true)}>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
                </button>
                {active.type === 'group' && (
                  <button className="icon-btn" title="群聊设置" onClick={() => setDrawerOpen(true)}>
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
                      <circle cx="16" cy="7" r="2.2" />
                      <circle cx="8" cy="17" r="2.2" />
                    </svg>
                  </button>
                )}
              </header>

              <div className={`messages ${messages.length === 0 ? 'with-intro' : ''}`} ref={scrollRef}>
                {messages.length === 0 && !running && (
                  <Intro
                    intro={intro}
                    members={active.members}
                    loading={introLoading}
                    onAsk={(text) => void handleSend(text)}
                    onStartTask={() => setTaskDialog({ task: null })}
                  />
                )}
                <div className="msg-wrap">
                  {messages.map((m, i) => {
                    if (m.authorType === 'system') {
                      return <div key={m.id} id={`m-${m.id}`} className="sys-line">{m.text}</div>;
                    }
                    if (m.authorType === 'user' || (m.authorType === 'human' && m.authorId === user?.id)) {
                      return (
                        <div key={m.id} id={`m-${m.id}`} className="msg user">
                          <div className="msg-body">
                            {m.authorId === null && m.authorName && (
                              <div className="meta user-meta"><span className="name">{m.authorName}</span><span className="role">导入</span></div>
                            )}
                            <div className="bubble">{m.text}</div>
                            {renderParts(m, (id, status) => void handleTaskStatus(id, status), decidedTasks, (c) => setSelectedCitation(c))}
                          </div>
                        </div>
                      );
                    }
                    const person = memberOf(active, m.authorId, agents) ?? (m.authorName
                      ? ({
                          conversationId: m.conversationId,
                          memberId: `imported-${m.id}`,
                          memberType: 'agent',
                          name: m.authorName,
                          role: '来自交接记录',
                          color: m.authorColor ?? '#6B7385',
                          initial: m.authorInitial ?? m.authorName.slice(0, 1),
                          muted: false,
                          talk: 'normal',
                          online: false,
                        } as Member)
                      : null);
                    const prev = messages[i - 1];
                    const authorKey = m.authorId ?? m.authorName ?? 'unknown';
                    const prevKey = prev ? prev.authorId ?? prev.authorName ?? 'unknown' : null;
                    const same = prev && prev.authorType === 'agent' && prevKey === authorKey;
                    return (
                      <div key={m.id} id={`m-${m.id}`} className={`msg ${same ? '' : 'gap'}`}>
                        {!same && person ? (
                          <Avatar name={person.name} initial={person.initial} color={person.color} />
                        ) : (
                          <div style={{ width: 36, flex: '0 0 36px' }} />
                        )}
                        <div className="msg-body">
                          {!same && person && (
                            <div className="meta">
                              <span className="name" style={{ color: person.color }}>{person.name}</span>
                              <span className="role">{person.role}</span>
                              <span className="time">{fmtTime(m.createdAt)}</span>
                            </div>
                          )}
                          <div className="bubble"><RichText text={m.text} /></div>
                          {renderParts(m, (id, status) => void handleTaskStatus(id, status), decidedTasks, (c) => setSelectedCitation(c))}
                          {m.status === 'interrupted' && <div className="interrupted">■ 已中断</div>}
                        </div>
                      </div>
                    );
                  })}

                  {running && !streaming && (
                    <div className="msg gap">
                      <div className="typing">
                        <span className="dots"><i /><i /><i /></span>
                        {humanWait ? `等 ${humanWait.name} 回复…` : retrievingAgent ? '正在检索知识库…' : '正在思考…'}
                      </div>
                    </div>
                  )}

                  {streaming && (
                    <div className="msg gap">
                      <Avatar name={streaming.name} initial={streaming.initial} color={streaming.color} />
                      <div className="msg-body">
                        <div className="meta">
                          <span className="name" style={{ color: streaming.color }}>{streaming.name}</span>
                          <span className="role">{streaming.role}</span>
                        </div>
                        <div className="bubble">
                          <RichText text={streaming.text} />
                          <span className="cursor" />
                        </div>
                        <ToolRow tools={streaming.tools} />
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {error && <div className="error-line">{error}</div>}

              <footer className="composer-wrap">
                {humanWait && humanWait.conversationId === activeId && (
                  <div className="wait-bar">
                    <div className="wait-head">
                      <span
                        className="wait-avatar"
                        style={{ background: `${humanWait.color}22`, border: `2px solid ${humanWait.color}`, color: humanWait.color }}
                      >
                        {humanWait.name.slice(0, 1)}
                      </span>
                      <div className="wait-meta">
                        <b>等 {humanWait.name} 拍板</b>
                        <span>{waitLeft > 0 ? `${waitLeft}s 后自动继续` : '正在继续…'}{humanWait.role ? ` · ${humanWait.role}` : ''}</span>
                      </div>
                      <div className="wait-actions">
                        <button className="btn" disabled={waitBusy} onClick={() => void decideHumanWait('continue')}>继续</button>
                        <button className="btn" disabled={waitBusy} onClick={() => void decideHumanWait('skip')}>跳过</button>
                      </div>
                    </div>
                    <div className="wait-reply">
                      <input
                        className="input"
                        value={waitReply}
                        disabled={waitBusy}
                        placeholder={`以 ${humanWait.name} 的身份回一句…`}
                        onChange={(e) => setWaitReply(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void submitHumanWait();
                          }
                        }}
                      />
                      <button
                        className="btn primary"
                        disabled={waitBusy || !waitReply.trim()}
                        onClick={() => void submitHumanWait()}
                      >
                        回复
                      </button>
                    </div>
                  </div>
                )}
                {messages.length > 0 && intro && intro.suggestions.length > 0 && (
                  <div className="suggest-bar">
                    {intro.suggestions.map((q) => (
                      <button key={q} className="sugg bar-chip" disabled={running} onClick={() => void handleSend(q)}>
                        {q}
                      </button>
                    ))}
                  </div>
                )}
                {mention !== null && mentionCandidates.length > 0 && (
                  <div className="mention-menu">
                    {mentionCandidates.map((m) => (
                      <button key={m.memberId} className="mention-item" onClick={() => insertMention(m.name)}>
                        <span className="nm" style={{ color: m.color }}>{m.name}</span>
                        <span className="rl">{m.role}</span>
                      </button>
                    ))}
                  </div>
                )}

                <div
                  className={`composer-box ${dragOver ? 'drag' : ''}`}
                  onDragOver={(e) => {
                    if (hasMemberDrag(e)) return;
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    if (hasMemberDrag(e)) return;
                    e.preventDefault();
                    setDragOver(false);
                    void handleFiles(e.dataTransfer.files);
                  }}
                >
                  {attachments.length > 0 && (
                    <div className="attach-row">
                      {attachments.map((f, i) => (
                        <div key={`${f.name}-${i}`} className="attach">
                          {f.dataUrl ? <img src={f.dataUrl} alt="" /> : <div className="ico">📄</div>}
                          <div className="meta"><div className="nm">{f.name}</div><div className="sz">{fmtSize(f.size)}</div></div>
                          <button className="x" onClick={() => setAttachments((a) => a.filter((_, x) => x !== i))}>×</button>
                        </div>
                      ))}
                    </div>
                  )}

                  <textarea
                    ref={inputRef}
                    value={input}
                    onChange={(e) => {
                      const v = e.target.value;
                      setInput(v);
                      const pos = e.target.selectionStart ?? v.length;
                      const hit = v.slice(0, pos).match(/@([^\s@]*)$/);
                      setMention(hit ? hit[1]! : null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') { setMention(null); return; }
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        void handleSend();
                      }
                    }}
                    placeholder="发消息…  输入 @ 指定某个智能体，文件可直接拖进来"
                    rows={1}
                  />

                  <div className="composer-bar">
                    <button className="tool" title="附件" onClick={() => fileRef.current?.click()}>📎</button>
                    <button className="tool at" title="提及智能体" onClick={insertAtSign}>@</button>
                    <input ref={fileRef} type="file" multiple hidden onChange={(e) => { void handleFiles(e.target.files); e.target.value = ''; }} />
                    <div className="spacer" />
                    {running ? (
                      <button className="send stop" onClick={handleStop} title="停止">■</button>
                    ) : (
                      <button className="send" onClick={() => void handleSend()} disabled={!input.trim() && attachments.length === 0} title="发送">↑</button>
                    )}
                  </div>
                </div>

                <div className="hints">
                  <span><kbd>Enter</kbd> 发送 · <kbd>Shift</kbd>+<kbd>Enter</kbd> 换行 · <kbd>Esc</kbd> 中断</span>
                  <span>{attachments.length > 0 ? `${attachments.length}/5 附件` : ''}</span>
                </div>
              </footer>
            </>
          )}
        </main>
      </div>
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={convMenuItems(ctxMenu.conv)}
          onClose={() => setCtxMenu(null)}
        />
      )}
      {renameTarget && (
        <RenameDialog
          current={renameTarget.title}
          onCancel={() => setRenameTarget(null)}
          onSave={(v) => { const c = renameTarget; setRenameTarget(null); void patchConv(c, { title: v }); }}
        />
      )}
      {searchOpen && active && (
        <SearchPanel
          messages={messages}
          members={active.members}
          onJump={jumpToMessage}
          onClose={() => setSearchOpen(false)}
        />
      )}
      {drawerOpen && active?.type === 'group' && (
        <GroupDrawer
          conv={active}
          agents={agents}
          models={models}
          tasks={tasks}
          onClose={() => setDrawerOpen(false)}
          onPatch={(p) => void patchConv(active, p)}
          onMemberPatch={(id, p) => void patchMember(id, p)}
          onAdd={(id) => void addMemberToActive(id)}
          onRemove={(id) => void removeMemberFromActive(id)}
          onDissolve={() => void removeConversation(active)}
          onLinkTask={(id) => void linkTaskToActive(id)}
          onUnassignTask={(id) => void unassignTask(id)}
          onExport={() => void exportConversation(active)}
          onImport={(pkg) => void importIntoActive(pkg)}
          onToast={showToast}
          user={user}
          onInviteHuman={(name, role) => void inviteHumanToActive(name, role)}
        />
      )}
      {loginOpen && (
        <LoginDialog
          user={user}
          onClose={() => setLoginOpen(false)}
          onLogin={async () => {
            try {
              const human = await loginHuman('张伟', '前端工程师');
              localStorage.setItem('sbot.user', human.id);
              localStorage.setItem('sbot.userInfo', JSON.stringify({ id: human.id, name: human.name, role: human.role, initial: human.initial }));
              setUser({ id: human.id, name: human.name, role: human.role, initial: human.initial });
              setLoginOpen(false);
              // 重新拉一次智能体（私有智能体按身份过滤）
              setAgents(await fetchAgents());
              setConversations(await fetchConversations());
              const hs = await fetchHumans();
              setHumans(hs);
              const onlineOthers = hs.filter((h) => h.online && h.id !== human.id).length;
              showToast(onlineOthers ? `欢迎回来，张伟 · ${onlineOthers} 位同事在线` : '欢迎回来，张伟');
            } catch (e) {
              showToast(String(e));
            }
          }}
          onLogout={() => {
            localStorage.removeItem('sbot.user');
            localStorage.removeItem('sbot.userInfo');
            setUser(null);
            setLoginOpen(false);
            showToast('已退出登录，回到本地模式');
          }}
        />
      )}
      {findColleaguesOpen && (
        <ColleagueSearchDialog
          onClose={() => setFindColleaguesOpen(false)}
          onOpenLocal={(id) => {
            setFindColleaguesOpen(false);
            void openHumanDmById(id);
          }}
          onInviteMattermost={(username) => {
            setFindColleaguesOpen(false);
            setInviteExternalUser(username);
            setInviteExternalOpen(true);
          }}
          onToast={showToast}
        />
      )}
      {inviteExternalOpen && (
        <MattermostInviteDialog
          username={inviteExternalUser}
          message={active?.type === 'group' ? `来 S-BOT 一起协作吧，「${active.title}」的讨论需要你。` : ''}
          onClose={() => setInviteExternalOpen(false)}
          onOpenSettings={() => {
            setInviteExternalOpen(false);
            setView('settings');
          }}
          onToast={showToast}
        />
      )}
      {newGroupOpen && (
        <NewGroupDialog
          agents={agents}
          onCancel={() => setNewGroupOpen(false)}
          onCreate={(title, ids) => void handleCreateGroup(title, ids)}
        />
      )}
      {taskDialog && (
        <TaskDialog
          task={taskDialog.task}
          conversations={conversations}
          defaultConversationId={active?.type === 'group' ? active.id : null}
          onCancel={() => setTaskDialog(null)}
          onSave={(input) => void saveTask(input)}
        />
      )}
      {permissionReq && (
        <PermissionDialog
          request={permissionReq}
          agentName={agents.find((a) => a.id === permissionReq.agentId)?.name ?? '智能体'}
          onDecide={(decision) => {
            const id = permissionReq.requestID;
            setPermissionReq(null);
            replyPermission(id, decision).catch((e) => showToast(String(e)));
          }}
        />
      )}
      {selectedCitation && (
        <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setSelectedCitation(null); }}>
          <div className="sheet">
            <div className="sheet-head">
              <h3>引用 {selectedCitation.n} · {selectedCitation.kb}</h3>
              <p>{selectedCitation.doc} · 相似度 {selectedCitation.score.toFixed(3)}</p>
            </div>
            <div className="sheet-body">
              <div className="cite-body">{selectedCitation.text}</div>
            </div>
            <div className="sheet-foot">
              <span className="foot-note">来源：RAGFlow 检索分块</span>
              <button className="btn" onClick={() => setSelectedCitation(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}
      {ocSetup && (
        <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setOcSetup(null); }}>
          <div className="sheet">
            <div className="sheet-head">
              <h3>还差一个 opencode 运行时</h3>
              <p>装上之后智能体才能读写文件、跑命令；不装也能正常聊天。</p>
            </div>
            <div className="sheet-body">
              <label className="field"><span>离线包地址</span>
                <input
                  className="input"
                  value={ocSetup.url}
                  onChange={(e) => setOcSetup({ ...ocSetup, url: e.target.value, error: undefined })}
                  placeholder="http://10.201.1.19:80/artifactory/installer/opencode/OpenCode.zip"
                />
              </label>
              {ocSetup.error && (
                <p className="sub" style={{ color: 'var(--warn)', margin: '4px 0 0' }}>{ocSetup.error}</p>
              )}
              <p className="sub" style={{ margin: '10px 0 0' }}>
                已经装了 opencode 桌面版？去「设置 → opencode 运行时」点自动扫描，或直接填它的安装目录。
                内网下载不通时，让管理员把离线包放到上面的地址。
              </p>
            </div>
            <div className="sheet-foot">
              <button className="btn" onClick={() => { setOcSetup(null); setView('settings'); }}>去设置里指定目录</button>
              <button className="btn" onClick={() => setOcSetup(null)}>稍后</button>
              <button
                className="btn primary"
                disabled={ocSetup.busy}
                onClick={async () => {
                  setOcSetup({ ...ocSetup, busy: true, error: undefined });
                  const r = await installOpencodeRuntime(ocSetup.url.trim());
                  if (r.ok) {
                    showToast(`opencode ${r.version ?? ''} 安装完成`);
                    setOcSetup(null);
                  } else {
                    setOcSetup({ ...ocSetup, busy: false, error: r.error ?? '安装失败，可以在设置里手动指定安装目录' });
                  }
                }}
              >
                {ocSetup.busy ? '安装中…' : '下载并安装'}
              </button>
            </div>
          </div>
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
      {draggingMember && (
        <div className="drop-hint show">
          {draggingMember.name ? `把「${draggingMember.name}」` : '把成员'}拖到左侧群聊或群聊详情页，松开即可加入
        </div>
      )}
    </div>
  );
}
