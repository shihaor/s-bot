import { useEffect, useMemo, useRef, useState } from 'react';
import { coachSkill, createSkill, type SkillDraft } from './api';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

interface Props {
  onClose: () => void;
  onSaved: (name: string) => void;
  onToast: (msg: string) => void;
}

const STARTERS = [
  '通过堡垒机连接内网服务器，做一次服务巡检',
  '把每天群里的待办整理成周报',
  '拉取 Git 仓库变更并生成发布说明',
];

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function skillBlocks(text: string): string[] {
  const out: string[] = [];
  const re = /```skill[^\n]*\r?\n([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1]!.trim());
  return out;
}

function stripBlocks(text: string): string {
  return text
    .replace(/```(?:skill|verify|json:verify)[^\n]*\r?\n[\s\S]*?```/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseDraft(raw: string): SkillDraft {
  const body = raw.trim();
  const fm = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  let name = '';
  let description = '';
  let content = body;
  if (fm) {
    content = body.slice(fm[0].length).trim();
    for (const line of fm[1]!.split(/\r?\n/)) {
      const m = line.match(/^([a-zA-Z_-]+)\s*:\s*(.*)$/);
      if (!m) continue;
      const key = m[1]!.toLowerCase();
      const value = m[2]!.trim().replace(/^["']|["']$/g, '');
      if (key === 'name') name = value;
      if (key === 'description') description = value;
    }
  }
  if (!name) name = content.split(/\r?\n/).find(Boolean)?.replace(/^#+\s*/, '') ?? '未命名技能';
  return { id: slugify(name), name, description, content, scope: 'global' };
}

export default function SkillCoach({ onClose, onSaved, onToast }: Props) {
  const [messages, setMessages] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [scope, setScope] = useState<'global' | 'project'>('global');
  const [edit, setEdit] = useState<SkillDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const draft = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role !== 'assistant') continue;
      const blocks = skillBlocks(m.content);
      if (blocks.length) return parseDraft(blocks[blocks.length - 1]!);
    }
    return null;
  }, [messages]);

  useEffect(() => {
    if (!draft) return;
    setEdit((prev) => {
      if (prev && prev.content === draft.content && prev.name === draft.name) return prev;
      return { ...draft, id: draft.id || slugify(draft.name) };
    });
  }, [draft?.content, draft?.name]);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages, busy]);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(t);
  }, [copied]);

  async function runCoach(next: Turn[], verifyRound = 0) {
    setBusy(true);
    setError('');
    try {
      const r = await coachSkill(next);
      let after: Turn[] = [...next, { role: 'assistant', content: r.reply }];
      setMessages(after);

      if (r.verification) {
        const v = r.verification;
        const note = v.ok
          ? `[系统] 连接测试：${v.host}:${v.port} 可达，耗时 ${v.ms}ms。`
          : `[系统] 连接测试：${v.host}:${v.port} 失败：${v.error ?? '未知错误'}。`;
        after = [...after, { role: 'user', content: `${note} 请根据结果继续，不要假装验证成功。` }];
        setMessages(after);
        if (verifyRound < 1) {
          await runCoach(after, verifyRound + 1);
          return;
        }
      }
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

  async function save() {
    if (!edit || saving) return;
    if (!edit.name.trim() || !edit.description.trim()) {
      onToast('技能名称和描述都要填');
      return;
    }
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(edit.id)) {
      onToast('技能 ID 只能用小写字母、数字、- 和 _，例如 bastion-inspect');
      return;
    }
    setSaving(true);
    try {
      const r = await createSkill({ ...edit, scope });
      onToast(`已写入 ${r.scope === 'project' ? '.opencode/skills' : '~/.config/opencode/skills'}/${r.id}`);
      onSaved(edit.name);
    } catch (e) {
      onToast(String((e as Error).message ?? e));
    } finally {
      setSaving(false);
    }
  }

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const visibleText = lastAssistant ? stripBlocks(lastAssistant.content) : '';

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet coach-sheet">
        <div className="sheet-head">
          <h3>新增技能</h3>
          <p>描述你的需求，技能教练会追问细节、做连通性验证，最后生成 SKILL.md 草案。你确认后才写入执行引擎。</p>
        </div>

        <div className="coach-body" ref={bodyRef}>
          {messages.length === 0 && (
            <div className="coach-empty">
              <div className="coach-hero">说说你想让智能体学会做什么</div>
              <p>
                比如：通过堡垒机连到内网某台服务器，先验证地址和端口，再把巡检步骤写成技能。
                密码不要直接写进技能文档，教练会用环境变量占位符。
              </p>
              <div className="coach-starters">
                {STARTERS.map((s) => (
                  <button key={s} className="sugg" onClick={() => void send(s)}>{s}</button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => {
            const isSystem = m.role === 'user' && m.content.startsWith('[系统]');
            if (isSystem) {
              return <div key={i} className="coach-note">{m.content.replace(/^\[系统\]\s*/, '')}</div>;
            }
            if (m.role === 'user') {
              return (
                <div key={i} className="coach-msg user">
                  <div className="coach-bubble">{m.content}</div>
                </div>
              );
            }
            const text = stripBlocks(m.content);
            return (
              <div key={i} className="coach-msg assistant">
                <div className="coach-avatar">S</div>
                <div className="coach-bubble">
                  {text || '已生成技能草案，见下方。'}
                  {skillBlocks(m.content).length > 0 && i === messages.length - 1 && (
                    <div className="coach-draft-tag">✓ 草案已生成，确认后才会写入</div>
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

        {edit && (
          <div className="coach-draft">
            <div className="coach-draft-head">
              <b>技能草案</b>
              <span>确认后写入执行引擎，智能体会自动发现它</span>
            </div>
            <div className="coach-fields">
              <label className="field"><span>技能 ID</span>
                <input className="input" value={edit.id} onChange={(e) => setEdit({ ...edit, id: e.target.value })} placeholder="bastion-inspect" />
              </label>
              <label className="field"><span>显示名称</span>
                <input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
              </label>
            </div>
            <label className="field"><span>描述（模型靠它判断什么时候加载）</span>
              <input className="input" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} />
            </label>
            <label className="field"><span>写入位置</span>
              <select className="dselect coach-scope" value={scope} onChange={(e) => setScope(e.target.value as 'global' | 'project')}>
                <option value="global">全局 · ~/.config/opencode/skills</option>
                <option value="project">项目 · .opencode/skills</option>
              </select>
            </label>
            <label className="field"><span>SKILL.md 正文</span>
              <textarea
                className="input coach-content"
                value={edit.content}
                onChange={(e) => setEdit({ ...edit, content: e.target.value })}
                rows={12}
              />
            </label>
            <div className="coach-actions">
              <button
                className="btn"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(edit.content);
                    setCopied(true);
                  } catch {
                    onToast('复制失败');
                  }
                }}
              >
                {copied ? '已复制' : '复制正文'}
              </button>
              <button className="btn primary" disabled={saving} onClick={() => void save()}>
                {saving ? '写入中…' : '确认并同步到执行引擎'}
              </button>
            </div>
          </div>
        )}

        <div className="coach-composer">
          <textarea
            className="coach-input"
            value={input}
            disabled={busy}
            placeholder={messages.length ? '补充信息，或直接说“可以，生成草案”' : '例如：我要通过堡垒机 10.1.2.3:22 连到内网服务器做巡检…'}
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
          <span>密码/密钥只用于本轮验证，不要写进技能文档；教练会改成环境变量占位符。</span>
          <div>
            {messages.length > 0 && !edit && (
              <button className="btn" disabled={busy} onClick={() => void send('信息够了，请现在输出完整的 SKILL.md 草案。')}>
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
