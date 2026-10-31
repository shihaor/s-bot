import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { S_BOT_HELPER_ID, S_BOT_MANUAL } from './manual.js';

const file = resolve(process.env.SBOT_DB || './data/sbot.db');
mkdirSync(dirname(file), { recursive: true });

export const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  color TEXT NOT NULL,
  initial TEXT NOT NULL,
  model_id TEXT,
  system_prompt TEXT NOT NULL DEFAULT '',
  skills TEXT NOT NULL DEFAULT '[]',
  kb_ids TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  model_id TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL,
  member_type TEXT NOT NULL,
  member_id TEXT NOT NULL,
  muted INTEGER NOT NULL DEFAULT 0,
  talk TEXT NOT NULL DEFAULT 'normal',
  PRIMARY KEY (conversation_id, member_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  author_type TEXT NOT NULL,
  author_id TEXT,
  role TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  parts TEXT NOT NULL DEFAULT '[]',
  model_id TEXT,
  author_name TEXT,
  author_color TEXT,
  author_initial TEXT,
  status TEXT NOT NULL DEFAULT 'done',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  model TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL DEFAULT '',
  tools INTEGER NOT NULL DEFAULT 1,
  stream INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  conversation_id TEXT,
  creator_name TEXT NOT NULL DEFAULT '我',
  status TEXT NOT NULL DEFAULT 'todo',
  priority TEXT NOT NULL DEFAULT 'mid',
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  conversation_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  workspace TEXT NOT NULL,
  last_message_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, agent_id)
);

CREATE TABLE IF NOT EXISTS humans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#5B8CFF',
  initial TEXT NOT NULL DEFAULT '人',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS group_workflows (
  conversation_id TEXT PRIMARY KEY,
  graph TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  graph_version INTEGER NOT NULL DEFAULT 1,
  input_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  current_node TEXT,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS workflow_steps (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  agent_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  verdict TEXT,
  text TEXT,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);
`);

/* 轻量迁移：给老库补列 */
function ensureColumn(table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

ensureColumn('agents', 'description', "description TEXT NOT NULL DEFAULT ''");
ensureColumn('agents', 'visibility', "visibility TEXT NOT NULL DEFAULT 'team'");
ensureColumn('agents', 'tools', "tools TEXT NOT NULL DEFAULT '{}'");
ensureColumn('conversations', 'auto_reply', 'auto_reply INTEGER NOT NULL DEFAULT 1');
ensureColumn('conversations', 'sup_model', 'sup_model TEXT');
ensureColumn('conversations', 'max_turns', 'max_turns INTEGER NOT NULL DEFAULT 0');
ensureColumn('conversations', 'p2p_group_id', 'p2p_group_id TEXT');
ensureColumn('conversations', 'p2p_host_id', 'p2p_host_id TEXT');
ensureColumn('conversations', 'p2p_token', 'p2p_token TEXT');
ensureColumn('conversations', 'p2p_peers', "p2p_peers TEXT NOT NULL DEFAULT '[]'");
ensureColumn('messages', 'author_name', 'author_name TEXT');
ensureColumn('messages', 'author_color', 'author_color TEXT');
ensureColumn('messages', 'author_initial', 'author_initial TEXT');
ensureColumn('agents', 'owner_id', 'owner_id TEXT');
ensureColumn('humans', 'simulated', 'simulated INTEGER NOT NULL DEFAULT 0');
ensureColumn('conversations', 'workflow_done', 'workflow_done INTEGER NOT NULL DEFAULT 0');

/** 一次性默认：群聊发言不限制，让智能体多轮讨论 */
function migrateUnlimitedTurns() {
  const done = db.prepare("SELECT value FROM settings WHERE key = 'max_turns_unlimited_v2'").get();
  if (done) return;
  db.exec('UPDATE conversations SET max_turns = 0');
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('max_turns_unlimited_v2', '1')").run();
}
migrateUnlimitedTurns();

function seedModels() {
  const row = db.prepare('SELECT count(*) AS c FROM models').get() as { c: number } | undefined;
  if ((row?.c ?? 0) > 0) return;

  const insert = db.prepare(
    'INSERT INTO models (id, name, model, base_url, api_key, tools, stream, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const envBase = process.env.LLM_BASE_URL?.trim() ?? '';
  const envKey = process.env.LLM_API_KEY?.trim() ?? '';
  const envModel = process.env.LLM_MODEL?.trim() || 'deepseek-chat';

  const at = Date.now();
  insert.run('m_deepseek', 'DeepSeek Chat', envBase ? envModel : 'deepseek-chat', envBase || 'https://api.deepseek.com/v1', envKey, 1, 1, 1, at);
  insert.run('m_qwen', 'Qwen Turbo', 'qwen-turbo', 'https://dashscope.aliyuncs.com/compatible-mode/v1', '', 1, 1, 0, at);
  insert.run('m_local', '本地 vLLM', 'qwen2.5-32b-instruct', 'http://127.0.0.1:8000/v1', '', 0, 1, 0, at);
}
seedModels();

const now = () => Date.now();

/**
 * 演示/测试数据的固定 ID（老版本预置的 5 个智能体、2 个群、3 条任务、3 个模拟真人）。
 * 升级时一次性清理，保证用户装完就是一个干净环境。
 */
const DEMO_AGENT_IDS = ['ag_pm', 'ag_arch', 'ag_rev', 'ag_writer', 'ag_data'];
const DEMO_CONV_IDS = ['cv_g1', 'cv_g2', ...DEMO_AGENT_IDS.map((id) => `cv_dm_${id}`)];
const DEMO_TASK_IDS = ['task_seed_1', 'task_seed_2', 'task_seed_3'];
const DEMO_HUMAN_IDS = ['hu_sim_lina', 'hu_sim_wang', 'hu_sim_chen'];

function cleanupDemoData() {
  const done = db.prepare("SELECT value FROM settings WHERE key = 'demo_cleanup_v2'").get();
  if (done) return;

  for (const id of DEMO_AGENT_IDS) {
    db.prepare('DELETE FROM conversation_members WHERE member_id = ?').run(id);
    db.prepare('DELETE FROM agent_sessions WHERE agent_id = ?').run(id);
    db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  }
  for (const id of DEMO_CONV_IDS) {
    db.prepare('DELETE FROM group_workflows WHERE conversation_id = ?').run(id);
    db.prepare('DELETE FROM conversation_members WHERE conversation_id = ?').run(id);
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(id);
    db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  }
  for (const id of DEMO_TASK_IDS) db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  for (const id of DEMO_HUMAN_IDS) db.prepare('DELETE FROM humans WHERE id = ?').run(id);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('demo_cleanup_v2', '1')").run();
}
cleanupDemoData();

/**
 * 预置唯一一个「S-BOT 助手」：内置本软件使用手册，用户问它怎么用即可。
 * 只在没有同名智能体时创建，不覆盖用户后续的修改。
 * 同时在消息列表里默认放一个它的单聊，方便用户直接问。
 */
function seedHelper() {
  const exists = db.prepare('SELECT id FROM agents WHERE id = ?').get(S_BOT_HELPER_ID);
  if (!exists) {
    db.prepare(
      'INSERT INTO agents (id, name, role, color, initial, model_id, system_prompt, description, skills, kb_ids, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)',
    ).run(
      S_BOT_HELPER_ID,
      'S-BOT 助手',
      '使用向导',
      '#5B8CFF',
      '助',
      S_BOT_MANUAL,
      'S-BOT 的使用手册都在我这里，问我怎么用就行。',
      JSON.stringify(['使用帮助', '功能讲解', '问题排查']),
      '[]',
      now(),
    );
  }

  // 默认开一个 S-BOT 助手的单聊，让它在左侧消息列表里直接可见
  const dmId = `cv_dm_${S_BOT_HELPER_ID}`;
  const dm = db.prepare('SELECT id FROM conversations WHERE id = ?').get(dmId);
  if (!dm) {
    const at = now();
    db.prepare(
      'INSERT INTO conversations (id, type, title, model_id, pinned, muted, max_turns, created_at, updated_at) VALUES (?, ?, ?, NULL, 0, 0, 0, ?, ?)',
    ).run(dmId, 'dm', 'S-BOT 助手', at, at);
    db.prepare(
      "INSERT INTO conversation_members (conversation_id, member_type, member_id, muted, talk) VALUES (?, 'agent', ?, 0, 'normal')",
    ).run(dmId, S_BOT_HELPER_ID);
  }
}
seedHelper();
