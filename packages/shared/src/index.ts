export type ConvType = 'group' | 'dm';
export type MemberType = 'agent' | 'human';
export type AuthorType = 'user' | 'agent' | 'human' | 'system';

export interface Agent {
  id: string;
  name: string;
  role: string;
  color: string;
  initial: string;
  modelId: string | null;
  systemPrompt: string;
  description: string;
  visibility: 'team' | 'private';
  ownerId?: string | null;
  tools: { read?: boolean; web?: boolean; shell?: boolean };
  skills: string[];
  kbIds: string[];
  createdAt: number;
}

export interface Member {
  conversationId: string;
  memberId: string;
  memberType: MemberType;
  name: string;
  role: string;
  color: string;
  initial: string;
  muted: boolean;
  talk: 'low' | 'normal' | 'high';
  online: boolean;
}

export interface LastMessage {
  text: string;
  authorName: string;
  at: number;
}

export interface Conversation {
  id: string;
  type: ConvType;
  title: string;
  modelId: string | null;
  pinned: boolean;
  muted: boolean;
  autoReply: boolean;
  supModel: string | null;
  maxTurns: number;
  createdAt: number;
  updatedAt: number;
  members: Member[];
  lastMessage: LastMessage | null;
}

export interface Message {
  id: string;
  conversationId: string;
  authorType: AuthorType;
  authorId: string | null;
  authorName?: string | null;
  authorColor?: string | null;
  authorInitial?: string | null;
  role: 'user' | 'assistant' | 'system';
  text: string;
  parts: unknown[];
  modelId: string | null;
  status: 'streaming' | 'done' | 'error' | 'interrupted';
  createdAt: number;
}

/** 群聊交接包：导出后可在另一个群导入，带着上下文和任务继续做。 */
export interface HandoffPackage {
  kind: 's-bot-handoff';
  version: 1;
  exportedAt: number;
  conversation: {
    title: string;
    type: string;
    members: Array<{ name: string; role: string; color: string; initial: string }>;
  };
  messages: Array<{
    authorType: AuthorType;
    authorName: string | null;
    authorColor: string | null;
    authorInitial: string | null;
    role: 'user' | 'assistant' | 'system';
    text: string;
    parts: unknown[];
    status: string;
    createdAt: number;
  }>;
  tasks: Array<{
    title: string;
    description: string;
    priority: 'high' | 'mid' | 'low';
    status: TaskStatus;
    creatorName: string;
    createdAt: number;
  }>;
}

export interface ModelInfo {
  id: string;
  name: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  tools: boolean;
  stream: boolean;
  isDefault: boolean;
  createdAt: number;
}

export type TaskStatus = 'todo' | 'awaiting' | 'done';

/** 首次进入会话时的开场白 + 推荐问题 */
export interface ChatIntro {
  kind: 'dm' | 'group';
  title: string;
  greeting: string;
  suggestions: string[];
}

export interface Task {
  id: string;
  title: string;
  description: string;
  conversationId: string | null;
  creatorName: string;
  status: TaskStatus;
  priority: 'high' | 'mid' | 'low';
  createdAt: number;
  completedAt: number | null;
}
