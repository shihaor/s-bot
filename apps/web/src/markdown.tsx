import type { ReactNode } from 'react';

/**
 * 轻量 Markdown 渲染：支持标题 / 列表 / 引用 / 代码块 / 粗体 / 斜体 /
 * 行内代码 / 链接 / 引用角标 [数字]。
 * 用 React 元素渲染（不做 dangerouslySetInnerHTML），文本由 React 自动转义，天然防 XSS。
 */

const INLINE_RE = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\[\d+\])/g;

function renderInline(text: string, keyBase: string): ReactNode[] {
  const parts = text.split(INLINE_RE);
  return parts.map((p, i) => {
    const key = `${keyBase}-${i}`;
    if (!p) return null;
    if (/^\[\d+\]$/.test(p)) return <sup key={key} className="cite-mark">{p}</sup>;
    if (/^\*\*[^*]+\*\*$/.test(p)) return <strong key={key}>{p.slice(2, -2)}</strong>;
    if (/^\*[^*\n]+\*$/.test(p)) return <em key={key}>{p.slice(1, -1)}</em>;
    if (/^`[^`]+`$/.test(p)) return <code key={key} className="md-code">{p.slice(1, -1)}</code>;
    const link = p.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
    if (link) {
      return (
        <a key={key} href={link[2]} target="_blank" rel="noreferrer noopener" className="md-link">
          {link[1]}
        </a>
      );
    }
    return <span key={key}>{p}</span>;
  });
}

export function Markdown({ text }: { text: string }): ReactNode {
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  let key = 0;
  let i = 0;
  let list: { ordered: boolean; items: ReactNode[] } | null = null;
  let codeLines: string[] | null = null;

  const flushList = () => {
    if (!list) return;
    if (list.ordered) out.push(<ol key={`ol-${key++}`}>{list.items}</ol>);
    else out.push(<ul key={`ul-${key++}`}>{list.items}</ul>);
    list = null;
  };

  const flushCode = () => {
    if (!codeLines) return;
    out.push(
      <pre key={`pre-${key++}`} className="md-pre">
        <code>{codeLines.join('\n')}</code>
      </pre>,
    );
    codeLines = null;
  };

  while (i < lines.length) {
    const raw = lines[i]!;
    const line = raw.trimEnd();

    // 代码块
    if (line.trim().startsWith('```')) {
      if (codeLines) {
        flushCode();
      } else {
        flushList();
        codeLines = [];
      }
      i++;
      continue;
    }
    if (codeLines) {
      codeLines.push(raw);
      i++;
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.+)/);
    if (h) {
      flushList();
      const level = Math.min(h[1]!.length + 2, 6); // # → h3，避免聊天里标题过大
      const Tag = `h${level}` as 'h3' | 'h4' | 'h5' | 'h6';
      out.push(<Tag key={`h-${key++}`}>{renderInline(h[2]!, `h${key}`)}</Tag>);
      i++;
      continue;
    }

    // 引用
    if (line.startsWith('>')) {
      flushList();
      const content = line.replace(/^>\s?/, '');
      out.push(
        <blockquote key={`q-${key++}`} className="md-quote">
          {renderInline(content, `q${key}`)}
        </blockquote>,
      );
      i++;
      continue;
    }

    // 列表
    const bullet = line.match(/^[-*+]\s+(.+)/);
    const num = line.match(/^\d+\.\s+(.+)/);
    if (bullet || num) {
      if (bullet) {
        if (!list || list.ordered) {
          flushList();
          list = { ordered: false, items: [] };
        }
        list.items.push(<li key={`li-${key++}`}>{renderInline(bullet[1]!, `li${key}`)}</li>);
      } else if (num) {
        if (!list || !list.ordered) {
          flushList();
          list = { ordered: true, items: [] };
        }
        list.items.push(<li key={`li-${key++}`}>{renderInline(num[1]!, `li${key}`)}</li>);
      }
      i++;
      continue;
    }

    // 空行
    if (line.trim() === '') {
      flushList();
      i++;
      continue;
    }

    // 普通段落
    flushList();
    out.push(<p key={`p-${key++}`}>{renderInline(line, `p${key}`)}</p>);
    i++;
  }

  flushList();
  flushCode();
  return out;
}
