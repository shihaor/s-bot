import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray } from 'electron';
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

ipcMain.on('notify', (_event, payload: { title?: string; body?: string }) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: payload?.title || 'S-BOT',
    body: payload?.body || '有新消息',
    icon: iconPath,
  });
  n.on('click', showWindow);
  n.show();
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
