import { useState } from 'react';
import type { Agent, ModelInfo } from '@sbot/shared';
import type { AgentCoachDraft, KbDataset } from './api';
import AgentCoach from './AgentCoach';

const COLORS = ['#5B8CFF', '#3DDC97', '#F5A524', '#C77DFF', '#FF7A9C', '#37C3D6', '#A0E85C', '#FF9F5A'];

export interface AgentInput {
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
}

interface FormState extends AgentInput {
  id?: string;
  skillsText: string;
}

const EMPTY: FormState = {
  name: '',
  role: '',
  color: COLORS[0]!,
  description: '',
  skills: [],
  skillsText: '',
  systemPrompt: '',
  modelId: null,
  visibility: 'team',
  tools: { read: true, web: false, shell: false },
  kbIds: [],
};

interface Props {
  agents: Agent[];
  models: ModelInfo[];
  kbs: KbDataset[];
  userId?: string;
  onOpen: (id: string) => void;
  onCreate: (input: AgentInput) => Promise<void>;
  onUpdate: (id: string, input: AgentInput) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onDuplicate: (agent: Agent) => Promise<void>;
}

export default function AgentsPage({ agents, models, kbs, userId, onOpen, onCreate, onUpdate, onDelete, onDuplicate }: Props) {
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [coachOpen, setCoachOpen] = useState(false);

  function useCoachDraft(draft: AgentCoachDraft) {
    const color = COLORS.includes(draft.color) ? draft.color : COLORS[0]!;
    setForm({
      ...EMPTY,
      name: draft.name,
      role: draft.role,
      color,
      description: draft.description,
      skills: draft.skills,
      skillsText: draft.skills.join('，'),
      systemPrompt: draft.systemPrompt,
    });
    setCoachOpen(false);
  }

  function edit(a: Agent) {
    setForm({
      id: a.id,
      name: a.name,
      role: a.role,
      color: a.color,
      description: a.description,
      skills: a.skills,
      skillsText: a.skills.join('，'),
      systemPrompt: a.systemPrompt,
      modelId: a.modelId,
      visibility: a.visibility,
      tools: a.tools ?? {},
      kbIds: a.kbIds ?? [],
    });
  }

  async function submit() {
    if (!form || busy) return;
    if (!form.name.trim() || !form.role.trim()) return;
    setBusy(true);
    const payload: AgentInput = {
      name: form.name.trim(),
      role: form.role.trim(),
      color: form.color,
      description: form.description.trim(),
      skills: form.skillsText.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      systemPrompt: form.systemPrompt.trim(),
      modelId: form.modelId,
      visibility: form.visibility,
      tools: form.tools,
      kbIds: form.kbIds,
    };
    try {
      if (form.id) await onUpdate(form.id, payload);
      else await onCreate(payload);
      setForm(null);
    } finally {
      setBusy(false);
    }
  }

  const modelName = (id: string | null) => models.find((m) => m.id === id)?.name ?? '跟随默认';

  return (
    <div className="page agents">
      <div className="page-head">
        <div>
          <h2>智能体库</h2>
          <p>每个智能体 = 人设 + 模型 + 擅长。点卡片直接开单聊。</p>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => setCoachOpen(true)}>✦ 对话生成</button>
          <button className="btn primary" onClick={() => setForm({ ...EMPTY })}>+ 新建智能体</button>
        </div>
      </div>

      <div className="agent-grid">
        {agents.map((a) => (
          <div key={a.id} className="card" onClick={() => edit(a)}>
            <div className="card-actions" onClick={(e) => e.stopPropagation()}>
              <button className="mini" title="编辑" onClick={() => edit(a)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
              </button>
              <button className="mini" title="复制" onClick={() => void onDuplicate(a)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></svg>
              </button>
              <button className="mini danger" title="删除" onClick={() => { if (window.confirm(`删除「${a.name}」？`)) void onDelete(a.id); }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13" /><path d="M9 7V4h6v3" /></svg>
              </button>
            </div>
            <div className="card-top">
              <div className="av" style={{ width: 30, height: 30, flexBasis: 30, fontSize: 11.5, background: `${a.color}22`, border: `2px solid ${a.color}`, color: a.color }}>{a.initial}</div>
              <div>
                <h3>{a.name}</h3>
                <div className="role">{a.role}</div>
              </div>
            </div>
            <p>{a.description || '还没有简介'}</p>
            <div className="kb-tags">
              {a.skills.slice(0, 3).map((s) => <span key={s} className="skill-tag">{s}</span>)}
              {a.kbIds.length > 0 && <span className="kb-tag">{a.kbIds.length} 个知识库</span>}
            </div>
            <div className="card-foot">
              <span className="tag">{modelName(a.modelId)}</span>
              <span className="visibility">{a.ownerId && a.ownerId === userId ? '我创建的' : a.visibility === 'private' ? '仅自己' : '团队可见'}</span>
            </div>
          </div>
        ))}
      </div>

      {coachOpen && (
        <AgentCoach
          onClose={() => setCoachOpen(false)}
          onUse={useCoachDraft}
        />
      )}

      {form && (
        <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setForm(null); }}>
          <div className="sheet">
            <div className="sheet-head"><h3>{form.id ? '编辑智能体' : '新建智能体'}</h3><p>人设、模型、权限都会用在群聊发言里。</p></div>
            <div className="sheet-body">
              <div className="two">
                <label className="field"><span>名字 *</span><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="比如 老周" /></label>
                <label className="field"><span>职位 *</span><input className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} placeholder="比如 产品经理" /></label>
              </div>
              <label className="field"><span>头像颜色</span>
                <div className="swatches">
                  {COLORS.map((c) => (
                    <button key={c} type="button" className={`swatch ${form.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setForm({ ...form, color: c })} />
                  ))}
                </div>
              </label>
              <label className="field"><span>一句话简介</span><input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="它会怎么参与讨论" /></label>
              <label className="field"><span>擅长（逗号分隔）</span><input className="input" value={form.skillsText} onChange={(e) => setForm({ ...form, skillsText: e.target.value })} placeholder="需求拆解，优先级排序" /></label>
              <label className="field"><span>人设 / system prompt</span><textarea className="input" rows={4} value={form.systemPrompt} onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })} placeholder="你是老周，产品经理。只谈用户价值、场景和优先级。" /></label>
              <div className="two">
                <label className="field"><span>模型</span>
                  <select className="input" value={form.modelId ?? ''} onChange={(e) => setForm({ ...form, modelId: e.target.value || null })}>
                    <option value="">跟随默认</option>
                    {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                </label>
                <label className="field"><span>可见性</span>
                  <select className="input" value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value as 'team' | 'private' })}>
                    <option value="team">团队可见</option>
                    <option value="private">仅自己</option>
                  </select>
                </label>
              </div>
              <div className="field">
                <span>知识库（可多选，绑定的才会检索）</span>
                {kbs.length === 0 ? (
                  <div className="kb-empty" style={{ padding: '10px 0' }}>还没有启用的知识库，去设置里添加</div>
                ) : (
                  <div className="kb-pick">
                    {kbs.map((k) => {
                      const on = form.kbIds.includes(k.id);
                      return (
                        <button
                          key={k.id}
                          type="button"
                          className={`kb-pick-item ${on ? 'on' : ''}`}
                          onClick={() => setForm({
                            ...form,
                            kbIds: on ? form.kbIds.filter((x) => x !== k.id) : [...form.kbIds, k.id],
                          })}
                        >
                          <span className="kb-pick-name">{k.name}</span>
                          <span className="kb-pick-meta">{k.documentCount} 文档 · {k.chunkCount} chunks</span>
                          <span className="tick">{on ? '✓' : ''}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <div className="field"><span>权限</span>
                <div className="form-row"><div><div className="k">读文件</div><div className="d">允许读取工作区文件</div></div><div className={`sw ${form.tools.read ? 'on' : ''}`} onClick={() => setForm({ ...form, tools: { ...form.tools, read: !form.tools.read } })} /></div>
                <div className="form-row"><div><div className="k">联网</div><div className="d">webfetch / websearch</div></div><div className={`sw ${form.tools.web ? 'on' : ''}`} onClick={() => setForm({ ...form, tools: { ...form.tools, web: !form.tools.web } })} /></div>
                <div className="form-row"><div><div className="k">执行命令</div><div className="d">允许跑 shell，慎开</div></div><div className={`sw ${form.tools.shell ? 'on' : ''}`} onClick={() => setForm({ ...form, tools: { ...form.tools, shell: !form.tools.shell } })} /></div>
              </div>
            </div>
            <div className="sheet-foot">
              <button className="btn" onClick={() => setForm(null)}>取消</button>
              <button className="btn primary" disabled={busy || !form.name.trim() || !form.role.trim()} onClick={() => void submit()}>{form.id ? '保存' : '创建'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
