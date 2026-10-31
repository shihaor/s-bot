import { createSocket, type Socket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { broadcast } from './events.js';

/**
 * 局域网发现（飞秋式）：UDP 广播/组播自己的身份，其他 S-BOT 客户端自动出现。
 * 这一步只做发现；拉群和消息传输后续走 P2P。
 * 说明：公司内网经常屏蔽组播/广播，因此额外提供「手动添加对方 IP:端口」的兜底（见 registerPeer）。
 */
const PORT = Number(process.env.SBOT_LAN_PORT ?? 24250);
const MULTICAST = '239.255.42.99';
const TTL = 12_000;
const DISABLED = process.env.SBOT_LAN_DISCOVERY === '0';

export interface LanPeer {
  id: string;
  name: string;
  role: string;
  color: string;
  initial: string;
  host: string;
  port: number;
  lastSeen: number;
}

interface Identity {
  name: string;
  role: string;
  color: string;
  initial: string;
}

const instanceId = `sbot_${Math.random().toString(36).slice(2, 10)}`;
const peers = new Map<string, LanPeer>();
const manualPeerIds = new Set<string>();
let identity: Identity = { name: 'S-BOT 用户', role: '', color: '#5B8CFF', initial: '人' };
let socket: Socket | null = null;
let timer: NodeJS.Timeout | null = null;
let lastBroadcast = '';
let serverPort = 0;

/** 本机 IPv4 地址（用于展示给用户手动互通） */
function localAddrs(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4') continue;
      if (ni.internal) continue;
      out.push(ni.address);
    }
  }
  return [...new Set(out)];
}

/** 按每个网段的定向广播地址兜底（255.255.255.255 在很多内网被过滤） */
function subnetBroadcasts(): string[] {
  const out = new Set<string>();
  for (const addr of localAddrs()) {
    const parts = addr.split('.');
    if (parts.length !== 4) continue;
    // 常见 /24 和 /16 两种子网都发一份
    out.add(`${parts[0]}.${parts[1]}.${parts[2]}.255`);
    out.add(`${parts[0]}.${parts[1]}.255.255`);
  }
  return [...out];
}

export function setLanPort(port: number): void {
  if (!Number.isFinite(port) || port <= 0) return;
  serverPort = port;
  beacon();
}

function beacon() {
  if (!socket) return;
  const payload = JSON.stringify({
    app: 's-bot',
    v: 1,
    id: instanceId,
    name: identity.name,
    role: identity.role,
    color: identity.color,
    initial: identity.initial,
    port: serverPort,
    ts: Date.now(),
  });
  const targets = [MULTICAST, '255.255.255.255', ...subnetBroadcasts()];
  for (const target of targets) {
    socket.send(payload, 0, Buffer.byteLength(payload), PORT, target, () => { /* ignore */ });
  }
}

function prune() {
  const now = Date.now();
  let changed = false;
  for (const [id, peer] of peers) {
    if (manualPeerIds.has(id)) continue; // 手动添加的同事不因超时消失
    if (now - peer.lastSeen > TTL) {
      peers.delete(id);
      changed = true;
    }
  }
  if (changed) broadcast('lan.peers', getLanPeers());
}

function start() {
  if (DISABLED || socket) return;
  socket = createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('message', (buf, rinfo) => {
    let raw: any;
    try {
      raw = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    if (!raw || raw.app !== 's-bot' || raw.id === instanceId || typeof raw.id !== 'string') return;
    const name = String(raw.name ?? '').trim() || 'S-BOT 用户';
    registerPeer({
      id: raw.id,
      name,
      role: String(raw.role ?? ''),
      color: String(raw.color ?? '#5B8CFF'),
      initial: String(raw.initial ?? name.slice(0, 1)),
      host: rinfo.address,
      port: Number(raw.port ?? 0),
    });
  });
  socket.on('error', () => { /* 端口被占用/组播不可用时不阻塞主服务 */ });
  socket.bind(PORT, () => {
    try { socket?.setBroadcast(true); } catch { /* ignore */ }
    try { socket?.addMembership(MULTICAST); } catch { /* 某些 Wi-Fi 禁组播，走广播兜底 */ }
    beacon();
    timer = setInterval(() => {
      beacon();
      prune();
    }, 3000);
  });
}

export function startLanDiscovery() {
  start();
}

export function stopLanDiscovery() {
  if (timer) clearInterval(timer);
  timer = null;
  try { socket?.close(); } catch { /* ignore */ }
  socket = null;
  peers.clear();
}

/** 手动注册一个内网同事（用于广播/组播被屏蔽时的手动互通兜底） */
export function registerPeer(input: {
  id: string;
  name: string;
  role?: string;
  color?: string;
  initial?: string;
  host: string;
  port: number;
  manual?: boolean;
}): LanPeer {
  const peer: LanPeer = {
    id: input.id,
    name: input.name || 'S-BOT 用户',
    role: String(input.role ?? ''),
    color: String(input.color ?? '#5B8CFF'),
    initial: String(input.initial ?? input.name.slice(0, 1)),
    host: input.host,
    port: Number(input.port ?? 0),
    lastSeen: Date.now(),
  };
  const prev = peers.get(peer.id);
  peers.set(peer.id, peer);
  if (input.manual) manualPeerIds.add(peer.id);
  if (!prev || prev.name !== peer.name || prev.role !== peer.role) {
    broadcast('lan.peers', getLanPeers());
  }
  return peer;
}

export function getLanPeers(): LanPeer[] {
  const now = Date.now();
  return [...peers.values()]
    .filter((p) => now - p.lastSeen <= TTL)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getLanIdentity() {
  return { id: instanceId, ...identity, port: serverPort, addrs: localAddrs() };
}

export function setLanIdentity(next: Partial<Identity>): void {
  identity = {
    name: String(next.name ?? identity.name).trim() || 'S-BOT 用户',
    role: String(next.role ?? identity.role),
    color: String(next.color ?? identity.color),
    initial: String(next.initial ?? identity.initial).slice(0, 2),
  };
  const serialized = JSON.stringify(identity);
  if (serialized !== lastBroadcast) {
    lastBroadcast = serialized;
    beacon();
  }
}

start();
