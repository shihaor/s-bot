import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('sbot', {
  platform: process.platform,
  version: process.versions.electron,
  // 拿到拖进来文件的本地绝对路径（Electron 32+ 的 File.path 被移除，改用 webUtils）
  getPathForFile: (file: File) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
  notify: (title: string, body: string, theme?: 'dark' | 'light') => ipcRenderer.send('notify', { title, body, theme }),
  onAbort: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('app:abort', handler);
    return () => ipcRenderer.removeListener('app:abort', handler);
  },
  onMinimizedToTray: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('app:minimized-to-tray', handler);
    return () => ipcRenderer.removeListener('app:minimized-to-tray', handler);
  },
  setTitleBarTheme: (theme: 'dark' | 'light') => ipcRenderer.send('titlebar-theme', theme),
});
