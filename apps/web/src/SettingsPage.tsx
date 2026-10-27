import { useEffect, useState } from 'react';
import type { ModelInfo } from '@sbot/shared';
import {
  createModel,
  deleteModel,
  fetchKbDatasets,
  fetchKbStatus,
  fetchImportableModels,
  fetchModels,
  fetchOpencodeStatus,
  fetchSettings,
  installOpencodeRuntime,
  patchSettings,
  saveEnabledKbs,
  setDefaultModel,
  testModel,
  updateModel,
  type AppSettingsData,
  type ImportableModel,
  type KbDataset,
} from './api';

interface Props {
  onToast: (m: string) => void;
  onSaved: () => void;
  onKbChanged?: () => void;
}

interface ModelForm {
  id?: string;
  name: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  tools: boolean;
  stream: boolean;
}

const EMPTY_MODEL: ModelForm = { name: '', model: '', baseUrl: '', apiKey: '', tools: true, stream: true };

export default function SettingsPage({ onToast, onSaved, onKbChanged }: Props) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [form, setForm] = useState<ModelForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'local' | 'remote'>('local');
  const [testMsg, setTestMsg] = useState<Record<string, string>>({});

  const [settings, setSettings] = useState<AppSettingsData | null>(null);
  const [ocStatus, setOcStatus] = useState<{ available: boolean; running: boolean; version?: string; bin?: string; error?: string } | null>(null);
  const [ocUrl, setOcUrl] = useState('');
  const [ocBusy, setOcBusy] = useState(false);
  const [kbStatus, setKbStatus] = useState<{ ok: boolean; configured: boolean; baseUrl: string; error?: string; datasets?: number } | null>(null);
  const [kbs, setKbs] = useState<KbDataset[]>([]);
  const [kbBusy, setKbBusy] = useState(false);
  const [rfUrl, setRfUrl] = useState('http://10.200.25.16:8080');
  const [rfKey, setRfKey] = useState('');
  const [importables, setImportables] = useState<ImportableModel[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [importPicked, setImportPicked] = useState<Set<string>>(new Set());
  const [serverUrl, setServerUrl] = useState(localStorage.getItem('sbot.server') ?? '');

  async function refresh() {
    try {
      setModels(await fetchModels());
    } catch (e) {
      onToast(String(e));
    }
  }

  async function loadRuntime() {
    try {
      const [s, oc] = await Promise.all([fetchSettings(), fetchOpencodeStatus()]);
      setSettings(s);
      setOcUrl(s.opencodeUrl);
      setRfUrl(s.ragflowBaseUrl);
      setRfKey(s.ragflowApiKey);
      setOcStatus(oc);
    } catch (e) {
      onToast(String(e));
    }
  }

  async function loadKb(showToast = false) {
    setKbBusy(true);
    try {
      const st = await fetchKbStatus();
      setKbStatus(st);
      if (!st.configured) {
        setKbs([]);
        return;
      }
      try {
        const ds = await fetchKbDatasets();
        setKbs(ds);
      } catch (e) {
        setKbs([]);
        setKbStatus({ ...st, ok: false, error: String((e as Error).message ?? e) });
      }
      if (showToast) onToast(st.ok ? `RAGFlow 连接正常 · ${st.datasets ?? 0} 个数据集` : (st.error ?? 'RAGFlow 连接失败'));
    } catch (e) {
      setKbStatus({ ok: false, configured: true, baseUrl: rfUrl, error: String((e as Error).message ?? e) });
    } finally {
      setKbBusy(false);
    }
  }

  useEffect(() => {
    void refresh();
    void loadRuntime();
    void loadKb();
  }, []);

  async function saveModel() {
    if (!form || busy) return;
    if (!form.name.trim() || !form.model.trim() || !form.baseUrl.trim()) {
      onToast('名称、模型 ID、Base URL 都不能为空');
      return;
    }
    setBusy(true);
    try {
      if (form.id) {
        await updateModel(form.id, {
          name: form.name.trim(),
          model: form.model.trim(),
          baseUrl: form.baseUrl.trim(),
          apiKey: form.apiKey.trim() || undefined,
          tools: form.tools,
          stream: form.stream,
        });
      } else {
        await createModel({
          name: form.name.trim(),
          model: form.model.trim(),
          baseUrl: form.baseUrl.trim(),
          apiKey: form.apiKey.trim(),
          tools: form.tools,
          stream: form.stream,
        });
      }
      setForm(null);
      await refresh();
      onSaved();
      onToast('模型已保存');
    } catch (e) {
      onToast(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function runTest(m: ModelInfo) {
    setTestMsg((s) => ({ ...s, [m.id]: '测试中…' }));
    const r = await testModel(m.id);
    setTestMsg((s) => ({ ...s, [m.id]: r.ok ? `连接成功 · ${r.ms}ms` : `失败：${r.error ?? r.status}` }));
  }

  return (
    <div className="page settings">
      <div className="page-head">
        <div><h2>设置</h2><p>本地模式，配置存在本机数据库里。</p></div>
      </div>

      <div className="set-card">
        <h3>运行方式</h3>
        <p className="sub">本地模式数据只在这台电脑上；服务器模式多人共享。</p>
        <div className="mode-switch">
          <button className={`mode-btn ${mode === 'local' ? 'on' : ''}`} onClick={() => setMode('local')}>
            <div className="t">本地模式</div><div className="d">SQLite，无需配置数据库</div>
          </button>
          <button className={`mode-btn ${mode === 'remote' ? 'on' : ''}`} onClick={() => setMode('remote')}>
            <div className="t">连接服务器</div><div className="d">多人共享，统一登录</div>
          </button>
        </div>
        {mode === 'remote' && (
          <div className="remote-box">
            <label className="field"><span>服务器地址</span>
              <input className="input" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="http://10.201.2.38:8787" />
            </label>
            <div className="settings-actions">
              <button
                className="btn primary"
                onClick={() => {
                  const url = serverUrl.trim().replace(/\/+$/, '');
                  if (url) localStorage.setItem('sbot.server', url);
                  else localStorage.removeItem('sbot.server');
                  location.reload();
                }}
              >
                保存并连接
              </button>
              <button
                className="btn"
                onClick={() => {
                  localStorage.removeItem('sbot.server');
                  location.reload();
                }}
              >
                使用本地服务
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="set-card">
        <div className="card-head">
          <div>
            <h3>模型服务</h3>
            <p className="sub" style={{ marginBottom: 0 }}>只有这里添加的模型，才会出现在智能体和聊天的选择里。</p>
          </div>
          <div style={{ display: 'flex', gap: 8, flex: '0 0 auto' }}>
            <button
              className="btn"
              onClick={async () => {
                try {
                  const list = await fetchImportableModels();
                  setImportables(list);
                  setImportPicked(new Set(list.map((m) => `${m.provider}/${m.model}`)));
                  setImportOpen(true);
                  if (!list.length) onToast('没读到本机 opencode 的自定义模型');
                } catch (e) {
                  onToast(String(e));
                }
              }}
            >
              从 opencode 导入
            </button>
            <button className="btn primary" onClick={() => setForm({ ...EMPTY_MODEL })}>+ 添加模型</button>
          </div>
        </div>
        <div className="model-list">
          {models.map((m) => (
            <div key={m.id} className="model-row">
              <div className="model-meta">
                <div className="model-name">
                  {m.name}
                  {m.isDefault && <span className="def">默认</span>}
                </div>
                <div className="model-sub">{m.model} · {m.baseUrl}</div>
              </div>
              <div className="model-tags">
                {m.tools && <span className="mtag">tools</span>}
                {m.stream && <span className="mtag">stream</span>}
                {!m.apiKey && <span className="mtag warn">no-key</span>}
              </div>
              <span className="test-inline">{testMsg[m.id] ?? ''}</span>
              <button className="mini" title="测试" onClick={() => void runTest(m)}>◌</button>
              <button className="mini" title="设为默认" onClick={async () => { await setDefaultModel(m.id); await refresh(); onSaved(); onToast('已设为默认'); }}>★</button>
              <button className="mini" title="编辑" onClick={() => setForm({ ...m, apiKey: '' })}>✎</button>
              <button className="mini danger" title="删除" onClick={async () => { if (!window.confirm(`删除模型「${m.name}」？`)) return; await deleteModel(m.id); await refresh(); onSaved(); onToast('模型已删除'); }}>×</button>
            </div>
          ))}
        </div>
      </div>

      <div className="set-card">
        <div className="card-head">
          <div>
            <h3>opencode 运行时</h3>
            <p className="sub" style={{ marginBottom: 0 }}>让智能体能读写文件、跑命令。没有它也能聊天，只是没有工具。</p>
          </div>
          <b className={ocStatus?.available ? 'ok-text' : 'warn-text'}>
            {ocStatus?.available ? `● 可用 ${ocStatus.version ?? ''}` : '● 未安装'}
          </b>
        </div>
        <label className="field" style={{ marginTop: 12 }}>
          <span>离线包地址</span>
          <input
            className="input"
            value={ocUrl}
            onChange={(e) => setOcUrl(e.target.value)}
            placeholder="http://10.201.1.19:80/artifactory/installer/opencode/OpenCode.zip"
          />
        </label>
        <div className="settings-actions">
          <button
            className="btn primary"
            disabled={ocBusy}
            onClick={async () => {
              setOcBusy(true);
              try {
                const r = await installOpencodeRuntime(ocUrl.trim());
                if (r.ok) {
                  setOcStatus(r.status ?? ocStatus);
                  onToast(`opencode ${r.version ?? ''} 安装完成`);
                } else {
                  if (r.status) setOcStatus(r.status);
                  onToast(r.error ?? '安装失败，请联系史皓燃获取离线包');
                }
              } catch (e) {
                onToast(String(e));
              } finally {
                setOcBusy(false);
              }
            }}
          >
            {ocBusy ? '安装中…' : ocStatus?.available ? '重新检测 / 覆盖安装' : '下载并安装'}
          </button>
          <button
            className="btn"
            onClick={async () => {
              setOcStatus(await fetchOpencodeStatus());
              onToast('已重新检测');
            }}
          >
            仅检测
          </button>
        </div>
        <p className="sub" style={{ margin: '10px 0 0' }}>
          内网下载不通时，请联系<b>史皓燃</b>获取离线包，解压后把 opencode.exe 放到数据目录的 sidecar 文件夹。
        </p>
      </div>

      <div className="set-card">
        <div className="card-head">
          <div>
            <h3>知识库（RAGFlow）</h3>
            <p className="sub" style={{ marginBottom: 0 }}>启用的知识库才会出现在智能体绑定里，回答时自动检索并标引用。</p>
          </div>
          <b className={kbStatus?.ok ? 'ok-text' : 'warn-text'}>
            {kbStatus ? (kbStatus.ok ? '● 正常' : '● 未连接') : '● 检测中'}
          </b>
        </div>

        <div className="two" style={{ marginTop: 12 }}>
          <label className="field"><span>RAGFlow 地址</span>
            <input className="input" value={rfUrl} onChange={(e) => setRfUrl(e.target.value)} placeholder="http://10.200.25.16:8080" />
          </label>
          <label className="field"><span>API Key</span>
            <input className="input" type="password" value={rfKey} onChange={(e) => setRfKey(e.target.value)} placeholder="在 RAGFlow 里生成" />
          </label>
        </div>

        <div className="settings-actions">
          <button
            className="btn primary"
            disabled={kbBusy}
            onClick={async () => {
              try {
                await patchSettings({ ragflowBaseUrl: rfUrl.trim(), ragflowApiKey: rfKey.trim() });
                await loadKb(true);
                onKbChanged?.();
                onToast('RAGFlow 设置已保存');
              } catch (e) {
                onToast(String(e));
              }
            }}
          >
            保存并连接
          </button>
          <button className="btn" disabled={kbBusy} onClick={() => void loadKb(true)}>测试连接</button>
        </div>

        {kbStatus?.error && (
          <p className="sub" style={{ margin: '8px 0 0', color: 'var(--warn)' }}>{kbStatus.error}</p>
        )}

        <div className="kb-list" style={{ marginTop: 12 }}>
          {kbs.length === 0 && (
            <div className="kb-empty">
              {kbStatus?.configured ? '没有读到数据集' : '先填 API Key 再连接'}
            </div>
          )}
          {kbs.map((k) => (
            <button
              key={k.id}
              className={`kb-item ${k.enabled ? 'sel' : ''}`}
              onClick={async () => {
                const next = kbs.map((x) => (x.id === k.id ? { ...x, enabled: !x.enabled } : x));
                setKbs(next);
                try {
                  await saveEnabledKbs(next.filter((x) => x.enabled).map((x) => x.id));
                  onKbChanged?.();
                } catch (e) {
                  onToast(String(e));
                }
              }}
            >
              <span className="kb-ico">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v18H6.5A2.5 2.5 0 0 1 4 18.5z" /><path d="M8 3v18" /></svg>
              </span>
              <span className="kb-meta">
                <span className="kb-name">{k.name}</span>
                <span className="kb-sub">{k.description || '—'} · {k.documentCount} 文档 · {k.chunkCount} chunks</span>
              </span>
              <span className="tick">{k.enabled ? '✓' : ''}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="set-card">
        <h3>高级</h3>
        <div className="two">
          <label className="field"><span>请求超时（秒）</span><input className="input" defaultValue="120" /></label>
          <label className="field"><span>HTTP 代理</span><input className="input" placeholder="留空则不使用" /></label>
        </div>
      </div>

      <div className="set-card">
        <h3>数据</h3>
        <p className="sub">本地版的数据库在 <code>userData/sbot.db</code>。</p>
        <div className="settings-actions">
          <button className="btn" onClick={() => onToast('数据目录：userData/sbot.db')}>查看数据位置</button>
          <button className="btn danger" style={{ width: 'auto' }} onClick={() => onToast('清空数据还没做，避免误删')}>清空本地数据</button>
        </div>
      </div>

      <div className="set-card warn">
        <h3>关于数据库</h3>
        <p className="sub" style={{ margin: 0 }}>
          数据库和 RAGFlow 的 Key 不会放在客户端配置里——本地版写在本机，接入服务器版后由服务端统一管理。
        </p>
      </div>

      {importOpen && (
        <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setImportOpen(false); }}>
          <div className="sheet">
            <div className="sheet-head">
              <h3>从 opencode 导入模型</h3>
              <p>读本机 ~/.config/opencode 里的 providers 配置；API Key 不会带过来，导入后补填。</p>
            </div>
            <div className="sheet-body">
              {importables.length === 0 && <div className="kb-empty">没有读到自定义模型</div>}
              <div className="kb-list">
                {importables.map((m) => {
                  const key = `${m.provider}/${m.model}`;
                  const on = importPicked.has(key);
                  return (
                    <button
                      key={key}
                      className={`kb-item ${on ? 'sel' : ''}`}
                      onClick={() => {
                        setImportPicked((prev) => {
                          const next = new Set(prev);
                          if (next.has(key)) next.delete(key); else next.add(key);
                          return next;
                        });
                      }}
                    >
                      <span className="kb-meta">
                        <span className="kb-name">{m.name}{m.isDefault ? ' · 默认' : ''}</span>
                        <span className="kb-sub">{m.providerName} · {m.model} · {m.baseUrl || '未填 Base URL'}</span>
                      </span>
                      <span className="tick">{on ? '✓' : ''}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="sheet-foot">
              <button className="btn" onClick={() => setImportOpen(false)}>取消</button>
              <button
                className="btn primary"
                disabled={importPicked.size === 0}
                onClick={async () => {
                  let n = 0;
                  for (const m of importables) {
                    if (!importPicked.has(`${m.provider}/${m.model}`)) continue;
                    if (!m.baseUrl) { onToast(`${m.name} 没有 Base URL，跳过`); continue; }
                    if (models.some((x) => x.model === m.model && x.baseUrl === m.baseUrl)) continue;
                    await createModel({ name: m.name, model: m.model, baseUrl: m.baseUrl, apiKey: '', tools: true, stream: true });
                    n++;
                  }
                  setImportOpen(false);
                  await refresh();
                  onSaved();
                  onToast(n ? `已导入 ${n} 个模型，记得补 API Key` : '没有新模型可导入');
                }}
              >
                导入 {importPicked.size} 个
              </button>
            </div>
          </div>
        </div>
      )}

      {form && (
        <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setForm(null); }}>
          <div className="sheet">
            <div className="sheet-head"><h3>{form.id ? '编辑模型' : '添加模型'}</h3><p>OpenAI 兼容接口。</p></div>
            <div className="sheet-body">
              <div className="two">
                <label className="field"><span>显示名称 *</span><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="DeepSeek Chat" /></label>
                <label className="field"><span>模型 ID *</span><input className="input" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} placeholder="deepseek-chat" /></label>
              </div>
              <label className="field"><span>Base URL *</span><input className="input" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://api.deepseek.com/v1" /></label>
              <label className="field"><span>API Key {form.id && <em className="hint">留空不修改</em>}</span><input className="input" type="password" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder="sk-..." /></label>
              <div className="form-row"><div><div className="k">支持 function calling</div></div><div className={`sw ${form.tools ? 'on' : ''}`} onClick={() => setForm({ ...form, tools: !form.tools })} /></div>
              <div className="form-row"><div><div className="k">支持流式输出</div></div><div className={`sw ${form.stream ? 'on' : ''}`} onClick={() => setForm({ ...form, stream: !form.stream })} /></div>
            </div>
            <div className="sheet-foot">
              <button className="btn" onClick={() => setForm(null)}>取消</button>
              <button className="btn primary" disabled={busy} onClick={() => void saveModel()}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
