import { createSocket, type Socket } from 'node:dgram';
import { broadcast } from './events.js';

/**
 * 局域网发现（飞秋式）：UDP 广播/组播自己的身份，其他 S-BOT 客户端自动出现。
 * 这一步只做发现；拉群和消息传输后续走 P2P。
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
let identity: Identity = { name: 'S-BOT 用户', role: '', color: '#5B8CFF', initial: '人' };
let socket: Socket | null = null;
let timer: NodeJS.Timeout | null = null;
let lastBroadcast = '';

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
    port: 0,
    ts: Date.now(),
  });
  const send = (target: string) => {
    socket?.send(payload, 0, Buffer.byteLength(payload), PORT, target, () => { /* ignore */ });
  };
  send(MULTICAST);
  send('255.255.255.255');
}

function prune() {
  const now = Date.now();
  let changed = false;
  for (const [id, peer] of peers) {
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
    const peer: LanPeer = {
      id: raw.id,
      name,
      role: String(raw.role ?? ''),
      color: String(raw.color ?? '#5B8CFF'),
      initial: String(raw.initial ?? name.slice(0, 1)),
      host: rinfo.address,
      port: Number(raw.port ?? 0),
      lastSeen: Date.now(),
    };
    const prev = peers.get(peer.id);
    peers.set(peer.id, peer);
    if (!prev || prev.name !== peer.name || prev.role !== peer.role) {
      broadcast('lan.peers', getLanPeers());
    }
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

export function getLanPeers(): LanPeer[] {
  const now = Date.now();
  return [...peers.values()]
    .filter((p) => now - p.lastSeen <= TTL)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getLanIdentity() {
  return { id: instanceId, ...identity, port: PORT };
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
