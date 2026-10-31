import { useEffect, useState } from 'react';
import type { ModelInfo } from '@sbot/shared';
import { getThemeMode, setThemeMode, type ThemeMode } from './theme';
import {
  createModel,
  deleteModel,
  detectOpencode,
  fetchKbDatasets,
  fetchKbStatus,
  fetchImportableModels,
  fetchMattermostStatus,
  fetchModels,
  fetchOpencodeModels,
  fetchOpencodeStatus,
  fetchSettings,
  installOpencodeRuntime,
  openOpencodeDataDir,
  patchSettings,
  saveEnabledKbs,
  setDefaultModel,
  syncModelsToOpencode,
  testModel,
  updateModel,
  type AppSettingsData,
  type ImportableModel,
  type KbDataset,
  type MattermostMeta,
  type OpencodeCandidate,
  type OpencodeModel,
  type OpencodeStatusData,
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
  const [mode, setMode] = useState<'local' | 'remote'>(() => (localStorage.getItem('sbot.server') ? 'remote' : 'local'));
  const [testMsg, setTestMsg] = useState<Record<string, string>>({});

  const [settings, setSettings] = useState<AppSettingsData | null>(null);
  const [ocStatus, setOcStatus] = useState<OpencodeStatusData | null>(null);
  const [ocUrl, setOcUrl] = useState('');
  const [ocBin, setOcBin] = useState('');
  const [ocBusy, setOcBusy] = useState(false);
  const [ocCandidates, setOcCandidates] = useState<OpencodeCandidate[]>([]);
  const [ocScanBusy, setOcScanBusy] = useState(false);
  const [kbStatus, setKbStatus] = useState<{ ok: boolean; configured: boolean; baseUrl: string; error?: string; datasets?: number } | null>(null);
  const [kbs, setKbs] = useState<KbDataset[]>([]);
  const [kbBusy, setKbBusy] = useState(false);
  const [rfUrl, setRfUrl] = useState('http://10.200.25.16:8080');
  const [rfKey, setRfKey] = useState('');
  const [importables, setImportables] = useState<ImportableModel[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [importPicked, setImportPicked] = useState<Set<string>>(new Set());
  const [ocModels, setOcModels] = useState<OpencodeModel[]>([]);
  const [ocModelsBusy, setOcModelsBusy] = useState(false);
  const [ocModelsOpen, setOcModelsOpen] = useState(false);
  const [serverUrl, setServerUrl] = useState(localStorage.getItem('sbot.server') ?? '');
  const [theme, setTheme] = useState<ThemeMode>(getThemeMode());
  const [mmUrl, setMmUrl] = useState('');
  const [mmToken, setMmToken] = useState('');
  const [mmStatus, setMmStatus] = useState<MattermostMeta | null>(null);
  const [mmBusy, setMmBusy] = useState(false);

  async function refresh() {
    try {
      setModels(await fetchModels());
    } catch (e) {
      onToast(String(e));
    }
  }

  async function loadImportables(showToast = false) {
    try {
      setImportables(await fetchImportableModels());
    } catch (e) {
      if (showToast) onToast(String(e));
    }
  }

  /** opencode 内置模型目录（含免费模型） */
  async function loadOpencodeModels() {
    setOcModelsBusy(true);
    try {
      setOcModels(await fetchOpencodeModels());
    } catch (e) {
      onToast(`读不到执行引擎模型：${String((e as Error).message ?? e)}`);
    } finally {
      setOcModelsBusy(false);
    }
  }

  /** 导入一个 opencode 内置模型（免费模型走 opencode 鉴权，无需 Key） */
  async function importOpencodeModel(m: OpencodeModel) {
    const model = `${m.providerID}/${m.modelID}`;
    if (models.some((x) => x.baseUrl === 'opencode://' && x.model === model)) {
      onToast(`${m.name} 已经在列表里了`);
      return;
    }
    await createModel({ name: m.name, model, baseUrl: 'opencode://', apiKey: '', tools: true, stream: true });
    await refresh();
    onSaved();
    onToast(`已导入 ${m.name}${m.free ? '（免费）' : ''}`);
  }

  /** 把 opencode 配置里的模型导入 S-BOT；所有智能体共用这份模型列表 */
  async function importModels(list: ImportableModel[]) {
    let n = 0;
    for (const m of list) {
      if (!m.baseUrl) {
        onToast(`${m.name} 没有 Base URL，跳过`);
        continue;
      }
      if (models.some((x) => x.model === m.model && x.baseUrl === m.baseUrl)) continue;
      await createModel({ name: m.name, model: m.model, baseUrl: m.baseUrl, apiKey: '', tools: true, stream: true });
      n++;
    }
    await refresh();
    onSaved();
    onToast(n ? `已导入 ${n} 个模型，记得补 API Key` : '没有新模型可导入');
    return n;
  }

  async function loadRuntime() {
    try {
      const [s, oc] = await Promise.all([fetchSettings(), fetchOpencodeStatus()]);
      setSettings(s);
      setOcUrl(s.opencodeUrl);
      setOcBin(s.opencodeBin ?? '');
      setRfUrl(s.ragflowBaseUrl);
      setRfKey(s.ragflowApiKey);
      setMmUrl(s.mattermostUrl ?? '');
      setMmToken(s.mattermostToken ?? '');
      setOcStatus(oc);
    } catch (e) {
      onToast(String(e));
    }
  }

  async function copyText(text?: string) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      onToast('路径已复制');
    } catch {
      onToast('复制失败，请手动选中复制');
    }
  }

  /** 自动扫描常见安装位置（也可以扫描输入框里的目录） */
  async function scanOpencode() {
    setOcScanBusy(true);
    try {
      const r = await detectOpencode(ocBin.trim() || undefined);
      setOcCandidates(r.candidates);
      setOcStatus(r.status);
      if (!r.candidates.length) onToast(r.error ?? '没找到执行引擎');
      else onToast(`找到 ${r.candidates.length} 个可用的执行引擎`);
    } catch (e) {
      onToast(String(e));
    } finally {
      setOcScanBusy(false);
    }
  }

  /** 保存手动指定的目录/可执行文件并立即检测 */
  async function useOpencodePath(path: string) {
    setOcScanBusy(true);
    try {
      const r = await detectOpencode(path, true);
      setOcStatus(r.status);
      if (r.ok) {
        setOcBin(path);
        setOcCandidates(r.candidates);
        onToast(`已使用执行引擎 ${r.status.version ?? ''}`.trim());
      } else {
        onToast(r.error ?? '还是没找到，请检查路径');
      }
    } catch (e) {
      onToast(String(e));
    } finally {
      setOcScanBusy(false);
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
    void loadImportables();
    void fetchMattermostStatus().then(setMmStatus).catch(() => setMmStatus({ configured: false, ok: false }));
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
    if (m.baseUrl === 'opencode://') {
      setTestMsg((s) => ({ ...s, [m.id]: '走执行引擎，无需测试' }));
      return;
    }
    setTestMsg((s) => ({ ...s, [m.id]: '测试中…' }));
    const r = await testModel(m.id);
    setTestMsg((s) => ({ ...s, [m.id]: r.ok ? `连接成功 · ${r.ms}ms` : `失败：${r.error ?? r.status}` }));
  }

  const isRemote = mode === 'remote' || !!localStorage.getItem('sbot.server');

  return (
    <div className="page settings">
      <div className="page-head">
        <div><h2>设置</h2><p>{isRemote ? '服务器模式，配置由服务端管理。' : '本地模式，配置存在本机数据库里。'}</p></div>
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
        <h3>外观</h3>
        <p className="sub">选择界面配色，跟随系统会随操作系统的亮/暗模式自动切换。</p>
        <div className="theme-options">
          {([
            ['dark', '暗色', '深色界面，默认'],
            ['light', '亮色', '浅色界面，适合白天'],
            ['system', '跟随系统', '随操作系统切换'],
          ] as const).map(([key, label, hint]) => (
            <button
              key={key}
              className={`theme-opt ${theme === key ? 'on' : ''}`}
              onClick={() => {
                setThemeMode(key);
                setTheme(key);
                onToast(`已切换为${label}`);
              }}
            >
              <span className={`theme-swatch ${key}`} />
              <span className="theme-meta"><b>{label}</b><em>{hint}</em></span>
              {theme === key && <span className="theme-tick">✓</span>}
            </button>
          ))}
        </div>
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
              title="把所有模型写进执行引擎配置"
              onClick={async () => {
                try {
                  const r = await syncModelsToOpencode();
                  onToast(`已同步 ${r.count} 个模型到执行引擎`);
                } catch (e) {
                  onToast(String(e));
                }
              }}
            >
              同步到执行引擎
            </button>
            <button
              className="btn"
              onClick={async () => {
                try {
                  const list = await fetchImportableModels();
                  setImportables(list);
                  setImportPicked(new Set(list.map((m) => `${m.provider}/${m.model}`)));
                  setImportOpen(true);
                  if (!list.length) onToast('没读到本机执行引擎的自定义模型');
                } catch (e) {
                  onToast(String(e));
                }
              }}
            >
              从执行引擎导入
            </button>
            <button
              className="btn"
              onClick={async () => {
                setOcModelsOpen(true);
                setOcModels([]);
                await loadOpencodeModels();
              }}
            >
              内置模型
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
                <div className="model-sub">{m.model} · {m.baseUrl === 'opencode://' ? '执行引擎' : m.baseUrl}</div>
              </div>
              <div className="model-tags">
                {m.baseUrl === 'opencode://' && <span className="mtag free">执行引擎</span>}
                {m.tools && <span className="mtag">tools</span>}
                {m.stream && <span className="mtag">stream</span>}
                {m.baseUrl !== 'opencode://' && !m.apiKey && <span className="mtag warn">no-key</span>}
              </div>
              <span className="test-inline">{testMsg[m.id] ?? ''}</span>
              <button className="mini" title="测试" onClick={() => void runTest(m)}>◌</button>
              <button className="mini" title="设为默认" onClick={async () => { await setDefaultModel(m.id); await refresh(); onSaved(); onToast('已设为默认'); }}>★</button>
              <button className="mini" title="编辑" onClick={() => setForm({ ...m, apiKey: '' })}>✎</button>
              <button className="mini danger" title="删除" onClick={async () => { if (!window.confirm(`删除模型「${m.name}」？`)) return; await deleteModel(m.id); await refresh(); onSaved(); onToast('模型已删除'); }}>×</button>
            </div>
          ))}
        </div>

        <div className="oc-models">
          <div className="oc-models-head">
            <div>
              <b>执行引擎里的模型</b>
              <span>读自本机执行引擎配置；导入后所有智能体都能复用。</span>
            </div>
            <div className="oc-models-actions">
              <button className="mini" title="重新读取" onClick={() => void loadImportables(true)}>刷新</button>
              <button
                className="mini"
                disabled={!importables.some((m) => m.baseUrl)}
                onClick={() => void importModels(importables.filter((m) => m.baseUrl))}
              >
                全部导入
              </button>
            </div>
          </div>
          {importables.length === 0 ? (
            <div className="oc-models-empty">没读到本机执行引擎的自定义模型。你可以直接在上面添加，再点「同步到执行引擎」。</div>
          ) : (
            importables.map((m) => {
              const imported = models.some((x) => x.model === m.model && x.baseUrl === m.baseUrl);
              return (
                <div key={`${m.provider}/${m.model}`} className="oc-model-row">
                  <div className="oc-model-meta">
                    <div className="oc-model-name">{m.name}{m.isDefault ? <span className="def">默认</span> : null}</div>
                    <div className="model-sub">{m.providerName} · {m.model} · {m.baseUrl || '未填 Base URL'}</div>
                  </div>
                  {imported
                    ? <span className="oc-model-ok">已在用</span>
                    : (
                      <button className="mini" disabled={!m.baseUrl} onClick={() => void importModels([m])}>
                        导入
                      </button>
                    )}
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="set-card">
        <div className="card-head">
          <div>
            <h3>执行引擎</h3>
            <p className="sub" style={{ marginBottom: 0 }}>让智能体能读写文件、跑命令。没有它也能聊天，只是没有工具。</p>
          </div>
          <b className={ocStatus?.available ? 'ok-text' : 'warn-text'}>
            {ocStatus?.available ? `● 可用 ${ocStatus.version ?? ''}` : '● 未找到'}
          </b>
        </div>

        <div className="oc-current">
          <div className="oc-current-main">
            <span>当前使用</span>
            <code title={ocStatus?.bin}>{ocStatus?.bin ?? '还没找到执行引擎，点下面的「自动扫描」'}</code>
          </div>
          {ocStatus?.bin && (
            <button className="mini" onClick={() => void copyText(ocStatus.bin)}>复制</button>
          )}
        </div>

        <label className="field" style={{ marginTop: 12 }}>
          <span>安装目录或执行引擎程序路径（填目录会自动找里面的程序）</span>
          <div className="oc-path-row">
            <input
              className="input"
              value={ocBin}
              onChange={(e) => setOcBin(e.target.value)}
              placeholder="C:\Users\你\AppData\Local\Programs\ai.opencode.desktop"
            />
            <button
              className="btn"
              disabled={ocScanBusy || !ocBin.trim()}
              onClick={() => void useOpencodePath(ocBin.trim())}
            >
              使用这个位置
            </button>
            <button className="btn" disabled={ocScanBusy} onClick={() => void scanOpencode()}>
              {ocScanBusy ? '检测中…' : '自动扫描'}
            </button>
          </div>
        </label>

        {ocCandidates.length > 0 && (
          <div className="oc-candidates">
            <div className="oc-candidates-head">找到 {ocCandidates.length} 个可用程序，点一个直接切换</div>
            {ocCandidates.map((c) => (
              <button
                key={c.bin}
                className={`oc-candidate ${ocStatus?.bin === c.bin ? 'on' : ''}`}
                onClick={() => void useOpencodePath(c.bin)}
              >
                <b>执行引擎 {c.version}</b>
                <code>{c.bin}</code>
                <span>{ocStatus?.bin === c.bin ? '使用中' : '使用'}</span>
              </button>
            ))}
          </div>
        )}

        <div className="oc-dirs">
          <div className="oc-dir-row">
            <span>数据目录</span>
            <code title={ocStatus?.dataDir}>{ocStatus?.dataDir ?? '检测后显示'}</code>
            <button className="mini" disabled={!ocStatus?.dataDir} onClick={() => void copyText(ocStatus?.dataDir)}>复制</button>
          </div>
          <div className="oc-dir-row">
            <span>sidecar 目录</span>
            <code title={ocStatus?.sidecarDir}>{ocStatus?.sidecarDir ?? '检测后显示'}</code>
            <button className="mini" disabled={!ocStatus?.sidecarDir} onClick={() => void copyText(ocStatus?.sidecarDir)}>复制</button>
          </div>
          <div className="settings-actions" style={{ marginTop: 8 }}>
            <button
              className="btn"
              onClick={async () => {
                try {
                  const r = await openOpencodeDataDir();
                  onToast(r.ok ? '已打开数据目录' : r.error ?? '打开失败');
                } catch (e) {
                  onToast(String(e));
                }
              }}
            >
              打开数据目录
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
        </div>

        <details className="oc-advanced">
          <summary>内网离线包 / 覆盖安装</summary>
          <label className="field" style={{ marginTop: 10 }}>
            <span>离线包地址（zip）</span>
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
                    onToast(`执行引擎 ${r.version ?? ''} 安装完成`);
                  } else {
                    if (r.status) setOcStatus(r.status);
                    onToast(r.error ?? '安装失败，检查离线包地址或手动指定安装目录');
                  }
                } catch (e) {
                  onToast(String(e));
                } finally {
                  setOcBusy(false);
                }
              }}
            >
              {ocBusy ? '安装中…' : '下载并安装'}
            </button>
          </div>
          <p className="sub" style={{ margin: '8px 0 0' }}>
            安装会解压到上面的 sidecar 目录。内网下载不通时，让管理员把离线包放到这个地址，或者直接把执行引擎程序放进 sidecar 目录。
          </p>
        </details>

        <p className="sub" style={{ margin: '10px 0 0' }}>
          没检测到？先装一次执行引擎桌面版，S-BOT 会自动找它自带的 CLI；已经装了但没识别，就把安装目录填到上面
          （例如 <code>C:\Users\你\AppData\Local\Programs\ai.opencode.desktop</code>），点「使用这个位置」。
        </p>
      </div>

      {!isRemote && (
      <div className="set-card">
        <div className="card-head">
          <div>
            <h3>Mattermost</h3>
            <p className="sub" style={{ marginBottom: 0 }}>
              用于「找同事」搜索通讯录，以及「邀请更多」给指定账号发私信。
            </p>
          </div>
          <b className={mmStatus?.ok ? 'ok-text' : 'warn-text'}>
            {mmStatus?.mock
              ? '● 模拟模式'
              : mmStatus?.ok
                ? `● 已连接${mmStatus.bot ? ` @${mmStatus.bot.username}` : ''}`
                : mmStatus?.configured
                  ? '● 连接失败'
                  : '● 未配置'}
          </b>
        </div>

        <div className="two" style={{ marginTop: 12 }}>
          <label className="field"><span>Mattermost 地址</span>
            <input
              className="input"
              value={mmUrl}
              onChange={(e) => setMmUrl(e.target.value)}
              placeholder="https://mattermost.example.com"
            />
          </label>
          <label className="field"><span>Bot / 系统 Token</span>
            <input
              className="input"
              type="password"
              value={mmToken}
              onChange={(e) => setMmToken(e.target.value)}
              placeholder="在 Mattermost 里生成"
            />
          </label>
        </div>

        {mmStatus?.configured && !mmStatus.ok && (
          <div className="colleague-note warn" style={{ marginBottom: 10 }}>{mmStatus.error ?? '连接失败，请检查地址和 Token'}</div>
        )}

        <div className="settings-actions">
          <button
            className="btn primary"
            disabled={mmBusy}
            onClick={async () => {
              setMmBusy(true);
              try {
                await patchSettings({ mattermostUrl: mmUrl.trim(), mattermostToken: mmToken.trim() });
                const st = await fetchMattermostStatus();
                setMmStatus(st);
                onToast(st.mock
                  ? '当前使用服务端模拟 Mattermost（不填地址/Token 时可用）'
                  : st.ok ? `Mattermost 已连接${st.bot ? `：@${st.bot.username}` : ''}` : st.error ?? 'Mattermost 连接失败');
              } catch (e) {
                onToast(String(e));
              } finally {
                setMmBusy(false);
              }
            }}
          >
            {mmBusy ? '连接中…' : '保存并测试'}
          </button>
          <button
            className="btn"
            onClick={async () => {
              const st = await fetchMattermostStatus();
              setMmStatus(st);
              onToast(st.mock ? '当前是服务端模拟 Mattermost' : st.ok ? 'Mattermost 正常' : st.error ?? 'Mattermost 未配置');
            }}
          >
            仅检测
          </button>
        </div>
        <p className="sub" style={{ margin: '10px 0 0' }}>
          不填地址 / Token 时使用服务端模拟接口：找同事会返回模拟通讯录，邀请只记录在服务端、不会真的发出。
          填好之后自动切到真实 Mattermost。Token 需要能读取用户、状态和发私信。
        </p>
      </div>
      )}

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

      {ocModelsOpen && (
        <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setOcModelsOpen(false); }}>
          <div className="sheet oc-models-sheet">
            <div className="sheet-head">
              <h3>内置可用模型</h3>
              <p>来自执行引擎内置模型目录。免费模型无需 Key 即可用。</p>
            </div>
            <div className="sheet-body">
              {ocModelsBusy && <div className="kb-empty">读取中…</div>}
              {!ocModelsBusy && ocModels.length === 0 && <div className="kb-empty">没读到模型，确认执行引擎已启动</div>}
              <div className="kb-list">
                {ocModels.map((m) => (
                  <div key={`${m.providerID}/${m.modelID}`} className="kb-item row">
                    <span className="kb-meta">
                      <span className="kb-name">
                        {m.name}
                        {m.free && <span className="mtag free">免费</span>}
                      </span>
                      <span className="kb-sub">{m.providerID} / {m.modelID}{m.limit ? ` · ${Math.round(m.limit / 1000)}k ctx` : ''}</span>
                    </span>
                    <button className="mini" onClick={async () => { await importOpencodeModel(m); }}>导入</button>
                  </div>
                ))}
              </div>
            </div>
            <div className="sheet-foot">
              <span className="foot-note">只显示目录里的模型；实际能否免费以执行引擎为准。</span>
              <button className="btn primary" onClick={() => setOcModelsOpen(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {importOpen && (
        <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setImportOpen(false); }}>
          <div className="sheet">
            <div className="sheet-head">
              <h3>从执行引擎导入模型</h3>
              <p>读本机执行引擎配置里的 providers；API Key 不会带过来，导入后补填。</p>
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
                  setImportOpen(false);
                  const picked = importables.filter((m) => importPicked.has(`${m.provider}/${m.model}`));
                  await importModels(picked);
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
