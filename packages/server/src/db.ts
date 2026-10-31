import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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

function seed() {
  const countRow = db.prepare('SELECT count(*) AS c FROM agents').get() as { c: number } | undefined;
  if ((countRow?.c ?? 0) > 0) return;

  const insertAgent = db.prepare(`
    INSERT INTO agents (id, name, role, color, initial, model_id, system_prompt, skills, kb_ids, created_at)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
  `);

  const agents = [
    {
      id: 'ag_pm', name: '老周', role: '产品经理', color: '#5B8CFF', initial: '周',
      systemPrompt: '你是老周，产品经理。只谈用户价值、场景和优先级，不写代码。说话简短口语化，一次不超过 120 字。',
      skills: ['需求拆解', '优先级排序', '用户价值判断'],
    },
    {
      id: 'ag_arch', name: '阿哲', role: '架构师', color: '#3DDC97', initial: '哲',
      systemPrompt: '你是阿哲，系统架构师。只谈技术风险、系统边界、性能和长期维护成本。冷静克制，一次不超过 120 字。',
      skills: ['技术选型', '系统边界', '性能与成本'],
    },
    {
      id: 'ag_rev', name: '小柯', role: '评审员', color: '#F5A524', initial: '柯',
      systemPrompt: '你是小柯，评审员。只列阻塞性问题，每条都能对应到具体缺失。不要建议、不要夸奖，最多 3 条。',
      skills: ['方案评审', '风险识别', '验收标准'],
    },
    {
      id: 'ag_writer', name: '阿澜', role: '文案', color: '#C77DFF', initial: '澜',
      systemPrompt: '你是阿澜，文案。把复杂的东西说成人话，避免「赋能」「一站式」这类词。',
      skills: ['文案润色', '信息降噪', '话术设计'],
    },
    {
      id: 'ag_data', name: '数数', role: '数据分析', color: '#37C3D6', initial: '数',
      systemPrompt: '你是数数，数据分析师。先问口径，再谈结论。不确定的数据直接说不确定。',
      skills: ['指标口径', '数据归因', '实验设计'],
    },
  ];

  for (const a of agents) {
    insertAgent.run(a.id, a.name, a.role, a.color, a.initial, a.systemPrompt, JSON.stringify(a.skills), '[]', now());
  }

  const insertConv = db.prepare(
    'INSERT INTO conversations (id, type, title, model_id, pinned, muted, created_at, updated_at) VALUES (?, ?, ?, NULL, 0, 0, ?, ?)',
  );
  const insertMember = db.prepare(
    "INSERT INTO conversation_members (conversation_id, member_type, member_id, muted, talk) VALUES (?, 'agent', ?, 0, 'normal')",
  );

  insertConv.run('cv_g1', 'group', '首页改版评审', now(), now());
  ['ag_pm', 'ag_arch', 'ag_rev'].forEach((id) => insertMember.run('cv_g1', id));

  insertConv.run('cv_g2', 'group', '增长实验', now(), now());
  ['ag_writer', 'ag_data', 'ag_pm'].forEach((id) => insertMember.run('cv_g2', id));

  for (const a of agents) {
    insertConv.run(`cv_dm_${a.id}`, 'dm', a.name, now(), now());
    insertMember.run(`cv_dm_${a.id}`, a.id);
  }

  const insertMessage = db.prepare(
    "INSERT INTO messages (id, conversation_id, author_type, author_id, role, text, parts, model_id, status, created_at) VALUES (?, ?, ?, ?, 'assistant', ?, '[]', NULL, 'done', ?)",
  );

  const base = now();
  const seedMessages: Array<[string, string, number]> = [
    ['m1', 'ag_pm', base - 400000],
    ['m2', 'ag_arch', base - 380000],
    ['m3', 'ag_rev', base - 360000],
    ['m4', 'ag_pm', base - 340000],
  ];
  const texts: Record<string, string> = {
    m1: '先对齐一下：这次改版的目标是「让新用户 30 秒内知道我们能干嘛」，不是把界面做好看。',
    m2: '那要先说清楚代价。现在首页是整包渲染，做个性化推荐就得等接口，首屏会慢 300ms 左右。',
    m3: '我问一个阻塞问题：现在有没有数据能证明用户没看懂？没有的话这次改版就是在猜。',
    m4: '有。上周埋点显示 62% 的新用户在前 10 秒就退出了，而且大部分没点过任何功能入口。',
  };
  for (const [id, author, at] of seedMessages) {
    insertMessage.run(id, 'cv_g1', 'agent', author, texts[id]!, at);
  }
}

seed();

function seedTasks() {
  const row = db.prepare('SELECT count(*) AS c FROM tasks').get() as { c: number } | undefined;
  if ((row?.c ?? 0) > 0) return;
  const insert = db.prepare(
    'INSERT INTO tasks (id, title, description, conversation_id, creator_name, status, priority, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const at = Date.now();
  insert.run('task_seed_1', '整理首页改版的评审结论', '把群里三位的意见收敛成一页', 'cv_g1', '我', 'todo', 'high', at - 86400000, null);
  insert.run('task_seed_2', '确认知识库的数据来源', 'ZHJT 里有重复文档，需要去重', 'cv_g2', '我', 'todo', 'mid', at - 3600000, null);
  insert.run('task_seed_3', '输出增长实验的指标口径', '', 'cv_g2', '我', 'done', 'low', at - 172800000, at - 86400000);
}
seedTasks();

/**
 * 预置两个「模拟真人」同事：用来演示真人在线、拉群、@ 拍板和软等待。
 * 只按固定 ID 补，不覆盖同名的真实账号。
 */
function seedSimulatedHumans() {
  const rows: Array<{ id: string; name: string; role: string; color: string; initial: string }> = [
    { id: 'hu_sim_lina', name: '李娜', role: '增长运营', color: '#FF7A9C', initial: '李' },
    { id: 'hu_sim_wang', name: '王强', role: '后端工程师', color: '#37C3D6', initial: '王' },
    { id: 'hu_sim_chen', name: '陈晨', role: 'UI 设计师', color: '#A0E85C', initial: '陈' },
  ];
  for (const h of rows) {
    const byId = db.prepare('SELECT id FROM humans WHERE id = ?').get(h.id);
    if (byId) {
      db.prepare('UPDATE humans SET simulated = 1 WHERE id = ?').run(h.id);
      continue;
    }
    const byName = db.prepare('SELECT id FROM humans WHERE name = ?').get(h.name);
    if (byName) continue;
    db.prepare(
      'INSERT INTO humans (id, name, role, color, initial, created_at, simulated) VALUES (?, ?, ?, ?, ?, ?, 1)',
    ).run(h.id, h.name, h.role, h.color, h.initial, Date.now());
  }
}
seedSimulatedHumans();

// seeded demo tasks map to the two group conversations
