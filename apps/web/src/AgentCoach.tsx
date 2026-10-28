import { useEffect, useRef, useState } from 'react';
import { coachAgent, type AgentCoachDraft } from './api';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

interface Props {
  onClose: () => void;
  onUse: (draft: AgentCoachDraft) => void;
}

const STARTERS = [
  '帮我做一个偏技术的架构师，说话直接一点',
  '我要一个严格的需求评审员，专门挑阻塞问题',
  '做一个负责写发布说明的文案，风格简洁',
  '我需要一个数据分析师，先问口径再下结论',
];

function stripAgentBlock(text: string): string {
  return text
    .replace(/```(?:agent|json:agent)[^\n]*\r?\n[\s\S]*?```/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export default function AgentCoach({ onClose, onUse }: Props) {
  const [messages, setMessages] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<AgentCoachDraft | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages, busy]);

  async function runCoach(next: Turn[]) {
    setBusy(true);
    setError('');
    try {
      const r = await coachAgent(next);
      setMessages([...next, { role: 'assistant', content: r.reply }]);
      if (r.draft) setDraft(r.draft);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function send(text?: string) {
    const content = (text ?? input).trim();
    if (!content || busy) return;
    if (!text) setInput('');
    const next: Turn[] = [...messages, { role: 'user', content }];
    setMessages(next);
    await runCoach(next);
  }

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet coach-sheet agent-coach-sheet">
        <div className="sheet-head">
          <h3>对话式创建智能体</h3>
          <p>说出你想要什么样的同事，教练会追问细节，帮你写好人设、擅长和 system prompt。</p>
        </div>

        <div className="coach-body" ref={bodyRef}>
          {messages.length === 0 && (
            <div className="coach-empty">
              <div className="coach-hero">你想要一个什么样的 AI 同事？</div>
              <p>
                比如：负责什么、给谁用、说话应该直接还是温和、哪些事不该插手。
                聊清楚之后会生成一份草稿，你确认后再填入表单。
              </p>
              <div className="coach-starters">
                {STARTERS.map((s) => (
                  <button key={s} className="sugg" onClick={() => void send(s)}>{s}</button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => {
            if (m.role === 'user') {
              return (
                <div key={i} className="coach-msg user">
                  <div className="coach-bubble">{m.content}</div>
                </div>
              );
            }
            const text = stripAgentBlock(m.content);
            return (
              <div key={i} className="coach-msg assistant">
                <div className="coach-avatar">S</div>
                <div className="coach-bubble">
                  {text || '草稿已经生成，见下方。'}
                  {draft && i === messages.length - 1 && (
                    <div className="coach-draft-tag">✓ 已生成智能体草案</div>
                  )}
                </div>
              </div>
            );
          })}

          {busy && (
            <div className="coach-msg assistant">
              <div className="coach-avatar">S</div>
              <div className="coach-bubble coach-thinking"><span className="dots"><i /><i /><i /></span>正在整理…</div>
            </div>
          )}

          {error && (
            <div className="coach-error">
              {error}
              <button className="btn" onClick={() => void send('继续')}>重试</button>
            </div>
          )}
        </div>

        {draft && (
          <div className="coach-draft">
            <div className="coach-draft-head">
              <b>智能体草案</b>
              <span>确认后会填入表单，还能继续改模型、知识库和权限</span>
            </div>
            <div className="agent-draft-grid">
              <div className="agent-draft-item">
                <span>名字</span>
                <b>{draft.name}</b>
              </div>
              <div className="agent-draft-item">
                <span>职位</span>
                <b>{draft.role}</b>
              </div>
              <div className="agent-draft-item">
                <span>一句话简介</span>
                <b>{draft.description || '—'}</b>
              </div>
            </div>
            <div className="agent-draft-tags">
              {draft.skills.map((s) => <span key={s} className="skill-tag">{s}</span>)}
            </div>
            <div className="agent-draft-prompt">
              <span>人设 / system prompt</span>
              <p>{draft.systemPrompt}</p>
            </div>
            <div className="coach-actions">
              <button className="btn primary" onClick={() => onUse(draft)}>用这个设定</button>
            </div>
          </div>
        )}

        <div className="coach-composer">
          <textarea
            className="coach-input"
            value={input}
            disabled={busy}
            placeholder={messages.length ? '继续补充，或者说“可以，生成草案”' : '例如：我要一个严格的架构师，关注技术风险和长期维护成本'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
          />
          <button className="btn primary coach-send" disabled={busy || !input.trim()} onClick={() => void send()}>
            {busy ? '…' : '发送'}
          </button>
        </div>

        <div className="coach-foot">
          <span>教练只负责生成设定，不会自动创建；你确认后还能在表单里继续调整。</span>
          <div>
            {messages.length > 0 && !draft && (
              <button className="btn" disabled={busy} onClick={() => void send('信息够了，请现在输出完整的智能体草案。')}>
                生成草案
              </button>
            )}
            <button className="btn" onClick={onClose}>关闭</button>
          </div>
        </div>
      </div>
    </div>
  );
}
