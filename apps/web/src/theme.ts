export type ThemeMode = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

const KEY = 'sbot.theme';
const listeners = new Set<(mode: ThemeMode) => void>();

export function getThemeMode(): ThemeMode {
  const saved = localStorage.getItem(KEY);
  return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'dark';
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return mode;
}

function paint(mode: ThemeMode) {
  const resolved = resolveTheme(mode);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeMode = mode;
  document.documentElement.style.colorScheme = resolved;
}

export function applyTheme(mode: ThemeMode) {
  paint(mode);
  for (const fn of listeners) fn(mode);
}

export function setThemeMode(mode: ThemeMode) {
  localStorage.setItem(KEY, mode);
  applyTheme(mode);
}

export function onThemeChange(fn: (mode: ThemeMode) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 在 React 挂载前调用，避免首屏闪一下深色 */
export function initTheme() {
  const mode = getThemeMode();
  paint(mode);
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const onChange = () => {
    if (getThemeMode() === 'system') paint('system');
  };
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else mq.addListener(onChange);
}
