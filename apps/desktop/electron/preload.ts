import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('sbot', {
  platform: process.platform,
  version: process.versions.electron,
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
