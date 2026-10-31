import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import AdmZip from 'adm-zip';
import { dirname, join, resolve } from 'node:path';
import { OpenCode } from '@opencode/client';
import type { Agent, ModelInfo } from '@sbot/shared';
import { getAgentSession, getDefaultModel, getSettings, listModels, saveAgentSession, saveSettings } from './repo.js';

const isWin = process.platform === 'win32';
const exeName = isWin ? 'opencode.exe' : 'opencode';

/** 数据目录：和 sbot.db 放在一起 */
const dataDir = resolve(process.env.SBOT_DATA_DIR ?? dirname(process.env.SBOT_DB ?? './data/sbot.db'));
const sidecarDir = join(dataDir, 'sidecar');
const runtimeDir = join(dataDir, 'opencode');
const workspaceRoot = join(runtimeDir, 'workspaces');
const configHome = join(runtimeDir, 'config');
const opencodeDb = join(runtimeDir, 'opencode.db');
const pidFile = join(runtimeDir, 'sidecar.json');

/** 某个会话的工作区目录（群聊/单聊共享目录，智能体的文件都落在这里） */
export function workspaceDirFor(conversationId: string): string {
  return join(workspaceRoot, conversationId);
}

/** 某个智能体在会话里的独立记忆目录（每个智能体一个，互不干扰） */
export function agentWorkspaceDir(conversationId: string, agentId: string): string {
  return join(workspaceRoot, conversationId, agentId);
}

export interface OpencodeStatus {
  available: boolean;
  running: boolean;
  bin?: string;
  version?: string;
  url?: string;
  error?: string;
  dataDir?: string;
  sidecarDir?: string;
  configFile?: string;
}

type Client = ReturnType<typeof OpenCode.make>;

let proc: ChildProcess | null = null;
let client: Client | null = null;
let started: OpencodeStatus = { available: false, running: false };
let binCache: { bin: string; version: string } | null | undefined;
let starting: Promise<boolean> | null = null;
/** 只用来让 opencode 加载 skill 的作用域，第一次列技能时创建 */
let inventorySessionId: string | null = null;

function pathCandidates(): string[] {
  const list: string[] = [];
  const add = (p?: string | null) => { if (p) list.push(p); };
  add(process.env.SBOT_OPENCODE_BIN);
  add(getSettings().opencodeBin);
  add(join(sidecarDir, exeName));
  // 开发态：仓库根目录的 node_modules
  add(resolve(process.cwd(), 'node_modules/@opencode/cli/bin', exeName));
  add(resolve(process.cwd(), '../../node_modules/@opencode/cli/bin', exeName));
  add(resolve(process.cwd(), '../node_modules/@opencode/cli/bin', exeName));
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) add(join(resourcesPath, 'sidecar', exeName));

  const pathSep = isWin ? ';' : ':';
  for (const dir of (process.env.PATH ?? '').split(pathSep)) {
    if (dir.trim()) add(join(dir.trim(), exeName));
  }

  if (isWin) {
    const local = process.env.LOCALAPPDATA ?? '';
    const programDirs = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], local && join(local, 'Programs')]
      .filter(Boolean) as string[];

    // opencode 桌面版自带 CLI
    add(join(local, 'Programs', '@opencode', 'desktop', 'resources', 'opencode-cli.exe'));
    add(join(local, 'Programs', '@opencode', 'resources', 'opencode-cli.exe'));
    add(join(local, 'Programs', '@opencodedesktop', 'resources', 'opencode-cli.exe'));
    add(join(local, 'Programs', 'OpenCode', 'resources', 'opencode-cli.exe'));
    add(join(local, 'Programs', 'opencode', 'resources', 'opencode-cli.exe'));
    for (const dir of programDirs) {
      add(join(dir, 'OpenCode', 'resources', 'opencode-cli.exe'));
      add(join(dir, '@opencode', 'desktop', 'resources', 'opencode-cli.exe'));
      add(join(dir, '@opencodedesktop', 'resources', 'opencode-cli.exe'));
    }
    // 扫描 %LOCALAPPDATA%\Programs\*（桌面版装在哪一层都能找到）
    try {
      for (const entry of readdirSync(join(local, 'Programs'), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const base = join(local, 'Programs', entry.name);
        add(join(base, 'resources', 'opencode-cli.exe'));
        add(join(base, 'desktop', 'resources', 'opencode-cli.exe'));
      }
    } catch { /* ignore */ }

    add(join(process.env.USERPROFILE ?? '', '.opencode', 'bin', 'opencode.exe'));
    add(join(local, 'Programs', 'opencode', 'opencode.exe'));
  } else {
    add('/Applications/OpenCode.app/Contents/Resources/opencode-cli');
    add(join(process.env.HOME ?? '', 'Applications/OpenCode.app/Contents/Resources/opencode-cli'));
    add('/opt/OpenCode/resources/opencode-cli');
    add(join(process.env.HOME ?? '', '.opencode', 'bin', 'opencode'));
    add('/usr/local/bin/opencode');
  }
  return [...new Set(list)];
}

function probe(bin: string): { version: string } | null {
  try {
    const out = execFileSync(bin, ['--version'], { timeout: 8000, encoding: 'utf8' }).trim();
    const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!m) return null;
    if (Number(m[1]) < 2) return null;
    return { version: m[0] };
  } catch {
    return null;
  }
}

/** 上次进程如果崩了，按 pid 文件把残留的 sidecar 收掉 */
function killStaleSidecar() {
  try {
    const info = JSON.parse(readFileSync(pidFile, 'utf8')) as { pid?: number };
    if (info.pid) {
      try { process.kill(info.pid); } catch { /* 已经没了 */ }
    }
  } catch { /* 没有 pid 文件 */ }
  try { rmSync(pidFile, { force: true }); } catch { /* ignore */ }
}

function rememberSidecar(pid: number | undefined, port: number) {
  if (!pid) return;
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(pidFile, JSON.stringify({ pid, port, startedAt: Date.now() }), 'utf8');
}

function forgetSidecar() {
  try { rmSync(pidFile, { force: true }); } catch { /* ignore */ }
}

/** 找一个可用的 opencode v2 可执行文件 */
export function detectBinary(force = false): { bin: string; version: string } | null {
  if (!force && binCache !== undefined) return binCache;
  for (const candidate of pathCandidates()) {
    if (!existsSync(candidate)) continue;
    const ok = probe(candidate);
    if (ok) {
      binCache = { bin: candidate, version: ok.version };
      return binCache;
    }
  }
  binCache = null;
  return null;
}

export interface OpencodePaths {
  dataDir: string;
  sidecarDir: string;
  runtimeDir: string;
  configFile: string;
}

export function getOpencodePaths(): OpencodePaths {
  return { dataDir, sidecarDir, runtimeDir, configFile: configFilePath() };
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile(); } catch { return false; }
}

function isDirectory(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

const BIN_NAMES = isWin ? ['opencode.exe', 'opencode-cli.exe'] : ['opencode', 'opencode-cli'];

/** 在一个安装目录里按 opencode 常见的目录结构找可执行文件 */
function binariesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of BIN_NAMES) out.push(join(dir, name));
  for (const sub of ['bin', 'resources', 'desktop/resources', 'OpenCode/resources', 'resources/app.asar.unpacked']) {
    for (const name of BIN_NAMES) out.push(join(dir, sub, name));
  }
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const base = join(dir, entry.name);
      for (const name of BIN_NAMES) out.push(join(base, name));
      for (const sub of ['bin', 'resources', 'desktop/resources']) {
        for (const name of BIN_NAMES) out.push(join(base, sub, name));
      }
    }
  } catch {
    /* 目录不可读就算了 */
  }
  return out;
}

export interface BinaryCandidate {
  bin: string;
  version: string;
}

/**
 * 扫描可用的 opencode：默认扫常见位置；传了目录/文件就优先检查它。
 * 用于设置页「自动检测」和「使用这个安装目录」。
 */
export function scanBinaryCandidates(extra?: string, limit = 8): BinaryCandidate[] {
  const input = (extra ?? '').trim().replace(/^"|"$/g, '');
  const extraPaths = input ? (isDirectory(input) ? binariesUnder(input) : [input]) : [];
  const seen = new Set<string>();
  const result: BinaryCandidate[] = [];

  for (const candidate of [...extraPaths, ...pathCandidates()]) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isFile(candidate)) continue;
    const ok = probe(candidate);
    if (!ok) continue;
    result.push({ bin: candidate, version: ok.version });
    if (result.length >= limit) break;
  }
  return result;
}

/** 设置页手动指定安装目录 / 可执行文件；成功后立即生效 */
export function applyBinaryPath(input: string): { ok: boolean; bin?: string; error?: string; status: OpencodeStatus } {
  const value = input.trim().replace(/^"|"$/g, '');
  if (!value) {
    saveSettings({ opencodeBin: '' });
    resetBinaryCache();
    return { ok: true, status: getStatus() };
  }

  let bin = value;
  if (isDirectory(value)) {
    let foundBin: string | null = null;
    for (const candidate of binariesUnder(value)) {
      if (isFile(candidate) && probe(candidate)) {
        foundBin = candidate;
        break;
      }
    }
    if (!foundBin) {
      return { ok: false, error: '这个目录里没找到执行引擎程序', status: getStatus() };
    }
    bin = foundBin;
  } else if (!isFile(value)) {
    return { ok: false, error: '路径不存在，或者不是一个文件/目录', status: getStatus() };
  } else if (!probe(value)) {
    return { ok: false, error: '这个文件跑不起来 opencode --version，可能不是 v2 的 CLI', status: getStatus() };
  }

  saveSettings({ opencodeBin: bin });
  resetBinaryCache();
  // 换程序后让旧的 sidecar 退出，下次调用时用新版本重启
  if (proc) shutdown();
  const status = getStatus();
  return { ok: true, bin, status };
}

/** 打开数据目录（Windows 资源管理器 / Finder / xdg-open） */
export function openDataDir(): { ok: boolean; path: string; error?: string } {
  try {
    mkdirSync(dataDir, { recursive: true });
    const cmd = isWin ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(cmd, [dataDir], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, path: dataDir };
  } catch (e) {
    return { ok: false, path: dataDir, error: String((e as Error).message ?? e) };
  }
}

function freePort(): Promise<number> {  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close(() => res(port));
    });
  });
}

let lastConfig = '';

/** 仓库/项目根目录：优先找 .git / workspace 根，避免落到 packages/server */
function projectRoot(): string {
  let cur = process.cwd();
  let firstPkg: string | null = null;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(cur, '.git'))) return cur;
    const pkgFile = join(cur, 'package.json');
    if (existsSync(pkgFile)) {
      if (!firstPkg) firstPkg = cur;
      try {
        const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { workspaces?: unknown };
        if (pkg.workspaces) return cur;
      } catch { /* 继续往上找 */ }
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return firstPkg ?? process.cwd();
}

/** 本机 opencode 会去找的技能目录（sidecar 用独立 XDG，得显式挂进来） */
function localSkillDirs(): string[] {
  const root = projectRoot();
  const dirs = [
    join(homedir(), '.config', 'opencode', 'skills'),
    join(homedir(), '.claude', 'skills'),
    join(homedir(), '.agents', 'skills'),
    join(root, '.opencode', 'skills'),
    join(root, '.claude', 'skills'),
    join(root, '.agents', 'skills'),
  ];
  return [...new Set(dirs)].filter((d) => existsSync(d));
}

/** 把 S-BOT 里的模型全部写进 sidecar 的 opencode 配置：同一个 baseUrl 一个 provider */
function providerConfigFor(models: ModelInfo[], preferred: ModelInfo | null) {
  const buckets = new Map<string, { baseUrl: string; apiKey: string; models: Record<string, { name: string }> }>();
  for (const m of models) {
    const baseUrl = m.baseUrl.trim();
    if (!baseUrl || baseUrl === 'opencode://') continue;
    const key = baseUrl.replace(/\/+$/, '');
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { baseUrl, apiKey: m.apiKey, models: {} };
      buckets.set(key, bucket);
    }
    if (!bucket.apiKey && m.apiKey) bucket.apiKey = m.apiKey;
    bucket.models[m.model] = { name: m.name };
  }

  const preferredKey = preferred?.baseUrl.trim().replace(/\/+$/, '');
  const entries = [...buckets.entries()].sort((a, b) => {
    if (a[0] === preferredKey) return -1;
    if (b[0] === preferredKey) return 1;
    return a[0].localeCompare(b[0]);
  });

  const providers: Record<string, any> = {};
  const providerIdByUrl = new Map<string, string>();
  entries.forEach(([key, bucket], i) => {
    const id = i === 0 ? 'sbot' : `sbot-${i + 1}`;
    providerIdByUrl.set(key, id);
    providers[id] = {
      name: i === 0 ? 'S-BOT' : `S-BOT ${i + 1}`,
      package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: bucket.baseUrl, apiKey: bucket.apiKey },
      models: bucket.models,
    };
  });

  return { providers, providerIdByUrl };
}

export function configFilePath(): string {
  return join(configHome, 'opencode', 'opencode.json');
}

function writeConfig(preferred?: ModelInfo | null) {
  const file = configFilePath();
  mkdirSync(dirname(file), { recursive: true });

  // 保留已有配置：只列技能时不能把正在用的模型抹掉
  let config: Record<string, any> = {};
  if (existsSync(file)) {
    try { config = JSON.parse(readFileSync(file, 'utf8')); } catch { config = {}; }
  }

  config.$schema = 'https://opencode.ai/config.json';

  const allModels = listModels();
  const def = preferred
    ?? allModels.find((m) => m.isDefault)
    ?? getDefaultModel()
    ?? allModels[0]
    ?? null;
  const { providers, providerIdByUrl } = providerConfigFor(allModels, def);

  if (def?.baseUrl === 'opencode://') {
    // 用 opencode 内置模型（如免费 zen）：直接引用 providerID/modelID，opencode 自己管鉴权
    config.model = def.model;
    if (!Object.keys(providers).length) delete config.providers;
    else config.providers = providers;
  } else if (Object.keys(providers).length) {
    config.providers = providers;
    if (def) {
      const key = def.baseUrl.trim().replace(/\/+$/, '');
      const pid = providerIdByUrl.get(key);
      if (pid) config.model = `${pid}/${def.model}`;
    }
  } else {
    delete config.providers;
    delete config.model;
  }

  // 读自动放行；写文件和跑命令走审批
  config.permissions = [
    { action: 'edit', resource: '*', effect: 'ask' },
    { action: 'shell', resource: '*', effect: 'ask' },
    { action: 'external_directory', resource: '*', effect: 'ask' },
  ];

  const skills = localSkillDirs();
  if (skills.length) config.skills = skills;
  else delete config.skills;

  const json = JSON.stringify(config, null, 2);
  if (json === lastConfig) return;
  lastConfig = json;
  writeFileSync(file, json, 'utf8');
  // 配置一变，opencode 会重建 location，旧的作用域会话不再能列出技能
  inventorySessionId = null;
}

/** 模型增删改后调用：强制重写 sidecar 配置，让 opencode 立刻看到全部模型 */
export function syncModelConfig(): { count: number; path: string } {
  lastConfig = '';
  writeConfig();
  const count = listModels().filter((m) => m.baseUrl.trim()).length;
  return { count, path: configFilePath() };
}

export function resetBinaryCache(): void {
  binCache = undefined;
}

async function waitHealthy(baseUrl: string, authorization: string, timeout = 30000): Promise<boolean> {  const at = Date.now();
  while (Date.now() - at < timeout) {
    try {
      const res = await fetch(`${baseUrl}/api/info`, { headers: { authorization } });
      if (res.ok) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

export function getStatus(): OpencodeStatus {
  const bin = detectBinary();
  return {
    ...started,
    available: !!bin,
    bin: bin?.bin,
    version: bin?.version,
    running: !!proc && !!client,
    ...getOpencodePaths(),
  };
}

export interface ImportableModel {
  provider: string;
  providerName: string;
  model: string;
  name: string;
  baseUrl: string;
  isDefault?: boolean;
}

function stripJsonc(text: string): string {
  let out = '';
  let inString = false;
  let escape = false;
  let line = false;
  let block = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (line) {
      if (c === '\n') { line = false; out += c; }
      continue;
    }
    if (block) {
      if (c === '*' && n === '/') { block = false; i++; }
      continue;
    }
    if (inString) {
      out += c;
      if (escape) escape = false;
      else if (c === '\\') escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '/' && n === '/') { line = true; i++; continue; }
    if (c === '/' && n === '*') { block = true; i++; continue; }
    out += c;
  }
  return out;
}

/** 读本机 opencode 的配置，把它配好的自定义模型反推给 S-BOT */
export function importableModels(): ImportableModel[] {
  const dirs = [
    process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, 'opencode') : null,
    join(homedir(), '.config', 'opencode'),
    join(process.env.APPDATA ?? '', 'opencode'),
  ].filter(Boolean) as string[];

  for (const dir of dirs) {
    for (const fileName of ['opencode.jsonc', 'opencode.json']) {
      const file = join(dir, fileName);
      if (!existsSync(file)) continue;
      try {
        const cfg = JSON.parse(stripJsonc(readFileSync(file, 'utf8')));
        const providers = cfg?.providers && typeof cfg.providers === 'object' ? cfg.providers : {};
        const list: ImportableModel[] = [];
        for (const [pid, pv] of Object.entries<any>(providers)) {
          const baseUrl = String(pv?.settings?.baseURL ?? pv?.options?.baseURL ?? pv?.baseURL ?? '').trim();
          const models = pv?.models && typeof pv.models === 'object' ? pv.models : {};
          for (const [key, mv] of Object.entries<any>(models)) {
            const mid = String(mv?.modelID ?? key);
            list.push({
              provider: pid,
              providerName: String(pv?.name ?? pid),
              model: mid,
              name: String(mv?.name ?? mid),
              baseUrl,
            });
          }
        }
        const def = String(cfg?.model ?? '');
        if (def) {
          for (const m of list) {
            if (`${m.provider}/${m.model}` === def || `${m.provider}/${m.name}` === def) m.isDefault = true;
          }
        }
        if (list.length) return list;
      } catch {
        /* 配置文件格式不对就试下一个 */
      }
    }
  }
  return [];
}

export interface OpencodeModel {
  providerID: string;
  modelID: string;
  name: string;
  /** cost 全为 0 即视为免费（如 opencode zen） */
  free: boolean;
  limit: number;
  status: string;
}

/** 读 opencode 内置模型目录（含免费模型），用于在「模型服务」里展示和导入 */
export async function listOpencodeModels(): Promise<OpencodeModel[]> {
  if (!client) await ensureStarted();
  if (!client) throw new Error('执行引擎还没启动');
  const res = await client.model.list({ location: { directory: workspaceRoot } });
  const data = (res as unknown as { data?: any[] }).data ?? [];
  return data.map((m) => ({
    providerID: String(m.providerID ?? ''),
    modelID: String(m.modelID ?? ''),
    name: String(m.name ?? m.modelID ?? ''),
    // 免费：有明确的 cost 且 input/output 都为 0（opencode zen 系列）；没有 cost 信息的不算
    free: Array.isArray(m.cost) && m.cost.length > 0 && m.cost.every((c: any) => (c?.input ?? 0) === 0 && (c?.output ?? 0) === 0),
    limit: Number(m.limit?.context ?? 0),
    status: String(m.status ?? 'active'),
  }));
}

/** 从离线 zip 安装 sidecar（内网 Artifactory） */export async function installFromZip(url: string): Promise<{ ok: boolean; version?: string; error?: string }> {
  const target = join(sidecarDir, exeName);
  try {
    if (!/^https?:\/\//i.test(url)) throw new Error('地址要以 http:// 或 https:// 开头');
    const res = await fetch(url, { signal: AbortSignal.timeout(180000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('下载到的文件是空的');

    const zip = new AdmZip(buf);
    const files = zip.getEntries().filter((e) => !e.isDirectory);
    const entry =
      files.find((e) => new RegExp(`(^|/)${isWin ? 'opencode\\.exe' : 'opencode'}$`, 'i').test(e.entryName)) ??
      files.find((e) => /(^|\/)opencode(\.exe)?$/i.test(e.entryName));
    if (!entry) throw new Error('压缩包里没有找到 opencode 可执行文件');

    mkdirSync(sidecarDir, { recursive: true });
    writeFileSync(target, entry.getData());
    if (!isWin) chmodSync(target, 0o755);

    binCache = undefined;
    const bin = detectBinary(true);
    if (!bin) throw new Error('安装后仍然无法运行');

    // 之前没起来的话，下一次发言会自动用新装好的这个
    return { ok: true, version: bin.version };
  } catch (e) {
    return {
      ok: false,
      error: `${String((e as Error).message ?? e)}。请联系史皓燃获取离线包，或检查内网地址是否可达。`,
    };
  }
}

/** 确保 sidecar 起来；每次都会刷新配置（运行中热加载） */
export async function ensureStarted(model?: ModelInfo | null): Promise<boolean> {
  writeConfig(model);
  if (proc && client) return true;
  if (starting) return starting;

  starting = (async () => {
    const bin = detectBinary(true);
    if (!bin) {
      started = { available: false, running: false, error: '本机没有兼容的执行引擎' };
      return false;
    }

    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(configHome, { recursive: true });
    mkdirSync(sidecarDir, { recursive: true });

    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;

    killStaleSidecar();
    const child = spawn(bin.bin, ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--print-logs'], {
      cwd: workspaceRoot,
      windowsHide: true,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: configHome,
        OPENCODE_DB: opencodeDb,
      },
    });
    proc = child;
    rememberSidecar(child.pid, port);

    const password = await new Promise<string | null>((res) => {
      let buf = '';
      const timer = setTimeout(() => res(null), 20000);
      const onData = (d: Buffer) => {
        buf += d.toString();
        if (process.env.SBOT_OPENCODE_LOG) process.stdout.write(`[opencode] ${d.toString()}`);
        const m = buf.match(/server password (\S+)/);
        if (m) {
          clearTimeout(timer);
          res(m[1]!);
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.once('exit', () => { clearTimeout(timer); res(null); });
    });

    if (!password) {
      started = { available: true, running: false, bin: bin.bin, version: bin.version, error: 'sidecar 启动失败' };
      try { child.kill(); } catch { /* ignore */ }
      proc = null;
      forgetSidecar();
      return false;
    }

    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    const healthy = await waitHealthy(baseUrl, authorization);
    if (!healthy) {
      started = { available: true, running: false, bin: bin.bin, version: bin.version, error: 'sidecar 健康检查失败' };
      try { child.kill(); } catch { /* ignore */ }
      proc = null;
      forgetSidecar();
      return false;
    }

    child.on('exit', () => {
      proc = null;
      client = null;
      pumpStarted = false;
      inventorySessionId = null;
      forgetSidecar();
    });

    client = OpenCode.make({ baseUrl, headers: { authorization } });
    startPump();
    started = { available: true, running: true, bin: bin.bin, version: bin.version, url: baseUrl };
    console.log(`[s-bot] opencode ${bin.version}  ${baseUrl}`);
    return true;
  })();

  try {
    return await starting;
  } finally {
    starting = null;
  }
}

/* ---------- 事件泵：所有 session 共用一个订阅 ---------- */

class Channel {
  private queue: unknown[] = [];
  private waiters: Array<(v: unknown) => void> = [];

  push(v: unknown) {
    const w = this.waiters.shift();
    if (w) w(v);
    else this.queue.push(v);
  }

  next(timeout = 300000): Promise<unknown> {
    const q = this.queue.shift();
    if (q !== undefined) return Promise.resolve(q);
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('等待 opencode 事件超时')), timeout);
      this.waiters.push((v) => { clearTimeout(timer); res(v); });
    });
  }
}

const channels = new Map<string, Channel>();
let pumpStarted = false;

function channelOf(sessionId: string): Channel {
  let ch = channels.get(sessionId);
  if (!ch) {
    ch = new Channel();
    channels.set(sessionId, ch);
  }
  return ch;
}

function startPump() {
  if (pumpStarted || !client) return;
  pumpStarted = true;
  (async () => {
    try {
      for await (const event of client!.event.subscribe()) {
        const sid = (event as { data?: { sessionID?: string } }).data?.sessionID;
        if (sid) channelOf(sid).push(event);
      }
    } catch {
      /* sidecar 没了 */
    } finally {
      pumpStarted = false;
    }
  })();
}

/* ---------- 会话 ---------- */

export interface EnsureSessionResult {
  sessionId: string;
  workspace: string;
}

export async function ensureSession(conversationId: string, agent: Agent): Promise<EnsureSessionResult> {
  if (!client) throw new Error('执行引擎还没启动');
  const existing = getAgentSession(conversationId, agent.id);
  if (existing && existsSync(existing.workspace)) {
    return { sessionId: existing.sessionId, workspace: existing.workspace };
  }

  const workspace = existing?.workspace ?? agentWorkspaceDir(conversationId, agent.id);
  mkdirSync(workspace, { recursive: true });
  const session = await client.session.create({
    location: { directory: workspace },
    title: `${agent.name} · ${conversationId}`,
  });
  saveAgentSession({
    conversationId,
    agentId: agent.id,
    sessionId: session.id,
    workspace,
  });
  return { sessionId: session.id, workspace };
}

export async function resetSession(conversationId: string, agentId: string): Promise<void> {
  if (!client) return;
  const existing = getAgentSession(conversationId, agentId);
  if (existing) {
    try { await client.session.remove({ sessionID: existing.sessionId }); } catch { /* ignore */ }
  }
  saveAgentSession({
    conversationId,
    agentId,
    sessionId: `pending_${Date.now()}`,
    workspace: existing?.workspace ?? agentWorkspaceDir(conversationId, agentId),
  });
}

/* ---------- 技能 ---------- */

export interface OpencodeSkill {
  id: string;
  name: string;
  description?: string;
  autoinvoke?: boolean;
  path: string;
  content: string;
}

/**
 * 列出 opencode 当前能看到的技能。
 * opencode 只有在某个目录建过 session 后才会加载这个 location 的技能，
 * 所以复用一个「技能清单」session 触发加载，而不是每次建新的。
 */
export async function listSkills(): Promise<OpencodeSkill[]> {
  const oc = client;
  if (!oc) throw new Error('执行引擎还没启动');
  const directory = workspaceRoot;

  const fetchList = async () => {
    const res = await oc.skill.list({ location: { directory } });
    return res.data as OpencodeSkill[];
  };

  const warm = async () => {
    const session = await oc.session.create({
      location: { directory },
      title: 'S-BOT · 技能清单',
    });
    inventorySessionId = session.id;
  };

  // 建完 session 后 location 是异步加载的，第一次通常拿不到，轮询一下
  const waitForSkills = async () => {
    for (let i = 0; i < 12; i++) {
      const data = await fetchList();
      if (data.length) return data;
      await new Promise((r) => setTimeout(r, 250));
    }
    return fetchList();
  };

  if (!inventorySessionId) {
    await warm();
    return waitForSkills();
  }

  const data = await fetchList();
  if (data.length) return data;

  // location 被卸载过（比如配置热更新），重建一次作用域
  await warm();
  return waitForSkills();
}

export interface SkillDraftInput {
  id?: string;
  name: string;
  description: string;
  content: string;
  scope?: 'global' | 'project';
  overwrite?: boolean;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trimStart();
}

function yamlString(value: string): string {
  return JSON.stringify(value.replace(/\r?\n/g, ' ').trim());
}

/**
 * 把确认过的草案写成 SKILL.md。
 * 默认写到 ~/.config/opencode/skills/<id>/，也可以写到项目的 .opencode/skills/。
 */
export function createSkill(input: SkillDraftInput): { id: string; path: string; scope: 'global' | 'project'; reloaded: boolean } {
  const name = input.name.trim();
  const description = input.description.trim();
  if (!name) throw new Error('技能名称不能为空');
  if (!description) throw new Error('技能描述不能为空，模型靠它判断什么时候加载');

  const scope: 'global' | 'project' = input.scope === 'project' ? 'project' : 'global';
  const root = scope === 'project'
    ? join(projectRoot(), '.opencode', 'skills')
    : join(homedir(), '.config', 'opencode', 'skills');

  let id = slugify(input.id?.trim() || name);
  if (!id) id = `skill-${Date.now().toString(36)}`;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error('技能 ID 只能用小写字母、数字、- 和 _');

  const dir = join(root, id);
  const file = join(dir, 'SKILL.md');
  if (existsSync(file) && !input.overwrite) {
    throw new Error(`技能「${id}」已存在，换个 ID 或确认覆盖`);
  }

  const body = stripFrontmatter(input.content ?? '');
  const content = [
    '---',
    `name: ${yamlString(name)}`,
    `description: ${yamlString(description)}`,
    '---',
    '',
    body || '## 说明\n\n待补充。',
    '',
  ].join('\n');

  mkdirSync(dir, { recursive: true });
  writeFileSync(file, content, 'utf8');

  // 新目录要挂进 sidecar 配置，下一次列技能时重建作用域
  writeConfig();
  inventorySessionId = null;
  return { id, path: file, scope, reloaded: true };
}

/** 技能落盘后强制让下一次列表重新加载，避免 opencode 缓存 */
export function resetSkillInventory(): void {
  inventorySessionId = null;
}

/* ---------- 审批 ---------- */

const pendingPermissions = new Map<string, (decision: 'once' | 'always' | 'reject') => void>();

export function resolvePermission(requestID: string, decision: 'once' | 'always' | 'reject'): boolean {
  const fn = pendingPermissions.get(requestID);
  if (!fn) return false;
  pendingPermissions.delete(requestID);
  fn(decision);
  return true;
}

function waitPermission(requestID: string, timeout = 60000): Promise<'once' | 'always' | 'reject'> {
  return new Promise((res) => {
    const timer = setTimeout(() => {
      pendingPermissions.delete(requestID);
      res('reject');
    }, timeout);
    pendingPermissions.set(requestID, (decision) => {
      clearTimeout(timer);
      res(decision);
    });
  });
}

/* ---------- 提问表单 ---------- */

const pendingForms = new Map<string, { form: any; resolve: (answer: Record<string, any>) => void }>();

export function resolveForm(formID: string, answer: Record<string, any>): boolean {
  const entry = pendingForms.get(formID);
  if (!entry) return false;
  pendingForms.delete(formID);
  entry.resolve(answer);
  return true;
}

function waitForm(formID: string, form: any, timeout = 120000): Promise<Record<string, any>> {
  return new Promise((res) => {
    const timer = setTimeout(() => {
      pendingForms.delete(formID);
      res(buildFormAnswer(form)); // 超时：默认选第一个选项继续，不卡流程
    }, timeout);
    pendingForms.set(formID, {
      form,
      resolve: (answer) => {
        clearTimeout(timer);
        res(answer);
      },
    });
  });
}

export async function interruptSession(sessionId: string): Promise<void> {
  if (!client) return;
  try { await client.session.interrupt({ sessionID: sessionId }); } catch { /* ignore */ }
}

/* ---------- 单次发言 ---------- */

export type OpencodeEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; id: string; name: string; detail?: string; file?: string | null }
  | { type: 'tool-end'; id: string; ok: boolean }
  | { type: 'permission'; requestID: string; action: string; resources: string[] }
  | { type: 'form'; formID: string; title: string; fields: any[] }
  | { type: 'done'; interrupted?: boolean }
  | { type: 'error'; message: string };

interface RunInput {
  sessionId: string;
  prompt: string;
  signal: AbortSignal;
  /** 本次任务始终允许工具操作，不再逐次等待审批 */
  autoApprove?: boolean;
}

/** 自动回答 opencode 弹出的表单（question 工具）：每个字段取第一个选项/默认值 */
function buildFormAnswer(form: any): Record<string, any> {
  const answer: Record<string, any> = {};
  for (const f of form?.fields ?? []) {
    const key = f?.key;
    if (!key) continue;
    const options = Array.isArray(f?.options) ? f.options : [];
    if (f?.type === 'multiselect') {
      answer[key] = options.length ? [String(options[0]?.value ?? options[0]?.label ?? '')] : [];
    } else if (f?.type === 'boolean') {
      answer[key] = f?.default ?? true;
    } else if (f?.type === 'number' || f?.type === 'integer') {
      answer[key] = f?.default ?? 0;
    } else {
      answer[key] = options.length ? String(options[0]?.value ?? options[0]?.label ?? '') : (f?.default ?? '');
    }
  }
  return answer;
}

export async function* runAgent(input: RunInput): AsyncGenerator<OpencodeEvent> {
  if (!client) throw new Error('执行引擎还没启动');
  startPump();
  const { sessionId, prompt, signal } = input;
  const ch = channelOf(sessionId);

  let aborted = false;
  const onAbort = () => {
    if (aborted) return;
    aborted = true;
    void interruptSession(sessionId);
    ch.push({ type: '__abort' });
  };
  signal.addEventListener('abort', onAbort);

  const toolNames = new Map<string, string>();

  try {
    await client.session.prompt({ sessionID: sessionId, text: prompt });

    while (true) {
      const raw = await ch.next() as {
        type: string;
        data?: any;
      };

      if (raw.type === '__abort') {
        yield { type: 'done', interrupted: true };
        return;
      }
      if (raw.data?.sessionID !== sessionId && raw.data?.form?.sessionID !== sessionId) continue;

      switch (raw.type) {
        case 'session.text.delta':
          if (raw.data.delta) yield { type: 'delta', text: String(raw.data.delta) };
          break;
        case 'session.tool.input.started': {
          toolNames.set(String(raw.data.id), String(raw.data.name));
          yield { type: 'tool', id: String(raw.data.id), name: String(raw.data.name) };
          break;
        }
        case 'session.tool.input.ended': {
          const detail = describeInput(String(raw.data.text ?? ''));
          const file = extractFile(String(raw.data.text ?? ''));
          if (detail || file) {
            yield { type: 'tool', id: String(raw.data.id), name: toolNames.get(String(raw.data.id)) ?? 'tool', detail, file };
          }
          break;
        }
        case 'session.tool.success':
          yield { type: 'tool-end', id: String(raw.data.id), ok: true };
          break;
        case 'session.tool.failed':
          yield { type: 'tool-end', id: String(raw.data.id), ok: false };
          break;
        case 'permission.asked': {
          const requestID = String(raw.data.id);
          if (input.autoApprove) {
            try {
              await client.permission.reply({ sessionID: sessionId, requestID, decision: 'always' });
            } catch { /* 请求可能已超时 */ }
          } else {
            yield {
              type: 'permission',
              requestID,
              action: String(raw.data.action),
              resources: Array.isArray(raw.data.resources) ? raw.data.resources.map(String) : [],
            };
            const decision = await waitPermission(requestID);
            try {
              await client.permission.reply({ sessionID: sessionId, requestID, decision });
            } catch { /* 请求可能已超时 */ }
          }
          break;
        }
        case 'session.execution.succeeded':
          yield { type: 'done' };
          return;
        case 'session.execution.interrupted':
          yield { type: 'done', interrupted: true };
          return;
        case 'session.execution.failed':
          yield { type: 'error', message: String(raw.data?.error?.message ?? 'opencode 执行失败') };
          return;
        case 'form.created': {
          // 智能体弹了问题表单（question 工具）：把表单推到界面让用户回答
          const form = raw.data?.form;
          if (form?.id) {
            const formID = String(form.id);
            yield {
              type: 'form',
              formID,
              title: String(form.title ?? ''),
              fields: Array.isArray(form.fields) ? form.fields : [],
            };
            const answer = await waitForm(formID, form);
            try {
              await client.session.form.reply({ sessionID: sessionId, formID, answer });
            } catch { /* 表单可能已被处理 */ }
          }
          break;
        }
        default:
          break;
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function describeInput(text: string): string {
  if (!text) return '';
  try {
    const input = JSON.parse(text);
    const file = input.filePath ?? input.path ?? input.target;
    if (file) return String(file);
    if (input.command) return String(input.command).slice(0, 80);
    if (input.pattern) return String(input.pattern);
    if (input.query) return String(input.query).slice(0, 60);
    if (input.url) return String(input.url).slice(0, 80);
    return '';
  } catch {
    return text.slice(0, 60);
  }
}

/** 从工具入参里提取文件路径（读/写/改文件类工具），不是文件返回 null */
function extractFile(text: string): string | null {
  if (!text) return null;
  try {
    const input = JSON.parse(text);
    const file = input.filePath ?? input.path ?? input.file ?? input.target;
    if (typeof file === 'string' && file.trim() && !/^https?:\/\//i.test(file.trim())) {
      return file.trim();
    }
    return null;
  } catch {
    return null;
  }
}

export function shutdown(): void {
  if (proc) {
    try { proc.kill(); } catch { /* ignore */ }
  }
  proc = null;
  client = null;
  pumpStarted = false;
  forgetSidecar();
}
