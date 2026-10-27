import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, screen, shell, Tray } from 'electron';
import path from 'node:path';
import net from 'node:net';
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

async function startServer(): Promise<number> {
  const port = await freePort();
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
    titleBarOverlay: { color: '#0E1116', symbolColor: '#8A93A6', height: 38 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow = win;

  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });

  win.on('close', async (event) => {
    if (isQuitting) return;
    // 托盘模式下：关窗口只是收起来；这里让用户明确选
    event.preventDefault();
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['最小化到托盘', '退出 S-BOT', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      title: '关闭 S-BOT',
      message: '要最小化到托盘，还是直接退出？',
      detail: '退出会中断当前正在生成的回复；最小化后可以从托盘重新打开。',
    });
    if (response === 0) {
      win.hide();
    } else if (response === 1) {
      quitApp();
    }
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
