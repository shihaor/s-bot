import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import AdmZip from 'adm-zip';
import { dirname, join, resolve } from 'node:path';
import { OpenCode } from '@opencode/client';
import type { Agent, ModelInfo } from '@sbot/shared';
import { getAgentSession, saveAgentSession } from './repo.js';

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

export interface OpencodeStatus {
  available: boolean;
  running: boolean;
  bin?: string;
  version?: string;
  url?: string;
  error?: string;
}

type Client = ReturnType<typeof OpenCode.make>;

let proc: ChildProcess | null = null;
let client: Client | null = null;
let started: OpencodeStatus = { available: false, running: false };
let binCache: { bin: string; version: string } | null | undefined;
let starting: Promise<boolean> | null = null;

function pathCandidates(): string[] {
  const list: string[] = [];
  const add = (p?: string | null) => { if (p) list.push(p); };
  add(process.env.SBOT_OPENCODE_BIN);
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
    add(join(process.env.LOCALAPPDATA ?? '', 'Programs', 'opencode', 'opencode.exe'));
    add(join(process.env.USERPROFILE ?? '', '.opencode', 'bin', 'opencode.exe'));
  } else {
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

function writeConfig(model: ModelInfo) {  const dir = join(configHome, 'opencode');
  mkdirSync(dir, { recursive: true });
  const config = {
    $schema: 'https://opencode.ai/config.json',
    model: `sbot/${model.model}`,
    providers: {
      sbot: {
        name: 'S-BOT',
        package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: model.baseUrl, apiKey: model.apiKey },
        models: { [model.model]: { name: model.name } },
      },
    },
    // 读自动放行；写文件和跑命令走审批
    permissions: [
      { action: 'edit', resource: '*', effect: 'ask' },
      { action: 'shell', resource: '*', effect: 'ask' },
      { action: 'external_directory', resource: '*', effect: 'ask' },
    ],
  };
  const json = JSON.stringify(config, null, 2);
  if (json === lastConfig) return;
  lastConfig = json;
  writeFileSync(join(dir, 'opencode.json'), json, 'utf8');
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
export async function ensureStarted(model: ModelInfo): Promise<boolean> {
  writeConfig(model);
  if (proc && client) return true;
  if (starting) return starting;

  starting = (async () => {
    const bin = detectBinary(true);
    if (!bin) {
      started = { available: false, running: false, error: '本机没有兼容的 opencode v2' };
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
  if (!client) throw new Error('opencode 还没启动');
  const existing = getAgentSession(conversationId, agent.id);
  if (existing && existsSync(existing.workspace)) {
    return { sessionId: existing.sessionId, workspace: existing.workspace };
  }

  const workspace = existing?.workspace ?? join(workspaceRoot, conversationId);
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
    workspace: existing?.workspace ?? join(workspaceRoot, conversationId),
  });
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

export async function interruptSession(sessionId: string): Promise<void> {
  if (!client) return;
  try { await client.session.interrupt({ sessionID: sessionId }); } catch { /* ignore */ }
}

/* ---------- 单次发言 ---------- */

export type OpencodeEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; id: string; name: string; detail?: string }
  | { type: 'tool-end'; id: string; ok: boolean }
  | { type: 'permission'; requestID: string; action: string; resources: string[] }
  | { type: 'done'; interrupted?: boolean }
  | { type: 'error'; message: string };

interface RunInput {
  sessionId: string;
  prompt: string;
  signal: AbortSignal;
}

export async function* runAgent(input: RunInput): AsyncGenerator<OpencodeEvent> {
  if (!client) throw new Error('opencode 还没启动');
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
      if (raw.data?.sessionID !== sessionId) continue;

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
          if (detail) {
            yield { type: 'tool', id: String(raw.data.id), name: toolNames.get(String(raw.data.id)) ?? 'tool', detail };
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

export function shutdown(): void {
  if (proc) {
    try { proc.kill(); } catch { /* ignore */ }
  }
  proc = null;
  client = null;
  pumpStarted = false;
  forgetSidecar();
}
