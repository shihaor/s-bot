import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, screen, shell, Tray } from 'electron';
import path from 'node:path';
import net from 'node:net';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { copyFile, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

const iconPath = path.join(__dirname, '../assets/icon.png');
const trayIconPath = path.join(__dirname, '../assets/tray.png');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

app.setAppUserModelId('com.sbot.desktop');

// 单实例锁：重复启动时直接唤起已运行实例的主窗口，避免端口占用报错
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 用户再次启动时，把已运行实例的主窗口唤到前台（含从托盘恢复）
    showWindow();
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 8787;
      srv.close(() => resolve(port));
    });
  });
}

/** 内置服务固定端口：同事之间只报 IP 就能互通，避免每次启动端口漂移 */
const DEFAULT_HTTP_PORT = 17070;

function tryPort(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(null));
    srv.listen(port, '0.0.0.0', () => {
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(): Promise<number> {
  // 优先用固定端口 17070；被占用时退回随机端口（此时需在设置里指定对方真实端口）
  let port = await tryPort(DEFAULT_HTTP_PORT);
  if (!port) port = await freePort();
  process.env.PORT = String(port);
  process.env.SBOT_STATIC_DIR = path.join(__dirname, '../web');
  process.env.SBOT_DB = path.join(app.getPath('userData'), 'sbot.db');

  const require = createRequire(import.meta.url);
  require('../server/index.cjs');

  await new Promise((r) => setTimeout(r, 400));
  return port;
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (tray) return;
  const icon = nativeImage.createFromPath(trayIconPath);
  tray = new Tray(icon);
  tray.setToolTip('S-BOT');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示 S-BOT', click: showWindow },
      { type: 'separator' },
      { label: '退出', click: () => quitApp() },
    ]),
  );
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

function quitApp() {
  if (isQuitting) return;
  isQuitting = true;
  try { mainWindow?.webContents.send('app:abort'); } catch { /* ignore */ }
  // 给前端 300ms 中断当前流，再退出
  setTimeout(() => app.quit(), 300);
}

function createWindow(url: string) {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    backgroundColor: '#0A0C10',
    icon: iconPath,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: 'rgba(0,0,0,0)', symbolColor: '#8A93A6', height: 38 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
      // 关闭渲染进程节流：窗口缩到托盘/后台时 rAF 和定时器不会被暂停，
      // 避免恢复窗口或弹桌面通知时 UI 卡顿、动画卡在不可见状态
      backgroundThrottling: false,
    },
  });
  mainWindow = win;

  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });

  win.on('close', (event) => {
    if (isQuitting) return;
    // 点关闭直接缩到托盘，不退出；退出走托盘菜单
    event.preventDefault();
    win.hide();
    win.webContents.send('app:minimized-to-tray');
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  void win.loadURL(url);
}

let notifyWindow: BrowserWindow | null = null;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 自绘通知窗口：颜色跟随 App 主题，不用系统通知（系统通知无法控制配色） */
function showThemedNotification(payload: { title?: string; body?: string; theme?: 'dark' | 'light' }) {
  const theme = payload.theme === 'light' ? 'light' : 'dark';
  const palette = theme === 'light'
    ? { bg: '#ffffff', border: '#d7dfeb', text: '#1b2333', muted: '#59657c', accent: '#3b6ef0', shadow: 'rgba(24, 38, 65, 0.18)' }
    : { bg: '#161a21', border: '#2e394b', text: '#e6eaf2', muted: '#8a94a8', accent: '#5b8cff', shadow: 'rgba(0, 0, 0, 0.45)' };

  const title = escapeHtml(payload.title || 'S-BOT');
  const body = escapeHtml(payload.body || '有新消息');
  const width = 360;
  const height = 108;

  try {
    const area = screen.getPrimaryDisplay().workArea;
    if (notifyWindow && !notifyWindow.isDestroyed()) notifyWindow.destroy();
    notifyWindow = new BrowserWindow({
      width,
      height,
      x: area.x + area.width - width - 20,
      y: area.y + area.height - height - 20,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: true,
      show: false,
      webPreferences: { sandbox: true },
    });
    notifyWindow.setAlwaysOnTop(true, 'screen-saver');
    const win = notifyWindow;
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;background:transparent;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
      .card{box-sizing:border-box;margin:6px;padding:13px 15px;border-radius:14px;background:${palette.bg};border:1px solid ${palette.border};color:${palette.text};box-shadow:0 14px 36px ${palette.shadow};display:flex;gap:11px;align-items:flex-start}
      .dot{width:8px;height:8px;flex:0 0 8px;border-radius:50%;background:${palette.accent};box-shadow:0 0 9px ${palette.accent};margin-top:6px}
      .content{min-width:0;flex:1}
      .title{font-size:13px;font-weight:600;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .body{margin-top:4px;font-size:11.5px;line-height:1.55;color:${palette.muted};display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
      .brand{position:absolute;right:16px;bottom:10px;font-size:9px;letter-spacing:.12em;color:${palette.muted};opacity:.75}
    </style></head><body><div class="card"><span class="dot"></span><div class="content">
      <div class="title">${title}</div><div class="body">${body}</div>
    </div><span class="brand">S-BOT</span></div></body></html>`;
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    win.once('ready-to-show', () => { if (!win.isDestroyed()) win.showInactive(); });
    win.on('focus', () => {
      showWindow();
      if (!win.isDestroyed()) win.close();
    });
    win.on('closed', () => {
      if (notifyWindow === win) {
        notifyWindow = null;
        if (notifyTimer) {
          clearTimeout(notifyTimer);
          notifyTimer = null;
        }
      }
    });
    if (notifyTimer) clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => {
      if (!win.isDestroyed()) win.close();
    }, 6500);
  } catch {
    // 自绘窗口失败时退回系统通知
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: payload?.title || 'S-BOT',
      body: payload?.body || '有新消息',
      icon: iconPath,
    });
    n.on('click', showWindow);
    n.show();
  }
}

ipcMain.on('notify', (_event, payload: { title?: string; body?: string; theme?: 'dark' | 'light' }) => {
  showThemedNotification(payload ?? {});
});

const TITLEBAR_THEME = {
  dark: { color: 'rgba(0,0,0,0)', symbolColor: '#8A93A6' },
  light: { color: 'rgba(0,0,0,0)', symbolColor: '#59657C' },
};

/** 前端主题切换时同步标题栏（右上角窗口控制按钮）配色 */
ipcMain.on('titlebar-theme', (_event, theme: 'dark' | 'light') => {
  console.log('[titlebar-theme] received', theme);
  const t = TITLEBAR_THEME[theme] ?? TITLEBAR_THEME.dark;
  mainWindow?.setTitleBarOverlay({ ...t, height: 38 });
  console.log('[titlebar-theme] applied', JSON.stringify(t), 'mainWindow?', !!mainWindow);
});

/** 保存文件：弹出系统保存对话框，写入用户选的位置（真人互传接收用） */
ipcMain.handle('sbot:save-file', async (event, payload: { name?: string; bytes?: ArrayBuffer }) => {
  const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined;
  const name = String(payload?.name ?? 'file').replace(/[\\/:*?"<>|]/g, '_') || 'file';
  const bytes = payload?.bytes;
  if (!bytes) return false;
  const options = { defaultPath: path.join(app.getPath('downloads'), name) };
  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return false;
  await writeFile(result.filePath, Buffer.from(bytes));
  return true;
});

/** 保存本机已有文件（接收完成的大文件走这里，避免把内容读进渲染进程） */
ipcMain.handle('sbot:save-local-file', async (event, payload: { srcPath?: string; name?: string }) => {
  const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow ?? undefined;
  const src = String(payload?.srcPath ?? '');
  if (!src) return false;
  const name = String(payload?.name ?? path.basename(src)).replace(/[\\/:*?"<>|]/g, '_') || 'file';
  const options = { defaultPath: path.join(app.getPath('downloads'), name) };
  const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return false;
  if (src === result.filePath) return true;
  await copyFile(src, result.filePath);
  return true;
});

/* ---------- 检查更新 / 下载安装 ---------- */

/** 更新包目录（Artifactory）。可用 SBOT_UPDATE_BASE 覆盖，打包时也能改。 */
const UPDATE_BASE = (process.env.SBOT_UPDATE_BASE || 'http://10.201.1.19:80/artifactory/installer/sbot').replace(/\/+$/, '');

function parseVersion(v: string): number[] {
  return String(v).replace(/^v/i, '').split(/[.\-+]/).map((n) => Number(n) || 0);
}

function compareVersion(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** 当前版本对应的更新说明（打包时把 CHANGELOG.md 放进了 resources） */
function currentChangelog(): string {
  const candidates = [
    path.join(process.resourcesPath ?? '', 'CHANGELOG.md'),
    path.join(app.getAppPath(), 'CHANGELOG.md'),
    path.resolve(__dirname, '../../../CHANGELOG.md'),
  ];
  for (const file of candidates) {
    try {
      if (!file || !existsSync(file)) continue;
      const md = readFileSync(file, 'utf8');
      const v = app.getVersion().replace(/\./g, '\\.');
      const m = md.match(new RegExp(`^##\\s+v?${v}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'm'));
      if (m?.[1]) return m[1].trim();
    } catch {
      /* 换下一个候选 */
    }
  }
  return '';
}

interface LatestInfo {
  version: string;
  url: string;
  notes?: string;
  size?: number;
  sha256?: string;
  releasedAt?: number;
}

async function fetchLatest(): Promise<LatestInfo | null> {
  // 1) 优先读构建时生成的 latest.json（带更新说明和校验值）
  try {
    const res = await fetch(`${UPDATE_BASE}/latest.json`, { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const data = (await res.json()) as LatestInfo;
      if (data?.version) {
        return { ...data, url: data.url || `${UPDATE_BASE}/S-BOT%20Setup%20${data.version}.exe` };
      }
    }
  } catch {
    /* 没放 latest.json 就走目录列表 */
  }
  // 2) 兜底：解析 Artifactory 目录列表里的安装包名，取最高版本
  try {
    const res = await fetch(`${UPDATE_BASE}/`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const html = await res.text();
    const versions = [...html.matchAll(/S-BOT(?:%20|\s)Setup(?:%20|\s)(\d+\.\d+\.\d+)\.exe/gi)].map((m) => m[1]);
    if (!versions.length) return null;
    versions.sort((a, b) => compareVersion(a, b));
    const version = versions[versions.length - 1];
    return { version, url: `${UPDATE_BASE}/S-BOT%20Setup%20${version}.exe` };
  } catch {
    return null;
  }
}

ipcMain.handle('sbot:app-info', () => ({
  version: app.getVersion(),
  changelog: currentChangelog(),
}));

ipcMain.handle('sbot:update-check', async () => {
  const current = app.getVersion();
  const latest = await fetchLatest();
  if (!latest) {
    return { current, error: `连不上更新服务器（${UPDATE_BASE}），确认内网能访问后重试` };
  }
  return {
    current,
    latest: latest.version,
    hasUpdate: compareVersion(latest.version, current) > 0,
    notes: latest.notes ?? '',
    url: latest.url,
    size: latest.size ?? 0,
    releasedAt: latest.releasedAt ?? 0,
  };
});

ipcMain.handle('sbot:update-download', async (event, payload: { url?: string; version?: string }) => {
  const url = String(payload?.url ?? '');
  const version = String(payload?.version ?? '');
  if (!url) return { ok: false, error: '缺少下载地址' };
  const target = path.join(app.getPath('temp'), `S-BOT Setup ${version || 'latest'}.exe`);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30 * 60 * 1000) });
    if (!res.ok || !res.body) return { ok: false, error: `下载失败 ${res.status}` };
    const total = Number(res.headers.get('content-length') ?? 0);
    const readable = Readable.fromWeb(res.body as any);
    let received = 0;
    let lastAt = 0;
    readable.on('data', (chunk: Buffer | Uint8Array) => {
      received += chunk.length;
      const now = Date.now();
      if (now - lastAt < 200 && received !== total) return;
      lastAt = now;
      if (!event.sender.isDestroyed()) {
        event.sender.send('update:progress', { received, total });
      }
    });
    await pipeline(readable, createWriteStream(target));
    return { ok: true, path: target, size: received };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
});

ipcMain.handle('sbot:update-install', async (_event, payload: { filePath?: string }) => {
  const file = String(payload?.filePath ?? '');
  if (!file || !existsSync(file)) return { ok: false, error: '安装包不存在，请重新下载' };
  const err = await shell.openPath(file);
  if (err) return { ok: false, error: err };
  setTimeout(() => app.quit(), 800);
  return { ok: true };
});

if (gotSingleInstanceLock) {
  app.whenReady().then(async () => {
    let url = 'http://localhost:5173';
    if (!isDev) {
      const port = await startServer();
      url = `http://127.0.0.1:${port}`;
    }
    createTray();
    createWindow(url);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(url);
      else showWindow();
    });
  });

  app.on('before-quit', () => {
    isQuitting = true;
    try { mainWindow?.webContents.send('app:abort'); } catch { /* ignore */ }
  });

  app.on('window-all-closed', () => {
    // 有托盘时，关掉窗口不退出应用
    if (!tray && process.platform !== 'darwin') app.quit();
  });
}
