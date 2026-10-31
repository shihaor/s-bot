import type { Agent, GroupWorkflow, WorkflowEdge, WorkflowNode } from '@sbot/shared';
import { getAgent } from './repo.js';

/* ---------- 生成默认聊天逻辑图 ---------- */

function textOf(a: Agent): string {
  return [a.name, a.role, a.description, ...(a.skills ?? [])].join(' ');
}

function pick(agents: Agent[], re: RegExp, exclude?: Set<string>): Agent | null {
  return agents.find((a) => !exclude?.has(a.id) && re.test(textOf(a))) ?? null;
}

let seq = 0;
function nid(prefix: string): string {
  seq += 1;
  return `${prefix}_${seq.toString(36)}`;
}

function node(type: WorkflowNode['type'], label: string, extra: Partial<WorkflowNode> = {}, x = 0, y = 0): WorkflowNode {
  return { id: nid(type), type, label, x, y, ...extra };
}

function edge(from: string, to: string, when: WorkflowEdge['when'] = 'always', label = '', maxLoops = 0): WorkflowEdge {
  return { id: nid('e'), from, to, when, label, ...(maxLoops ? { maxLoops } : {}) };
}

export interface GenerateOptions {
  memberIds: string[];
  title?: string;
  /** 是否加一个真人确认节点（有真人成员或希望人工确认时） */
  withHuman?: boolean;
}

export function generateWorkflow(options: GenerateOptions): GroupWorkflow {
  seq = 0;
  const agents = options.memberIds.map((id) => getAgent(id)).filter(Boolean) as Agent[];
  const arch = pick(agents, /架构|方案|技术选型|系统设计|数据仓库|数仓/i);
  const reviewer = pick(agents, /评审|风险|验收|质量/i, new Set(arch ? [arch.id] : []));
  const diagrammer = pick(agents, /绘图|可视化|drawio|图表|架构图/i, new Set([arch?.id, reviewer?.id].filter((x): x is string => !!x)));
  const others = agents.filter((a) => ![arch?.id, reviewer?.id, diagrammer?.id].includes(a.id));

  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];

  const start = node('start', '开始', {}, 40, 200);
  const end = node('end', '结束', {}, 1100, 200);
  nodes.push(start, end);

  let entry = start;
  let current = start.id;
  let x = 260;

  const addAgentStage = (agent: Agent, label: string, prompt: string, verdict = false) => {
    const n = node('agent', label, { agentId: agent.id, prompt, producesVerdict: verdict }, x, 200);
    nodes.push(n);
    edges.push(edge(current, n.id));
    current = n.id;
    x += 240;
    return n;
  };

  if (arch && reviewer) {
    const design = addAgentStage(
      arch,
      '理解需求并出方案',
      '先复述目标和约束，再给出方案。写清分层、数据流、选型、风险和待确认问题。不要写代码。',
    );
    const review = addAgentStage(
      reviewer,
      '评审方案',
      '只评审方案本身（分层、数据流、选型、风险），不要要求这一步出图；架构图由后续节点负责。列出阻塞问题；最后单独输出一行 JSON：{"verdict":"pass" 或 "changes","blocking":[],"suggestions":[]}',
      true,
    );

    let revise: WorkflowNode | null = null;
    if (arch) {
      revise = node('agent', '按评审修订', {
        agentId: arch.id,
        prompt: '根据上一条评审里的 blocking 问题修订方案，逐条说明改了什么。不要重复已通过的部分。',
      }, x, 320);
      nodes.push(revise);
      edges.push(edge(review.id, revise.id, 'changes', '要改'));
      edges.push(edge(revise.id, review.id, 'always', '再审一轮', 2));
      x += 240;
    }

    let afterReview = review.id;
    if (diagrammer) {
      const diagram = node('agent', '出架构图', {
        agentId: diagrammer.id,
        prompt: '根据最终方案输出图结构 JSON（nodes/edges/groups，不要 XML、不要画布坐标）。只画方案里出现的组件和关系。',
      }, x, 200);
      nodes.push(diagram);
      edges.push(edge(review.id, diagram.id, 'pass', '通过'));
      afterReview = diagram.id;
      x += 240;
    }

    // 修订次数到上限时，别再回到评审，直接进入下一步
    if (revise && afterReview !== review.id) {
      edges.push(edge(revise.id, afterReview, 'timeout', '修订上限'));
    }

    if (options.withHuman) {
      const human = node('human', '真人确认', {}, x, 200);
      nodes.push(human);
      edges.push(edge(afterReview, human.id, 'pass', '通过'));
      edges.push(edge(human.id, end.id, 'pass', '通过'));
      if (revise) edges.push(edge(human.id, revise.id, 'changes', '要改'));
      edges.push(edge(human.id, end.id, 'timeout', '超时结束'));
      x += 240;
    } else {
      edges.push(edge(afterReview, end.id, 'pass', '通过'));
    }
  } else if (arch || diagrammer || others.length) {
    const first = arch ?? diagrammer ?? others[0]!;
    const main = addAgentStage(first, arch ? '理解需求并出方案' : '出架构图', arch
      ? '复述目标和约束，给出方案要点和风险。'
      : '根据用户需求输出图结构 JSON（nodes/edges/groups）。');
    let last = main;
    for (const a of others) {
      last = addAgentStage(a, `补充：${a.role}`, '结合前面的发言补充你的专业意见，不要重复。');
    }
    if (options.withHuman) {
      const human = node('human', '真人确认', {}, x, 200);
      nodes.push(human);
      edges.push(edge(last.id, human.id));
      edges.push(edge(human.id, end.id, 'pass', '通过'));
      edges.push(edge(human.id, end.id, 'timeout', '超时结束'));
    } else {
      edges.push(edge(last.id, end.id));
    }
  } else {
    edges.push(edge(start.id, end.id));
  }

  // 兜底：确保每个节点都有出边（end 除外）
  for (const n of nodes) {
    if (n.type === 'end') continue;
    if (!edges.some((e) => e.from === n.id)) {
      edges.push(edge(n.id, end.id));
    }
  }

  // 结束节点放到最右边，避免和中间节点重叠
  const maxX = Math.max(...nodes.filter((n) => n.id !== end.id).map((n) => n.x ?? 0));
  end.x = maxX + 240;
  end.y = 200;

  return {
    version: 0,
    enabled: true,
    maxLoops: 3,
    nodes,
    edges,
  };
}

/* ---------- 校验 ---------- */

export function validateWorkflow(graph: GroupWorkflow): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const ids = new Set(graph.nodes.map((n) => n.id));
  const starts = graph.nodes.filter((n) => n.type === 'start');
  const ends = graph.nodes.filter((n) => n.type === 'end');
  if (starts.length !== 1) errors.push('必须有且只有一个开始节点');
  if (ends.length < 1) errors.push('至少需要一个结束节点');

  for (const e of graph.edges) {
    if (!ids.has(e.from)) errors.push(`连线起点不存在：${e.from}`);
    if (!ids.has(e.to)) errors.push(`连线终点不存在：${e.to}`);
  }
  for (const n of graph.nodes) {
    if ((n.type === 'agent' || n.type === 'accept') && !n.agentId && !(n.agentIds?.length)) {
      errors.push(`节点「${n.label}」没有绑定智能体`);
    }
    if (n.type === 'parallel') {
      const children = n.children ?? [];
      if (!children.length) errors.push(`并行节点「${n.label}」没有子任务`);
      for (const c of children) {
        if (!c.agentId) errors.push(`并行节点「${n.label}」的子任务「${c.label}」没有绑定智能体`);
      }
    }
  }

  if (starts[0]) {
    const seen = new Set<string>();
    const queue = [starts[0].id];
    while (queue.length) {
      const cur = queue.shift()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const e of graph.edges) if (e.from === cur) queue.push(e.to);
    }
    const unreachable = graph.nodes.filter((n) => !seen.has(n.id));
    if (unreachable.length) errors.push(`有节点从开始不可达：${unreachable.map((n) => n.label).join('、')}`);
  }

  return { ok: errors.length === 0, errors };
}
