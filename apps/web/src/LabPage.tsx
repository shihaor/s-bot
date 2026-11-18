import { useEffect, useMemo, useRef } from 'react';
import type { Agent } from '@sbot/shared';
import hqTemplate from './lab/hq.template.html?raw';
import { mountHQ } from './lab/hq.mount';
import { fetchLabDream } from './api';

/**
 * 实验室：从「实验室/index.html」里抠出来的主题 10 · HQ 智能总部。
 *
 * 主题自带一套 Shadow DOM 样式和原生 WebGL 渲染脚本（不依赖 three.js），
 * 这里只负责把模板塞进 shadow root、启动渲染，并在切走时停掉动画循环。
 * 四个分区（资料查询区 / 休息区 / 任务分配区 / 工位区）都在 3D 里。
 */
type LabHost = HTMLDivElement & {
  __stop?: () => void;
  __boss?: (name: string) => string;
  __pad?: (pad: Record<string, number>) => void;
  /** 挂载前塞给主题的成员名单（[名字, 岗位, 工位块, 是Agent, 是负责人, 发型, 发色, 衣服色, 肤色, 技能]） */
  __seedRoster?: unknown[];
  /** 挂载前塞给主题的工位块名称（按 S-BOT 的群聊分组） */
  __seedGroups?: unknown[];
  /** 挂载前塞给主题的真人督办（坐在任务分配区） */
  __seedHumans?: unknown[];
  /** 外壳接管「新增任务」 */
  __newTask?: () => void;
  /** 派任务后触发「进门领任务」动画 */
  __pickup?: () => boolean;
  /** 点人物气泡时打开对应会话 */
  __openChat?: ((name: string) => void) | null;
  /** 右侧动态 */
  __feed?: (items: Array<{ t: string; a: string; c: string; x: string }>) => number;
  /** 底栏任务列表 */
  __tasks?: (items: Array<{ id: string; title: string; status: string; priority: string; assignee?: string; at?: string }>) => number;
  /** 左上「智能组织」统计 */
  __org?: (o: { pct: number; total: number; doing: number; review: number; done: number; agents: number; groups: number; seg: string[] }) => boolean;
  /** 群组百分比：任务完成比例 */
  __groupPct?: (list: (number | null)[]) => number;
  /** 等授权的智能体 */
  __auth?: (name: string | null) => void;
  /** RAGFlow 对接状态 / 有知识库的智能体 / 打开设置 */
  __ragflow?: (ok: boolean) => void;
  __kbAgents?: (names: string[]) => void;
  __openSettings?: (() => void) | null;
  /** 人员管理里的「新增成员」交给外壳（对话式创建） */
  __newAgent?: (() => void) | null;
  /** 真实任务映射 */
  __agentTasks?: (map: Record<string, { title: string; status: string }>) => void;
  /** 做梦：按最近记忆生成梦境（name, role, 回调） */
  __dreamAsk?: ((name: string, role: string, cb: (lines: string[]) => void) => void) | null;
};

/** 一个群聊：标题 + 里面的智能体 id */
export type LabGroup = { id: string; title: string; memberIds: string[] };
/** 真人督办 */
export type LabHuman = { id: string; name: string; role: string; online?: boolean };
/** 右侧动态的一条 */
type LabFeedItem = { who: string; color: string; text: string; at: number };
/** 底栏任务 */
type LabTask = { id: string; title: string; status: string; priority: string; assignee?: string; at?: string; conversationId?: string | null; assigneeId?: string | null };
/** 左上统计 */
type LabOrg = { pct: number; total: number; doing: number; review: number; done: number; agents: number; groups: number; seg: string[] };

const SLOT_MAX = 8;
const HAIR = ['#2a221c', '#151515', '#5a3a22', '#3a7bd5', '#b99bff', '#3fc1a8'];
const SKIN = ['#f6d5b8', '#eec39a', '#f3cfb0', '#d9a77c', '#f6d8be', '#f2cba6'];
const SLOT_COLORS = ['#ffb547', '#ff7eb6', '#4fe0a6', '#5cc8ff', '#b99bff', '#c8e05a', '#e0b48a', '#ff8a5c'];

/**
 * 把 S-BOT 的群聊 + 智能体整理成工位块：
 * 一个群 = 一个工位块（同群的坐一起），不在任何群里的统一进「未分组」。
 */
function buildLayout(agents: Agent[], groups: LabGroup[]) {
  const capped = groups.slice(0, SLOT_MAX);
  const slotOf = new Map<string, number>();
  capped.forEach((g, i) => g.memberIds.forEach((id) => { if (!slotOf.has(id)) slotOf.set(id, i); }));

  let used = capped;
  let ungrouped = agents.filter((a) => !slotOf.has(a.id));
  // 留一个位置给「未分组」
  if (used.length >= SLOT_MAX && ungrouped.length) {
    used = used.slice(0, SLOT_MAX - 1);
    const keep = new Set(used.flatMap((g) => g.memberIds));
    ungrouped = agents.filter((a) => !keep.has(a.id));
    slotOf.clear();
    used.forEach((g, i) => g.memberIds.forEach((id) => { if (!slotOf.has(id)) slotOf.set(id, i); }));
  }

  const slots: { zh: string; en: string; c: string }[] = used.map((g, i) => {
    const first = agents.find((a) => g.memberIds.includes(a.id));
    const c = first && /^#[0-9a-f]{6}$/i.test(first.color) ? first.color : SLOT_COLORS[i % SLOT_COLORS.length]!;
    return { zh: (g.title || '未命名群').slice(0, 8), en: `GROUP ${String(i + 1).padStart(2, '0')}`, c };
  });
  if (ungrouped.length) slots.push({ zh: '未分组', en: 'UNGROUPED', c: '#8a8f9c' });
  // 一个群都没有、也没有成员时，第一块也写「未分组」
  if (!slots.length) slots.push({ zh: '未分组', en: 'UNGROUPED', c: '#8a8f9c' });

  const rows: unknown[][] = [];
  const perSlot = new Map<number, number>();
  const ordered = [...agents.filter((a) => slotOf.has(a.id)), ...ungrouped];
  ordered.slice(0, 56).forEach((a, i) => {
    const d = slotOf.get(a.id) ?? (slots.length - 1);
    const n = perSlot.get(d) ?? 0;
    perSlot.set(d, n + 1);
    rows.push([
      (a.name || '智能体').slice(0, 8),
      (a.role || '智能体').slice(0, 14),
      d,
      1,
      n === 0 ? 1 : 0,
      i % 5,
      HAIR[i % HAIR.length],
      /^#[0-9a-f]{6}$/i.test(a.color) ? a.color : '#7fd3ff',
      SKIN[i % SKIN.length],
      (a.skills ?? []).slice(0, 4),
    ]);
  });

  const groupIds: (string | null)[] = used.map((g) => g.id);
  if (slots.length > used.length) groupIds.push(null);
  const memberIds: string[][] = used.map((g) => agents.filter((a) => g.memberIds.includes(a.id)).map((a) => a.id));
  if (slots.length > used.length) memberIds.push(ungrouped.map((a) => a.id));
  return { slots, rows, groupIds, memberIds };
}

/** 会话消息 → 右侧动态的行 */
function toFeedRows(feed?: LabFeedItem[]) {
  return (feed ?? []).map((f) => {
    const d = new Date(f.at);
    const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return { t, a: f.who, c: f.color, x: f.text };
  });
}

type Props = {
  /** 当前 S-BOT 名字：任务分配区大班台后就是你 */
  userName: string;
  agents: Agent[];
  /** 真实群聊：群名 + 群里的智能体，用来给工位块命名 */
  groups: LabGroup[];
  /** 真人督办：在线的坐进任务分配区 */
  humans: LabHuman[];
  /** 点「新增任务」交给 S-BOT 自己的弹窗 */
  onNewTask?: () => void;
  /** 任务创建成功后 +1，让场景里有人进去领任务 */
  taskSignal?: number;
  /** 点人物气泡 → 打开该智能体的会话 */
  onOpenAgent?: (name: string) => void;
  /** 右侧动态：最近的会话消息 */
  feed?: LabFeedItem[];
  /** 底栏「任务进度」：真实任务 */
  tasks?: LabTask[];
  /** 左上「智能组织」：真实统计 */
  org?: LabOrg;
  /** 正在等用户授权的智能体名字 */
  authAgent?: string | null;
  /** 人员管理里新增成员 → 交给 S-BOT 的对话式创建 */
  onNewAgent?: () => void;
  /** 每个智能体当前的真实任务（名字 → {title,status}） */
  agentTasks?: Record<string, { title: string; status: string }>;
  /** RAGFlow 是否已对接（没对接资料区熄灯） */
  ragflowReady?: boolean;
  /** 挂了知识库的智能体名字（只有它们能进资料区） */
  kbAgentNames?: string[];
  /** 点资料区（未对接时）打开设置 */
  onOpenSettings?: () => void;
};

export default function LabPage({
  userName,
  agents,
  groups,
  humans,
  onNewTask,
  taskSignal,
  onOpenAgent,
  feed,
  tasks,
  org,
  authAgent,
  onNewAgent,
  agentTasks,
  ragflowReady,
  kbAgentNames,
  onOpenSettings,
}: Props) {
  const hostRef = useRef<LabHost | null>(null);
  /** 首次渲染时把群聊 / 成员定格，之后在人员管理里改 */
  const seedRef = useRef<ReturnType<typeof buildLayout> | null>(null);
  if (seedRef.current === null) seedRef.current = buildLayout(agents, groups);
  /** 挂载那一刻 feed 可能已经在手 */
  const feedRef = useRef(feed);
  feedRef.current = feed;
  /** 每个工位块（群组）的任务完成比例；没有相关任务就是 null */
  const groupPct = useMemo(() => {
    const seed = seedRef.current;
    if (!seed) return [] as (number | null)[];
    return seed.slots.map((_, i) => {
      const ids = seed.memberIds[i] ?? [];
      const convId = seed.groupIds[i] ?? null;
      const rel = (tasks ?? []).filter(
        (t) => (convId && t.conversationId === convId) || (t.assigneeId ? ids.includes(t.assigneeId) : false),
      );
      if (!rel.length) return null;
      return Math.round((rel.filter((t) => t.status === 'done').length / rel.length) * 100);
    });
  }, [tasks]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    if (!root.querySelector('.app')) {
      const tpl = document.createElement('template');
      tpl.innerHTML = hqTemplate;
      root.appendChild(tpl.content.cloneNode(true));
      const seed = seedRef.current;
      if (seed) {
        host.__seedGroups = seed.slots;
        host.__seedRoster = seed.rows;
      }
      // 只把在线真人坐进任务分配区
      host.__seedHumans = humans
        .filter((h) => h.online === true)
        .slice(0, 10)
        .map((h) => [h.name || '真人', h.role || '真人督办', true]);
      try {
        mountHQ(host, root);
        // 左上角 / 底部一条的留白与缩放
        host.__pad?.({ l: 0, r: 0, t: 10, b: 268, zoom: 1, ratio: 1.05, minW: 760 });
        const rows0 = toFeedRows(feedRef.current);
        if (rows0.length) host.__feed?.(rows0);
      } catch (e) {
        console.error('实验室 · 主题 10 启动失败', e);
      }
    }
    host.__boss?.(userName);

    return () => {
      if (host.isConnected) return;
      try {
        host.__stop?.();
      } catch { /* 停不下来也不影响切页 */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userName]);

  // 「新增任务」交给外壳
  useEffect(() => {
    const host = hostRef.current;
    if (host) host.__newTask = onNewTask;
  }, [onNewTask]);

  // 点人物气泡 → 打开会话
  useEffect(() => {
    const host = hostRef.current;
    if (host) host.__openChat = onOpenAgent ?? null;
  }, [onOpenAgent]);

  // 右侧动态
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    try {
      host.__feed?.(toFeedRows(feed));
    } catch { /* 推不进去不影响场景 */ }
  }, [feed]);

  // 底栏任务列表
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    try {
      host.__tasks?.(tasks ?? []);
    } catch { /* 推不进去不影响场景 */ }
  }, [tasks]);

  // 人物卡片上的任务 = S-BOT 的真实任务
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    try {
      host.__agentTasks?.(agentTasks ?? {});
    } catch { /* 推不进去不影响场景 */ }
  }, [agentTasks]);

  // RAGFlow 对接状态 + 有知识库的智能体 + 打开设置
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    try {
      host.__ragflow?.(!!ragflowReady);
      host.__kbAgents?.(kbAgentNames ?? []);
      host.__openSettings = onOpenSettings ?? null;
    } catch { /* 推不进去不影响场景 */ }
  }, [ragflowReady, kbAgentNames, onOpenSettings]);

  // 人员管理「新增成员」→ 对话式创建智能体
  useEffect(() => {
    const host = hostRef.current;
    if (host) host.__newAgent = onNewAgent ?? null;
  }, [onNewAgent]);

  // 智能体卡在授权上：人物标红 + 冒“需要你授权”
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    try {
      host.__auth?.(authAgent ?? null);
    } catch { /* 推不进去不影响场景 */ }
  }, [authAgent]);

  // 群组百分比 = 任务完成比例
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    try {
      host.__groupPct?.(groupPct);
    } catch { /* 推不进去不影响场景 */ }
  }, [groupPct]);

  // 左上实时统计
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !org) return;
    try {
      host.__org?.(org);
    } catch { /* 推不进去不影响场景 */ }
  }, [org]);

  // 做梦：服务端按最近的记忆去噪 / 去重 / 摘要，再生成梦境
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.__dreamAsk = (name, role, cb) => {
      void fetchLabDream(name, role)
        .then((lines) => { if (lines.length) cb(lines); })
        .catch(() => { /* 拿不到就用本地脚本兜底 */ });
    };
  }, []);

  // 新任务创建后，让一个智能体进任务分配区领任务
  useEffect(() => {
    if (!taskSignal) return;
    const host = hostRef.current;
    try { host?.__pickup?.(); } catch { /* 动画失败不影响任务 */ }
  }, [taskSignal]);

  return <div className="lab-host" ref={hostRef} />;
}
