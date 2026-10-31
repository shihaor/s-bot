import { useEffect, useMemo, useState } from 'react';
import { fetchOpencodeSkills, type OpencodeSkill } from './api';
import SkillCoach from './SkillCoach';

const GROUP_ORDER = ['内置', '全局', 'Claude 兼容', 'Agents 兼容', '项目', '工作区'] as const;

function sourceOf(path: string): { label: string; hint: string } {
  const p = path.replace(/\\/g, '/');
  if (p.startsWith('/builtin/')) return { label: '内置', hint: '执行引擎自带' };
  if (p.includes('/.config/opencode/skills/')) return { label: '全局', hint: '~/.config/opencode/skills' };
  if (p.includes('/.claude/skills/')) return { label: 'Claude 兼容', hint: '~/.claude/skills' };
  if (p.includes('/.agents/skills/')) return { label: 'Agents 兼容', hint: '~/.agents/skills' };
  if (p.includes('/.opencode/skills/')) return { label: '项目', hint: '.opencode/skills' };
  return { label: '工作区', hint: '自定义 skill 目录' };
}

export default function SkillsPage() {
  const [skills, setSkills] = useState<OpencodeSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [coachOpen, setCoachOpen] = useState(false);
  const [notice, setNotice] = useState('');

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setSkills(await fetchOpencodeSkills());
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  const filtered = useMemo(() => {
    const kw = query.trim().toLowerCase();
    if (!kw) return skills;
    return skills.filter((s) =>
      [s.id, s.name, s.description ?? '', s.path].join(' ').toLowerCase().includes(kw),
    );
  }, [skills, query]);

  const groups = useMemo(() => {
    const map = new Map<string, OpencodeSkill[]>();
    for (const s of filtered) {
      const { label } = sourceOf(s.path);
      const list = map.get(label) ?? [];
      list.push(s);
      map.set(label, list);
    }
    return GROUP_ORDER
      .map((label) => ({ label, items: map.get(label) ?? [] }))
      .filter((g) => g.items.length > 0);
  }, [filtered]);

  const current = openId ? skills.find((s) => s.id === openId) ?? null : null;

  async function copyContent(skill: OpencodeSkill) {
    try {
      await navigator.clipboard.writeText(skill.content);
      setCopied(true);
    } catch {
      setError('复制失败，浏览器可能禁用了剪贴板');
    }
  }

  return (
    <div className="page skills">
      <div className="page-head">
        <div>
          <h2>技能</h2>
          <p>模型按描述判断什么时候加载。可以手动放 SKILL.md，也可以让技能教练带你新建。</p>
        </div>
        <div className="head-actions">
          <input
            className="input skill-search"
            placeholder="搜索技能"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="btn" disabled={loading} onClick={() => void load()}>
            {loading ? '读取中…' : '刷新'}
          </button>
          <button className="btn primary" onClick={() => setCoachOpen(true)}>+ 新增技能</button>
        </div>
      </div>

      {notice && <div className="skill-notice">{notice}</div>}

      {error && (
        <div className="skill-error">
          <span>{error}</span>
          <button className="btn" onClick={() => void load()}>重试</button>
        </div>
      )}

      {loading && skills.length === 0 ? (
        <div className="skill-loading">
          <div className="skill-loading-dot" />
          正在读取技能（首次会启动引擎，可能要几秒）
        </div>
      ) : groups.length === 0 ? (
        <div className="skill-empty">
          <h3>{error ? '没读到技能' : skills.length ? '没有匹配的技能' : '还没有发现技能'}</h3>
          <p>
            把 <code>SKILL.md</code> 放到 <code>~/.config/opencode/skills/&lt;id&gt;/</code>
            或项目的 <code>.opencode/skills/</code> 下，然后点「刷新」。
          </p>
        </div>
      ) : (
        groups.map((group) => (
          <section key={group.label} className="skill-group">
            <div className="skill-group-head">
              <h3>{group.label}</h3>
              <span>{sourceOf(group.items[0]!.path).hint} · {group.items.length} 个</span>
            </div>
            <div className="agent-grid">
              {group.items.map((s) => (
                <div key={s.id} className="card skill-card" onClick={() => setOpenId(s.id)}>
                  <div className="card-top">
                    <div className="av skill-av">{s.name.slice(0, 1).toUpperCase()}</div>
                    <div>
                      <h3>{s.name}</h3>
                      <div className="role">{s.id}</div>
                    </div>
                  </div>
                  <p>{s.description || '这个技能没有写描述，模型不会自动发现它。'}</p>
                  <div className="kb-tags">
                    <span className={`skill-tag ${s.autoinvoke === false ? 'manual' : ''}`}>
                      {s.autoinvoke === false ? '只能手动加载' : '模型可自动调用'}
                    </span>
                  </div>
                  <div className="card-foot">
                    <span className="tag">SKILL.md</span>
                    <span className="visibility" title={s.path}>{s.path}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))
      )}

      {current && (
        <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpenId(null); }}>
          <div className="sheet">
            <div className="sheet-head">
              <h3>{current.name}</h3>
              <p>{current.id} · {current.path}</p>
            </div>
            <div className="sheet-body">
              <div className="skill-meta">
                <span className="skill-tag">{sourceOf(current.path).label}</span>
                <span className={`skill-tag ${current.autoinvoke === false ? 'manual' : ''}`}>
                  {current.autoinvoke === false ? '只能手动加载' : '模型可自动调用'}
                </span>
              </div>
              {current.description && <p className="skill-desc">{current.description}</p>}
              <pre className="skill-content">{current.content}</pre>
            </div>
            <div className="sheet-foot">
              <button className="btn" onClick={() => void copyContent(current)}>
                {copied ? '已复制' : '复制全文'}
              </button>
              <button className="btn primary" onClick={() => setOpenId(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {coachOpen && (
        <SkillCoach
          onClose={() => setCoachOpen(false)}
          onToast={(m) => setNotice(m)}
          onSaved={(name) => {
            setCoachOpen(false);
            setNotice(`技能「${name}」已写入，正在刷新…`);
            void load().then(() => {
              window.setTimeout(() => setNotice(''), 4000);
            });
          }}
        />
      )}
    </div>
  );
}
