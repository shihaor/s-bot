import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('./packages/server/data/sbot.db');
db.exec('PRAGMA foreign_keys = ON');

const agents = ['ag_pm', 'ag_arch', 'ag_rev', 'ag_writer', 'ag_data'];
const models = ['m_deepseek', 'm_qwen', 'm_local'];

db.prepare(`DELETE FROM agents WHERE id NOT IN (${agents.map(() => '?').join(',')})`).run(...agents);
db.prepare(`DELETE FROM models WHERE id NOT IN (${models.map(() => '?').join(',')})`).run(...models);
db.prepare("DELETE FROM conversations WHERE id LIKE 'cv_g_%'").run();
db.exec(`
  DELETE FROM messages WHERE conversation_id NOT IN (SELECT id FROM conversations);
  DELETE FROM conversation_members WHERE conversation_id NOT IN (SELECT id FROM conversations);
  DELETE FROM conversations WHERE type = 'dm' AND id NOT IN (SELECT 'cv_dm_' || id FROM agents);
`);

console.log('agents', db.prepare('SELECT count(*) c FROM agents').get().c);
console.log('models', db.prepare('SELECT count(*) c FROM models').get().c);
console.log('convs', db.prepare('SELECT count(*) c FROM conversations').get().c);
