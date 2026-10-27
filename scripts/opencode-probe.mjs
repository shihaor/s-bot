/**
 * G1/G2/G3/G5/G4 探针：验证 opencode sidecar 能否用于 S-BOT。
 *
 * 假模型：node scripts/opencode-probe.mjs
 * 真模型：$env:SBOT_LLM_KEY="sk-..."; $env:PROBE_REAL="1"; node scripts/opencode-probe.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenCode } from '@opencode/client';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = resolve(root, '.opencode-probe/workspace');
const isWin = process.platform === 'win32';
const exe = resolve(root, 'node_modules/@opencode/cli/bin', isWin ? 'opencode.exe' : 'opencode');
const PORT = 41999;
const FAKE_PORT = 9999;
const REAL = process.env.PROBE_REAL === '1';

const provider = REAL
  ? {
      name: 'DeepSeek',
      env: ['SBOT_LLM_KEY'],
      package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: 'https://api.deepseek.com/v1' },
      models: { 'deepseek-chat': { name: 'DeepSeek Chat' } },
    }
  : {
      name: 'S-BOT 探针',
      env: ['SBOT_LLM_KEY'],
      package: '@opencode/ai/providers/openai-compatible',
      settings: { baseURL: `http://127.0.0.1:${FAKE_PORT}/v1` },
      models: { echo: { name: 'Echo' } },
    };

mkdirSync(workspace, { recursive: true });
writeFileSync(
  resolve(workspace, 'opencode.json'),
  JSON.stringify(
    {
      $schema: 'https://opencode.ai/config.json',
      model: REAL ? 'sbot/deepseek-chat' : 'sbot/echo',
      providers: { sbot: provider },
      // 和 S-BOT 的默认策略一致：读自动放行，写文件和跑命令要审批
      permissions: [
        { action: 'edit', resource: '*', effect: 'ask' },
        { action: 'shell', resource: '*', effect: 'ask' },
        { action: 'external_directory', resource: '*', effect: 'ask' },
      ],
    },
    null,
    2,
  ),
  'utf8',
);
rmSync(resolve(workspace, 'hello.txt'), { force: true });
rmSync(resolve(workspace, 'bye.txt'), { force: true });

if (!existsSync(exe)) {
  console.error(`找不到 opencode 可执行文件：${exe}`);
  process.exit(1);
}

const children = [];
function killAll() {
  for (const c of children) {
    try { c.kill(); } catch { /* ignore */ }
  }
}
process.on('exit', killAll);

function start(name, command, args, opts = {}) {
  const child = spawn(command, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const logs = [];
  const onData = (d) => {
    const s = d.toString();
    logs.push(s);
    if (process.env.PROBE_VERBOSE) process.stdout.write(`[${name}] ${s}`);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (code) => {
    if (code !== 0 && !child.killed) console.error(`[${name}] exited with ${code}`);
  });
  return { child, logs };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, label, timeout = 30000) {
  const at = Date.now();
  while (Date.now() - at < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* retry */ }
    await wait(400);
  }
  throw new Error(`等待超时：${label}`);
}

async function main() {
  if (!REAL) {
    console.log('▶ 启动假模型 …');
    const fake = start('fake-llm', process.execPath, [resolve(root, 'scripts/fake-llm.mjs')]);
    await waitFor(async () => fake.logs.join('').includes('fake llm on'), '假模型启动');
  }

  console.log(`▶ 启动 opencode serve（${REAL ? 'DeepSeek 真模型' : '假模型'}）…`);
  const oc = start('opencode', exe, ['serve', '--hostname', '127.0.0.1', '--port', String(PORT), '--print-logs'], {
    cwd: workspace,
    env: { ...process.env, SBOT_LLM_KEY: process.env.SBOT_LLM_KEY ?? 'probe-key' },
  });

  const password = await waitFor(() => {
    const m = oc.logs.join('').match(/server password (\S+)/);
    return m?.[1];
  }, 'opencode 密码');

  const baseUrl = `http://127.0.0.1:${PORT}`;
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
  await waitFor(async () => {
    const res = await fetch(`${baseUrl}/api/info`, { headers: { authorization: auth } });
    return res.ok;
  }, 'opencode /api/info');

  const client = OpenCode.make({ baseUrl, headers: { authorization: auth } });

  // 事件流
  const events = [];
  const ac = new AbortController();
  const sub = (async () => {
    try {
      for await (const event of client.event.subscribe()) {
        events.push(event);
      }
    } catch { /* aborted */ }
  })();

  const created = [];
  async function newSession(title) {
    const s = await client.session.create({ location: { directory: workspace }, title });
    created.push(s.id);
    console.log(`  ✔ session ${title}: ${s.id}`);
    return s;
  }

  async function ask(sessionId, text, opts = {}) {
    const before = events.length;
    const started = Date.now();
    const result = await client.session.prompt({ sessionID: sessionId, text }, opts);
    // prompt 返回 user message，等助手跑完
    await client.session.wait({ sessionID: sessionId });
    // 事件是异步推过来的，等本轮 execution 结束事件落地
    await waitFor(
      () => events.slice(before).some(
        (e) => e.type === 'session.execution.succeeded' || e.type === 'session.execution.interrupted' || e.type === 'session.execution.failed',
      ),
      'execution 事件',
      30000,
    );
    await wait(120);
    const fresh = events.slice(before);
    return { result, fresh, ms: Date.now() - started, text: assistantText(fresh, sessionId) };
  }

  console.log('\n▶ G1 上下文连贯');
  const a = await newSession('G1');
  const r1 = await ask(a.id, '记住这个暗号：蓝鲸42');
  console.log(`  第一轮助手：${r1.text.slice(0, 160)}  (${r1.ms}ms)`);
  const r2 = await ask(a.id, '我刚才让你记住的暗号是什么？只回答暗号，不要解释');
  console.log(`  第二轮助手：${r2.text.slice(0, 160)}`);
  const g1 = r2.text.includes('蓝鲸42');
  console.log(`  ${g1 ? '✅' : '❌'} 第二轮${g1 ? '带上了' : '没带上'}上一轮的内容`);

  console.log('\n▶ G3 会话隔离');
  const b = await newSession('G3');
  const r3 = await ask(b.id, '我刚才让你记住的暗号是什么？只回答暗号，不要解释');
  const g3 = !r3.text.includes('蓝鲸42');
  console.log(`  新会话回答：${r3.text.slice(0, 120)}`);
  console.log(`  ${g3 ? '✅' : '❌'} 新会话${g3 ? '没有' : '竟然有'}上一个会话的记忆`);

  console.log('\n▶ G2 事件流');
  const types = [...new Set(r2.fresh.map((e) => e.type))];
  const deltaCount = r2.fresh.filter((e) => e.type === 'session.text.delta').length;
  console.log(`  事件类型 ${types.length} 种：${types.slice(0, 12).join(', ')}`);
  console.log(`  ${deltaCount > 0 ? '✅' : '❌'} 收到 ${deltaCount} 个 text.delta，可逐字转发`);

  let g4 = null;
  let g4deny = null;
  if (REAL) {
    console.log('\n▶ G4 工具调用 + 审批');

    async function waitPermission(sessionId, from, timeout = 120000) {
      const at = Date.now();
      while (Date.now() - at < timeout) {
        const list = await client.permission.request.list().catch(() => null);
        const req = list?.data?.find((r) => r.sessionID === sessionId);
        if (req) return req;
        const done = events.slice(from).some(
          (e) => (e.type === 'session.execution.succeeded' || e.type === 'session.execution.failed') && e.data?.sessionID === sessionId,
        );
        if (done) return null;
        await wait(400);
      }
      return null;
    }

    // 允许：创建 hello.txt
    const s4 = await newSession('G4-allow');
    const before4 = events.length;
    await client.session.prompt({ sessionID: s4.id, text: '在当前目录创建 hello.txt，内容只写 hi。只做这一件事，不要读其他文件。' });
    const req = await waitPermission(s4.id, before4);
    if (req) {
      console.log(`  收到审批请求：action=${req.action} resources=${JSON.stringify(req.resources)}`);
      await client.permission.reply({ sessionID: s4.id, requestID: req.id, decision: 'once' });
      console.log('  已回复 allow(once)');
    } else {
      console.log('  没有收到审批请求（可能直接执行或被拒）');
    }
    await client.session.wait({ sessionID: s4.id }).catch(() => {});
    await wait(600);
    const hello = resolve(workspace, 'hello.txt');
    const wrote = existsSync(hello);
    const content = wrote ? readFileSync(hello, 'utf8').trim() : '';
    const toolEvents = events.slice(before4).filter((e) => e.type.startsWith('session.tool.')).map((e) => e.type);
    console.log(`  工具事件：${[...new Set(toolEvents)].join(', ') || '无'}`);
    console.log(`  hello.txt：${wrote ? `已创建，内容「${content}」` : '没有创建'}`);
    g4 = !!req && wrote && content.includes('hi');
    console.log(`  ${g4 ? '✅' : '❌'} 审批 → 允许 → 文件落盘`);

    // 拒绝：创建 bye.txt
    const s4b = await newSession('G4-deny');
    const before4b = events.length;
    await client.session.prompt({ sessionID: s4b.id, text: '在当前目录创建 bye.txt，内容写 bye。只做这一件事。' });
    const req2 = await waitPermission(s4b.id, before4b);
    if (req2) {
      await client.permission.reply({ sessionID: s4b.id, requestID: req2.id, decision: 'reject', message: '探针：拒绝写入' });
      console.log(`  收到审批请求：action=${req2.action}，已回复 reject`);
    } else {
      console.log('  没有收到审批请求');
    }
    await client.session.wait({ sessionID: s4b.id }).catch(() => {});
    await wait(600);
    const bye = existsSync(resolve(workspace, 'bye.txt'));
    g4deny = !!req2 && !bye;
    console.log(`  bye.txt：${bye ? '竟然被创建了' : '没有创建'}`);
    console.log(`  ${g4deny ? '✅' : '❌'} 审批 → 拒绝 → 文件未落盘`);
  }

  console.log('\n▶ G5 中断');
  const slow = await newSession('G5');
  const beforeSlow = events.length;
  const slowPrompt = REAL ? '请从 1 数到 300，每行一个数字，不要省略，不要解释。' : 'SLOW 请输出四十段文字';
  await client.session.prompt({ sessionID: slow.id, text: slowPrompt });
  await wait(1500);
  const interrupted = await client.session.interrupt({ sessionID: slow.id });
  await client.session.wait({ sessionID: slow.id }).catch(() => {});
  await wait(500);
  const slowEvents = events.slice(beforeSlow);
  const slowText = assistantText(slowEvents, slow.id);
  const sawInterrupt = slowEvents.some((e) => e.type === 'session.execution.interrupted');
  const g5 = sawInterrupt && slowText.length < 300;
  console.log(`  中断后助手输出 ${slowText.length} 字，interrupt 返回：${JSON.stringify(interrupted).slice(0, 80)}`);
  console.log(`  ${g5 ? '✅' : '❌'} 中断事件 ${sawInterrupt ? '收到' : '没收到'}，输出${slowText.length < 300 ? '已停下' : '还在继续'}`);

  console.log('\n▶ 清理');
  for (const id of created) {
    try { await client.session.delete({ sessionID: id }); } catch { /* ignore */ }
  }
  sub.catch(() => {});
  ac.abort();
  console.log(`  已删 ${created.length} 个探针会话`);

  console.log('\n=== 结论 ===');
  console.log(`G1 上下文：${g1 ? 'PASS' : 'FAIL'}`);
  console.log(`G2 事件流：${deltaCount ? 'PASS' : 'FAIL'}`);
  console.log(`G3 隔离：${g3 ? 'PASS' : 'FAIL'}`);
  if (REAL) {
    console.log(`G4 工具审批：${g4 ? 'PASS' : 'FAIL'}（允许写文件）`);
    console.log(`G4 拒绝写入：${g4deny ? 'PASS' : 'FAIL'}（拒绝后不落盘）`);
  } else {
    console.log('G4 工具审批：假模型不产生工具调用，跳过（用 PROBE_REAL=1 跑真模型）');
  }
  console.log(`G5 中断：${g5 ? 'PASS' : 'FAIL'}`);
}

function textOf(result) {
  if (!result) return '';
  if (typeof result === 'string') return result;
  const parts = result.parts ?? result.message?.parts ?? [];
  if (Array.isArray(parts)) {
    return parts.map((p) => (p?.type === 'text' ? p.text : '')).join('');
  }
  return JSON.stringify(result);
}

/** 从事件里拼助手正文（session.text.delta → data.delta） */
function assistantText(events, sessionId) {
  const mine = events.filter((e) => {
    if (e.type !== 'session.text.delta') return false;
    const sid = e.data?.sessionID;
    return !sessionId || !sid || sid === sessionId;
  });
  if (mine.length && process.env.PROBE_VERBOSE) {
    console.log('  [delta sample]', JSON.stringify(mine[0]).slice(0, 260));
  }
  return mine.map((e) => e.data?.delta ?? '').join('');
}

main()
  .then(() => { killAll(); process.exit(0); })
  .catch(async (e) => {
    console.error('\n探针失败：', e);
    killAll();
    process.exit(1);
  });
