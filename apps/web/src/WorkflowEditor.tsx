import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addEdge,
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
} from '@xyflow/react';
import dagre from 'dagre';
import '@xyflow/react/dist/style.css';
import type { Agent, GroupWorkflow, WorkflowEdge, WorkflowNode, WorkflowWhen } from '@sbot/shared';

const WHEN_LABEL: Record<WorkflowWhen, string> = {
  always: '',
  pass: '通过',
  changes: '要改',
  timeout: '超时',
};

function WfNode({ data, selected }: { data: any; selected?: boolean }) {
  return (
    <div className={`wf-node ${data.kind} ${selected ? 'sel' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="wf-node-kicker">{data.kicker}</div>
      <div className="wf-node-label">{data.label}</div>
      {data.agentName && <div className="wf-node-sub">{data.agentName}</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { wf: WfNode };

interface Props {
  graph: GroupWorkflow;
  agents: Agent[];
  onClose: () => void;
  onSave: (graph: GroupWorkflow) => void;
}

export default function WorkflowEditor({ graph, agents, onClose, onSave }: Props) {
  const [nodes, setNodes, onNodesChange] = useNodesState<any>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<any>([]);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [addAgentId, setAddAgentId] = useState(agents[0]?.id ?? '');
  const rfRef = useRef<any>(null);

  function layoutNodes(ns: any[], es: any[]): any[] {
    const g = new dagre.graphlib.Graph();
    g.setDefaultEdgeLabel(() => ({}));
    g.setGraph({ rankdir: 'LR', nodesep: 46, ranksep: 110, marginx: 20, marginy: 20 });
    ns.forEach((n) => g.setNode(n.id, { width: 190, height: 72 }));
    es.forEach((e) => g.setEdge(e.source, e.target));
    dagre.layout(g);
    return ns.map((n) => {
      const pos = g.node(n.id);
      return pos ? { ...n, position: { x: pos.x - 95, y: pos.y - 36 } } : n;
    });
  }

  useEffect(() => {
    let rfNodes: Node[] = graph.nodes.map((n) => ({
      id: n.id,
      type: 'wf',
      position: { x: n.x ?? 0, y: n.y ?? 0 },
      data: {
        label: n.label,
        kind: n.type,
        agentId: n.agentId ?? null,
        agentName: n.agentId ? agents.find((a) => a.id === n.agentId)?.name ?? '未绑定' : '',
        prompt: n.prompt ?? '',
        producesVerdict: !!n.producesVerdict,
        kicker: n.type === 'start' ? '开始' : n.type === 'end' ? '结束' : n.type === 'human' ? '真人确认' : '智能体',
      },
    }));
    const rfEdges: Edge[] = graph.edges.map((e) => ({
      id: e.id,
      source: e.from,
      target: e.to,
      type: 'smoothstep',
      label: e.when && e.when !== 'always' ? (e.label || WHEN_LABEL[e.when]) : (e.label ?? ''),
      markerEnd: { type: MarkerType.ArrowClosed },
      data: { when: e.when ?? 'always', maxLoops: e.maxLoops ?? 0 },
    }));

    // 对话式生成的图没有坐标，或都堆在 (0,0)，这里自动排布
    const needLayout = rfNodes.some((n) => n.position.x === undefined || n.position.y === undefined)
      || rfNodes.every((n) => (n.position.x === 0 && n.position.y === 0));
    if (needLayout && rfNodes.length) rfNodes = layoutNodes(rfNodes, rfEdges);

    setNodes(rfNodes);
    setEdges(rfEdges);
    setSelectedNode(null);
    setSelectedEdge(null);
    setError('');

    const timer = window.setTimeout(() => {
      rfRef.current?.fitView?.({ padding: 0.18 });
    }, 160);
    return () => window.clearTimeout(timer);
  }, [graph]);

  function layout(ns = nodes, es = edges) {
    setNodes(layoutNodes(ns, es));
  }

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target) return;
      setEdges((prev) => addEdge({
        ...c,
        id: `e_${Date.now().toString(36)}`,
        type: 'smoothstep',
        label: '',
        markerEnd: { type: MarkerType.ArrowClosed },
        data: { when: 'always', maxLoops: 0 },
      }, prev));
    },
    [setEdges],
  );

  const current = useMemo(() => nodes.find((n) => n.id === selectedNode) ?? null, [nodes, selectedNode]);
  const currentEdge = useMemo(() => edges.find((e) => e.id === selectedEdge) ?? null, [edges, selectedEdge]);

  function patchNode(patch: Record<string, unknown>) {
    if (!selectedNode) return;
    setNodes((prev) => prev.map((n) => (n.id === selectedNode ? { ...n, data: { ...n.data, ...patch } } : n)));
  }

  function patchEdge(patch: Record<string, unknown>) {
    if (!selectedEdge) return;
    setEdges((prev) => prev.map((e) => (e.id === selectedEdge ? { ...e, data: { ...e.data, ...patch } } : e)));
  }

  function removeSelected() {
    if (selectedNode) {
      const n = nodes.find((x) => x.id === selectedNode);
      if (n && (n.data.kind === 'start' || n.data.kind === 'end')) {
        setError('开始/结束节点不能删除');
        return;
      }
      setNodes((prev) => prev.filter((x) => x.id !== selectedNode));
      setEdges((prev) => prev.filter((e) => e.source !== selectedNode && e.target !== selectedNode));
      setSelectedNode(null);
    } else if (selectedEdge) {
      setEdges((prev) => prev.filter((e) => e.id !== selectedEdge));
      setSelectedEdge(null);
    }
  }

  function addNode(kind: 'agent' | 'human' | 'end') {
    const id = `n_${Date.now().toString(36)}`;
    const agent = agents.find((a) => a.id === addAgentId);
    const data = kind === 'agent'
      ? { label: '新的发言', kind, agentId: agent?.id ?? null, agentName: agent?.name ?? '未绑定', prompt: '', producesVerdict: false, kicker: '智能体' }
      : { label: kind === 'human' ? '真人确认' : '结束', kind, prompt: '', kicker: kind === 'human' ? '真人确认' : '结束' };
    setNodes((prev) => [...prev, {
      id,
      type: 'wf',
      position: { x: 120 + prev.length * 40, y: 120 + prev.length * 30 },
      data,
    }]);
    setSelectedNode(id);
  }

  function save() {
    const starts = nodes.filter((n) => n.data.kind === 'start');
    const ends = nodes.filter((n) => n.data.kind === 'end');
    if (starts.length !== 1) return setError('需要有且只有一个开始节点');
    if (!ends.length) return setError('至少需要一个结束节点');
    const bad = nodes.find((n) => n.data.kind === 'agent' && !n.data.agentId);
    if (bad) return setError(`节点「${String(bad.data.label ?? '')}」还没有绑定智能体`);
    const ids = new Set(nodes.map((n) => n.id));
    const badEdge = edges.find((e) => !ids.has(e.source) || !ids.has(e.target));
    if (badEdge) return setError('有连线指向不存在的节点');

    const out: GroupWorkflow = {
      version: graph.version,
      enabled: true,
      maxLoops: graph.maxLoops || 3,
      nodes: nodes.map<WorkflowNode>((n) => ({
        id: n.id,
        type: n.data.kind,
        label: String(n.data.label ?? ''),
        agentId: n.data.agentId ?? undefined,
        prompt: n.data.prompt ?? undefined,
        producesVerdict: !!n.data.producesVerdict,
        x: Math.round(n.position.x),
        y: Math.round(n.position.y),
      })),
      edges: edges.map<WorkflowEdge>((e) => ({
        id: e.id,
        from: e.source,
        to: e.target,
        when: (e.data?.when as WorkflowWhen) ?? 'always',
        label: typeof e.label === 'string' ? e.label : undefined,
        maxLoops: Number(e.data?.maxLoops ?? 0) || undefined,
      })),
    };
    setError('');
    onSave(out);
  }

  return (
    <div className="wf-editor">
      <div className="wf-editor-head">
        <div>
          <h3>聊天逻辑</h3>
          <p>这张图决定群里谁在什么时候说话。改完点保存，下一轮生效。</p>
        </div>
        <div className="wf-editor-actions">
          <button className="btn" onClick={() => layout()}>自动布局</button>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={save}>保存</button>
        </div>
      </div>

      <div className="wf-editor-body">
        <div className="wf-canvas">
          <div className="wf-toolbar">
            <select className="dselect" value={addAgentId} onChange={(e) => setAddAgentId(e.target.value)}>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.role}</option>)}
            </select>
            <button className="btn" onClick={() => addNode('agent')}>+ 发言</button>
            <button className="btn" onClick={() => addNode('human')}>+ 真人确认</button>
            <button className="btn" onClick={() => addNode('end')}>+ 结束</button>
            {(selectedNode || selectedEdge) && <button className="btn danger" onClick={removeSelected}>删除选中</button>}
            {error && <span className="wf-error">{error}</span>}
          </div>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, n) => { setSelectedNode(n.id); setSelectedEdge(null); }}
            onEdgeClick={(_, e) => { setSelectedEdge(e.id); setSelectedNode(null); }}
            onInit={(instance) => { rfRef.current = instance; setTimeout(() => instance.fitView({ padding: 0.18 }), 80); }}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={18} size={1} color="#202833" />
            <Controls />
          </ReactFlow>
        </div>

        <aside className="wf-config">
          {!current && !currentEdge && <div className="wf-config-empty">选中一个节点或连线来编辑</div>}

          {current && (
            <>
              <div className="wf-config-title">{current.data.kicker}</div>
              <label className="field"><span>名称</span>
                <input className="input" value={String(current.data.label ?? '')} onChange={(e) => patchNode({ label: e.target.value })} />
              </label>
              {current.data.kind === 'agent' && (
                <>
                  <label className="field"><span>智能体</span>
                    <select
                      className="input"
                      value={current.data.agentId ?? ''}
                      onChange={(e) => {
                        const a = agents.find((x) => x.id === e.target.value);
                        patchNode({ agentId: e.target.value || null, agentName: a?.name ?? '未绑定' });
                      }}
                    >
                      <option value="">未绑定</option>
                      {agents.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.role}</option>)}
                    </select>
                  </label>
                  <label className="field"><span>这一步要做什么</span>
                    <textarea className="input" rows={4} value={String(current.data.prompt ?? '')} onChange={(e) => patchNode({ prompt: e.target.value })} placeholder="比如：先复述目标和约束，再给方案" />
                  </label>
                  <label className="wf-check">
                    <input type="checkbox" checked={!!current.data.producesVerdict} onChange={(e) => patchNode({ producesVerdict: e.target.checked })} />
                    这一步会给出 pass / changes 结论（用于分支）
                  </label>
                </>
              )}
              {current.data.kind === 'human' && <p className="wf-hint">走到这里会暂停，等群里真人点「通过 / 要改」；120 秒不处理按超时走。</p>}
            </>
          )}

          {currentEdge && (
            <>
              <div className="wf-config-title">连线</div>
              <label className="field"><span>什么时候走这条线</span>
                <select
                  className="input"
                  value={String(currentEdge.data?.when ?? 'always')}
                  onChange={(e) => {
                    const when = e.target.value as WorkflowWhen;
                    patchEdge({ when });
                    setEdges((prev) => prev.map((x) => (x.id === currentEdge.id ? { ...x, label: when === 'always' ? '' : WHEN_LABEL[when] } : x)));
                  }}
                >
                  <option value="always">总是</option>
                  <option value="pass">通过（pass）</option>
                  <option value="changes">要改（changes）</option>
                  <option value="timeout">超时</option>
                </select>
              </label>
              <label className="field"><span>最多走几次（0 = 不限）</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  value={Number(currentEdge.data?.maxLoops ?? 0)}
                  onChange={(e) => patchEdge({ maxLoops: Number(e.target.value) })}
                />
              </label>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

function labelText(v: unknown): string {
  return String(v ?? '');
}
