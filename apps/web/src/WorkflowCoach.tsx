import { useEffect, useRef, useState } from 'react';
import type { Agent, GroupWorkflow } from '@sbot/shared';
import { coachWorkflow } from './api';

interface Msg {
  role: 'user' | 'assistant';
  content: string;
}

export default function WorkflowCoach({
  agents,
  memberIds = [],
  onReady,
  onClose,
}: {
  agents: Agent[];
  memberIds?: string[];
  onReady: (result: { graph: GroupWorkflow; memberIds: string[] }) => void;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: 'assistant',
      content: memberIds.length
        ? `告诉我你希望这个群怎么聊：谁先做、要不要评审、改几轮、最后要不要你确认。\n当前成员：${agents.filter((a) => memberIds.includes(a.id)).map((a) => `${a.name}（${a.role}）`).join('、')}`
        : `告诉我你想让这个群做什么、怎么做，我会帮你选合适的智能体并安排流程。\n可选智能体（${agents.length} 个）：${agents.map((a) => `${a.name}（${a.role}）`).join('、')}`,
    },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [readyResult, setReadyResult] = useState<{ graph: GroupWorkflow; memberIds: string[] } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  useEffect(() => {
    if (!readyResult) return;
    const timer = window.setTimeout(() => onReady(readyResult), 1100);
    return () => window.clearTimeout(timer);
  }, [readyResult, onReady]);

  async function send() {
    const text = input.trim();
    if (!text || busy || readyResult) return;
    const history = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
    setMessages((prev) => [...prev, { role: 'user', content: text }]);
    setInput('');
    setBusy(true);
    try {
      const r = await coachWorkflow(agents.map((a) => a.id), memberIds, history, text);
      setMessages((prev) => [...prev, { role: 'assistant', content: r.reply }]);
      if (r.status === 'ready' && r.graph) {
        setReadyResult({ graph: r.graph, memberIds: r.memberIds ?? memberIds });
      }
    } catch (e) {
      setMessages((prev) => [...prev, { role: 'assistant', content: `出错了：${String((e as Error).message ?? e)}` }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay coach-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet coach-sheet">
        <div className="sheet-head">
          <h3>用对话生成聊天逻辑</h3>
          <p>说清楚流程，AI 会先和你确认，再生成流程图给你调整。</p>
        </div>
        <div className="coach-list" ref={listRef}>
          {messages.map((m, i) => (
            <div key={i} className={`coach-msg ${m.role}`}>
              <div className="coach-bubble">{m.content}</div>
            </div>
          ))}
          {busy && <div className="coach-msg assistant"><div className="coach-bubble coach-typing"><span className="dots"><i /><i /><i /></span></div></div>}
          {readyResult && <div className="coach-ready">流程已生成，正在打开画布…</div>}
        </div>
        <div className="coach-input">
          <textarea
            className="input"
            rows={2}
            value={input}
            disabled={busy || !!readyResult}
            placeholder="比如：帮我搭一个做数据仓库设计的小组，要有人出方案、评审、画图，改两轮，最后我确认"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button className="btn primary" disabled={!input.trim() || busy || !!readyResult} onClick={() => void send()}>发送</button>
        </div>
        <div className="sheet-foot">
          <span className="foot-note">确认后才会生成流程图，不会直接改掉当前群。</span>
          <button className="btn" onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}
