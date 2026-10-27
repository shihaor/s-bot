import { EventEmitter } from 'node:events';

export interface BusEvent {
  type: string;
  conversationId?: string;
  at: number;
  data?: unknown;
}

export const bus = new EventEmitter();
bus.setMaxListeners(200);

/** 服务端事件总线：所有在线客户端共享一份推送 */
export function broadcast(type: string, data: unknown = {}, conversationId?: string): void {
  bus.emit('event', { type, data, conversationId, at: Date.now() } satisfies BusEvent);
}
