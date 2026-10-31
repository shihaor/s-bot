import type { Agent, Conversation, GroupWorkflow, Message, ModelInfo, WorkflowEdge, WorkflowNode } from '@sbot/shared';
import { addMessage, addWorkflowStep, createWorkflowRun, getAgent, getModel, setWorkflowDone, updateWorkflowRun } from './repo.js';
import { ensureSession, runAgent } from './opencode.js';
import { generateReply, type ModelConfig } from './runtime.js';
import { retrieve } from './ragflow.js';

export interface WorkflowStream {
  writeSSE: (event: { event: string; data: string }) => Promise<void>;
}

interface PendingApproval {
  resolve: (decision: 'pass' | 'changes' | 'timeout') => void;
}

const approvals = new Map<string, PendingApproval>();
const approvalKey = (runId: string, nodeId: string) => `${runId}:${nodeId}`;

export function resolveWorkflowApproval(runId: string, nodeId: string, decision: 'pass' | 'changes'): boolean {
  const pending = approvals.get(approvalKey(runId, nodeId));
  if (!pending) return false;
  approvals.delete(approvalKey(runId, nodeId));
  pending.resolve(decision);
  return true;
}

function waitApproval(runId: string, nodeId: string, timeout = 120000): Promise<'pass' | 'changes' | 'timeout'> {
  return new Promise((resolve) => {
    const key = approvalKey(runId, nodeId);
    const timer = setTimeout(() => {
      approvals.delete(key);
      resolve('timeout');
    }, timeout);
    approvals.set(key, {
      resolve: (decision) => {
        clearTimeout(timer);
        resolve(decision);
      },
    });
  });
}

function pickEdge(node: WorkflowNode, graph: GroupWorkflow, when: string, visits: Map<string, number>): WorkflowEdge | null {  const out = graph.edges.filter((e) => e.from === node.id);
  if (!out.length) return null;

  const usable = (e: WorkflowEdge) => !e.maxLoops || (visits.get(e.id) ?? 0) < e.maxLoops;
  const exact = out.find((e) => (e.when ?? 'always') === when && usable(e));
  if (exact) return exact;
  const always = out.find((e) => (e.when ?? 'always') === 'always' && usable(e));
  if (always) return always;
  // 循环次数用完了：优先走超时/结束分支
  return out.find((e) => usable(e) && (e.when ?? 'always') === 'timeout') ?? out.find(usable) ?? null;
}

function fallbackNode(graph: GroupWorkflow): WorkflowNode | null {
  return graph.nodes.find((n) => n.type === 'human') ?? graph.nodes.find((n) => n.type === 'end') ?? null;
}

function parseVerdict(text: string): { verdict: 'pass' | 'changes' | null; clean: string } {
  const fence = text.match(/```json\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    try {
      const json = JSON.parse(fence[1]);
      if (json?.verdict === 'pass' || json?.verdict === 'changes') {
        return { verdict: json.verdict, clean: text.replace(fence[0], '').trim() };
      }
    } catch { /* ignore */ }
  }
  const raw = text.match(/\{[\s\S]*?"verdict"\s*:\s*"(pass|changes)"[\s\S]*?\}/i);
  if (raw?.[0]) {
    try {
      const json = JSON.parse(raw[0]);
      if (json?.verdict === 'pass' || json?.verdict === 'changes') {
        return { verdict: json.verdict, clean: text.replace(raw[0], '').trim() };
      }
    } catch { /* ignore */ }
  }
  return { verdict: null, clean: text };
}

function modelCfg(m: ModelInfo | null): ModelConfig | null {
  if (!m?.baseUrl || !m?.apiKey) return null;
  return { baseUrl: m.baseUrl, apiKey: m.apiKey, model: m.model };
}

export interface WorkflowRunInput {
  conv: Conversation;
  graph: GroupWorkflow;
  text: string;
  userMessageAt: number;
  userMessageId: string;
  history: { role: 'user' | 'assistant'; content: string }[];
  defaultModel: ModelInfo | null;
  opencodeOn: boolean;
  aborted: () => boolean;
  signal: AbortSignal;
  stream: WorkflowStream;
}

export async function runWorkflow(input: WorkflowRunInput): Promise<{ produced: Message[]; interrupted: boolean }> {
  const { conv, graph, text, stream, signal } = input;
  const runId = createWorkflowRun({
    conversationId: conv.id,
    graphVersion: graph.version,
    inputMessageId: input.userMessageId,
  });
  const produced: Message[] = [];
  const visits = new Map<string, number>();
  const prior: Array<{ label: string; agentName: string; text: string }> = [];
  const priorText = () =>
    prior
      .map((p) => `## ${p.label}（${p.agentName}）\n${p.text}`)
      .join('\n\n')
      .slice(-14000);

  await stream.writeSSE({
    event: 'workflow.start',
    data: JSON.stringify({ runId, conversationId: conv.id, graph }),
  });

  let current: WorkflowNode | null = graph.nodes.find((n) => n.type === 'start') ?? graph.nodes[0] ?? null;
  let guard = 0;
  let reachedEnd = false;

  try {
    while (current && guard++ < 60 && !input.aborted()) {
      updateWorkflowRun(runId, { currentNode: current.id });
      await stream.writeSSE({
        event: 'workflow.node',
        data: JSON.stringify({
          runId,
          node: { id: current.id, type: current.type, label: current.label, agentId: current.agentId ?? null },
        }),
      });

      if (current.type === 'end') {
        reachedEnd = true;
        updateWorkflowRun(runId, { currentNode: current.id });
        break;
      }

      if (current.type === 'human') {
        await stream.writeSSE({
          event: 'workflow.approval',
          data: JSON.stringify({ runId, nodeId: current.id, title: current.label }),
        });
        const decision = await waitApproval(runId, current.id);
        addWorkflowStep({ runId, nodeId: current.id, status: 'done', verdict: decision });
        await stream.writeSSE({
          event: 'workflow.node.end',
          data: JSON.stringify({ runId, nodeId: current.id, status: 'done', verdict: decision }),
        });
        const next = pickEdge(current, graph, decision, visits);
        if (next) visits.set(next.id, (visits.get(next.id) ?? 0) + 1);
        current = next ? graph.nodes.find((n) => n.id === next.to) ?? null : fallbackNode(graph);
        continue;
      }

      if (current.type !== 'agent' || !current.agentId) {
        const next = pickEdge(current, graph, 'always', visits);
        if (next) visits.set(next.id, (visits.get(next.id) ?? 0) + 1);
        current = next ? graph.nodes.find((n) => n.id === next.to) ?? null : fallbackNode(graph);
        continue;
      }

      const agent = getAgent(current.agentId);
      if (!agent) {
        const next = pickEdge(current, graph, 'pass', visits);
        current = next ? graph.nodes.find((n) => n.id === next.to) ?? null : fallbackNode(graph);
        continue;
      }
      if (!conv.members.some((m) => m.memberType === 'agent' && m.memberId === agent.id)) {
        // 已经不在群里了：跳过这个节点
        const next = pickEdge(current, graph, 'pass', visits);
        current = next ? graph.nodes.find((n) => n.id === next.to) ?? null : fallbackNode(graph);
        continue;
      }

      const messageId = `tmp_${agent.id}_${Date.now().toString(36)}`;
      const picked =
        (conv.modelId ? getModel(conv.modelId) : null) ||
        (agent.modelId ? getModel(agent.modelId) : null) ||
        input.defaultModel;

      await stream.writeSSE({
        event: 'message.start',
        data: JSON.stringify({
          id: messageId,
          agentId: agent.id,
          name: agent.name,
          role: agent.role,
          color: agent.color,
          initial: agent.initial,
          model: input.opencodeOn ? `opencode · ${picked?.name ?? ''}` : (picked?.name ?? 'mock'),
        }),
      });

      let citations: Array<{ n: number; kb: string; doc: string; score: number; text: string }> = [];
      if (agent.kbIds?.length) {
        await stream.writeSSE({ event: 'retrieval.start', data: JSON.stringify({ agentId: agent.id }) });
        citations = await retrieve(text, agent.kbIds);
        await stream.writeSSE({ event: 'retrieval.done', data: JSON.stringify({ agentId: agent.id, count: citations.length }) });
      }

      let full = '';
      let failed = false;
      let usedOpencode = false;
      const tools: Array<{ type: 'tool'; toolId: string; name: string; detail: string; status: string }> = [];

      if (input.opencodeOn) {
        try {
          const sess = await ensureSession(conv.id, agent);
          usedOpencode = true;
          const prompt = [
            `你是${agent.name}，${agent.role}。`,
            agent.systemPrompt,
            '只代表你自己发言，不要替别人说话，不要在开头加自己的名字。',
            '回答简洁具体。',
            '',
            '【用户的需求】',
            text,
            prior.length ? `\n【前面已经完成的内容】\n${priorText()}` : '',
            '',
            '【这一步要做的事】',
            current.prompt || current.label,
            current.producesVerdict
              ? '结束前单独输出一行 JSON：{"verdict":"pass" 或 "changes","blocking":[],"suggestions":[]}'
              : '',
          ].filter(Boolean).join('\n');

          for await (const ev of runAgent({ sessionId: sess.sessionId, prompt, signal })) {
            if (input.aborted()) break;
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
                data: JSON.stringify({ id: messageId, toolId: ev.id, name: ev.name, detail: ev.detail ?? '', status: 'running' }),
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
                  agentId: agent.id,
                  messageId,
                  requestID: ev.requestID,
                  action: ev.action,
                  resources: ev.resources,
                }),
              });
            } else if (ev.type === 'error') {
              if (!full) usedOpencode = false;
              else failed = true;
              break;
            } else if (ev.type === 'done') {
              break;
            }
          }
        } catch {
          if (!full) usedOpencode = false;
          else failed = true;
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
              history: input.history,
              userText: `${text}${prior.length ? `\n\n【前面已经完成的内容】\n${priorText()}` : ''}\n\n【这一步要做的事】${current.prompt || current.label}`,
              modelConfig: modelCfg(picked),
              references: citations.length
                ? citations.map((c) => `[${c.n}] ${c.doc}：${c.text}`).join('\n')
                : undefined,
            },
            modelCfg(picked),
          )) {
            if (input.aborted()) break;
            full += delta;
            await stream.writeSSE({ event: 'message.delta', data: JSON.stringify({ id: messageId, delta }) });
          }
        } catch {
          failed = true;
        }
      }

      const parsed = current.producesVerdict ? parseVerdict(full) : { verdict: null as 'pass' | 'changes' | null, clean: full };
      full = parsed.clean || full;
      if (parsed.verdict === 'changes') {
        full = full || '评审发现阻塞问题，需要修订。';
      }
      if (!full) {
        failed = true;
        full = '这一步没有生成内容。';
      }

      const parts = [
        ...tools,
        ...citations.map((c) => ({ type: 'citation', ...c })),
      ];
      const saved = addMessage({
        conversationId: conv.id,
        authorType: 'agent',
        authorId: agent.id,
        role: 'assistant',
        text: full,
        modelId: picked?.id ?? null,
        status: failed ? 'error' : input.aborted() ? 'interrupted' : 'done',
        parts: parts.length ? parts : undefined,
      });
      produced.push(saved);
      prior.push({ label: current.label, agentName: agent.name, text: full.slice(0, 6000) });

      await stream.writeSSE({
        event: 'message.end',
        data: JSON.stringify({
          id: messageId,
          agentId: agent.id,
          savedId: saved.id,
          text: full,
          createdAt: saved.createdAt,
          status: saved.status,
          parts,
        }),
      });

      addWorkflowStep({
        runId,
        nodeId: current.id,
        agentId: agent.id,
        status: failed ? 'error' : 'done',
        verdict: parsed.verdict,
        text: full.slice(0, 4000),
      });
      await stream.writeSSE({
        event: 'workflow.node.end',
        data: JSON.stringify({ runId, nodeId: current.id, status: failed ? 'error' : 'done', verdict: parsed.verdict }),
      });

      const when = parsed.verdict ?? 'pass';
      const next = pickEdge(current, graph, when, visits);
      if (next) visits.set(next.id, (visits.get(next.id) ?? 0) + 1);
      current = next ? graph.nodes.find((n) => n.id === next.to) ?? null : fallbackNode(graph);
    }
  } finally {
    updateWorkflowRun(runId, {
      status: input.aborted() ? 'interrupted' : 'done',
      endedAt: Date.now(),
    });
    // 正常跑完（到达结束节点）就把群标记为「已出结论」，后续消息转自由对话
    if (reachedEnd && !input.aborted()) setWorkflowDone(conv.id, true);
    await stream.writeSSE({
      event: 'workflow.done',
      data: JSON.stringify({ runId, interrupted: input.aborted() }),
    }).catch(() => {});
  }

  return { produced, interrupted: input.aborted() };
}

export async function cancelWorkflowApprovals(runId: string): Promise<void> {
  for (const key of [...approvals.keys()]) {
    if (key.startsWith(`${runId}:`)) {
      approvals.get(key)?.resolve('timeout');
      approvals.delete(key);
    }
  }
}
