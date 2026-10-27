/**
 * 假 OpenAI 兼容服务：给 opencode 探针用，验证会话记忆 / 事件流 / 中断。
 * - 请求里带过 42 且当前问「多少」→ 回 42（证明会话历史被带上了）
 * - 以 SLOW 开头 → 慢慢吐 40 段，方便测中断
 */
import http from 'node:http';

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
  });
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('\n');
  }
  return '';
}

const server = http.createServer(async (req, res) => {
  if (!req.url?.includes('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
    return;
  }

  const body = await readJson(req);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const all = messages.map((m) => `${m.role}: ${contentText(m.content)}`).join('\n');
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const ask = contentText(lastUser?.content ?? '');

  let reply = `收到：${ask.slice(0, 40)}`;
  if (ask.includes('暗号')) reply = all.includes('蓝鲸42') ? '蓝鲸42' : '不知道';
  else if (ask.includes('多少')) reply = all.includes('42') ? '42' : '不知道';
  else if (ask.includes('记住')) reply = '好的，我记住了。';
  else if (ask.includes('自报家门')) reply = '我是探针模型。';

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const id = `chatcmpl_${Date.now()}`;
  const send = (delta, finish = null) => {
    res.write(`data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? 'echo',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`);
  };

  const chunks = ask.startsWith('SLOW')
    ? Array.from({ length: 40 }, (_, i) => `第${i + 1}段 `)
    : [reply];

  send({ role: 'assistant', content: '' });
  for (const piece of chunks) {
    if (res.writableEnded) return;
    send({ content: piece });
    if (ask.startsWith('SLOW')) await new Promise((r) => setTimeout(r, 220));
  }
  send({}, 'stop');
  res.write('data: [DONE]\n\n');
  res.end();
});

server.listen(9999, '127.0.0.1', () => console.log('fake llm on http://127.0.0.1:9999'));
