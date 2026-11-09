import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('sbot', {
  platform: process.platform,
  version: process.versions.electron,
  // 拿到拖进来文件的本地绝对路径（Electron 32+ 的 File.path 被移除，改用 webUtils）
  getPathForFile: (file: File) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },
  notify: (title: string, body: string, theme?: 'dark' | 'light') => ipcRenderer.send('notify', { title, body, theme }),
  // 保存文件到磁盘（弹系统保存对话框）；返回是否真的保存了
  saveFile: (name: string, bytes: ArrayBuffer) => ipcRenderer.invoke('sbot:save-file', { name, bytes }) as Promise<boolean>,
  // 保存本机已有文件（大文件避免走渲染进程内存）
  saveLocalFile: (srcPath: string, name: string) =>
    ipcRenderer.invoke('sbot:save-local-file', { srcPath, name }) as Promise<boolean>,
  // 应用信息（版本 + 本版本更新说明）
  appInfo: () => ipcRenderer.invoke('sbot:app-info') as Promise<{ version: string; changelog: string }>,
  // 检查更新
  checkUpdate: () => ipcRenderer.invoke('sbot:update-check') as Promise<{
    current: string;
    latest?: string;
    hasUpdate?: boolean;
    notes?: string;
    url?: string;
    size?: number;
    releasedAt?: number;
    error?: string;
  }>,
  // 下载安装包（进度通过 onUpdateProgress 回传）
  downloadUpdate: (url: string, version: string) =>
    ipcRenderer.invoke('sbot:update-download', { url, version }) as Promise<{ ok: boolean; path?: string; size?: number; error?: string }>,
  // 启动安装包并退出（自动更新）
  installUpdate: (filePath: string) =>
    ipcRenderer.invoke('sbot:update-install', { filePath }) as Promise<{ ok: boolean; error?: string }>,
  onUpdateProgress: (cb: (p: { received: number; total: number }) => void) => {
    const handler = (_e: unknown, p: { received: number; total: number }) => cb(p);
    ipcRenderer.on('update:progress', handler);
    return () => ipcRenderer.removeListener('update:progress', handler);
  },
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
