import { useEffect, useState } from 'react';
import { fetchManual } from './api';

/** 简单 Markdown 渲染：支持 # / ## / - / 数字列表 / 空行分段 */
function renderMarkdown(content: string) {
  const lines = content.split('\n');
  const out: React.ReactNode[] = [];
  let list: { ordered: boolean; items: React.ReactNode[] } | null = null;
  let key = 0;

  const flushList = () => {
    if (!list) return;
    if (list.ordered) out.push(<ol key={`ol-${key++}`}>{list.items}</ol>);
    else out.push(<ul key={`ul-${key++}`}>{list.items}</ul>);
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const h2 = line.match(/^##\s+(.+)/);
    const h1 = line.match(/^#\s+(.+)/);
    const bullet = line.match(/^[-*]\s+(.+)/);
    const num = line.match(/^\d+\.\s+(.+)/);

    if (h2) {
      flushList();
      out.push(<h3 key={`h3-${key++}`}>{h2[1]}</h3>);
    } else if (h1) {
      flushList();
      out.push(<h2 key={`h2-${key++}`}>{h1[1]}</h2>);
    } else if (bullet) {
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(<li key={`li-${key++}`}>{bullet[1]}</li>);
    } else if (num) {
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(<li key={`li-${key++}`}>{num[1]}</li>);
    } else if (line.trim() === '') {
      flushList();
    } else {
      flushList();
      out.push(<p key={`p-${key++}`}>{line}</p>);
    }
  }
  flushList();
  return out;
}

export default function ManualDialog({ onClose }: { onClose: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    void fetchManual()
      .then((d) => { if (alive) setContent(d.content); })
      .catch((e) => { if (alive) setError(String(e)); });
    return () => { alive = false; };
  }, []);

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet manual-sheet">
        <div className="sheet-head">
          <h3>使用手册</h3>
          <p>也可以直接问消息列表里的「S-BOT 助手」。</p>
        </div>
        <div className="manual-body">
          {error && <div className="colleague-note warn">{error}</div>}
          {content === null && !error && <div className="colleague-empty">加载中…</div>}
          {content && <div className="manual-content">{renderMarkdown(content)}</div>}
        </div>
        <div className="sheet-foot">
          <button className="btn primary" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
