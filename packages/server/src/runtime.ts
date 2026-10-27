export interface ModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface StreamContext {
  agentName: string;
  agentRole: string;
  systemPrompt: string;
  skills: string[];
  history: { role: 'user' | 'assistant'; content: string }[];
  userText: string;
  modelConfig?: ModelConfig | null;
  references?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function* chunks(text: string): Generator<string> {
  let i = 0;
  while (i < text.length) {
    const n = 2 + Math.floor(Math.random() * 3);
    yield text.slice(i, i + n);
    i += n;
  }
}

const MOCK_REPLIES: Record<string, string[]> = {
  产品经理: [
    '我同意方向，但优先级要再收一下：这次只做「让新用户看懂」，个性化放到下个迭代。',
    '从用户视角看，第一屏必须回答三个问题：这是什么、对我有什么用、我下一步点哪。',
    '别急着加功能。先把退出率从 62% 降到 40%，再谈别的。',
  ],
  架构师: [
    '技术上有个前提：首页现在是整包渲染，要做分层加载得先拆路由，大概 3 天。',
    '我担心的不是做不出来，是以后每加一个模块都要动首页。建议先把模块边界定清楚。',
    '成本上，个性化推荐会引入一个实时接口。如果只是文案差异，用配置下发就够了。',
  ],
  评审员: [
    '我挑两个阻塞点：一是没有明确的成功指标，二是没定义回滚方案。',
    '这个方案里「30 秒内看懂」没法验收。建议改成可测的：首次有效点击率。',
    '先别急着排期。上次类似改动上线后 DAU 没变化，我们复盘过原因吗？',
  ],
  文案: [
    '我试着把它说人话：「三秒知道你该点哪儿」。比「提升认知效率」强。',
    '文案上建议别用「一站式」「赋能」这类词，用户看不懂。',
  ],
  数据分析: [
    '先问口径：62% 是「会话结束」还是「页面关闭」？这两个差很多。',
    '如果按新用户首日留存看，改版前后至少要跑两周才能排除波动。',
  ],
};

async function* mockStream(ctx: StreamContext): AsyncGenerator<string> {
  const pool = MOCK_REPLIES[ctx.agentRole] ?? [`我是${ctx.agentName}，${ctx.agentRole}。说说你的想法？`];
  const text = pool[Math.floor(Math.random() * pool.length)] ?? pool[0]!;
  await sleep(260 + Math.random() * 240);
  for (const ch of chunks(text)) {
    await sleep(14 + Math.random() * 22);
    yield ch;
  }
}

async function* llmStream(ctx: StreamContext, cfg: ModelConfig): AsyncGenerator<string> {
  const system = [
    ctx.systemPrompt,
    '',
    '你正在一个多人群聊里，成员包括用户和其他智能体。',
    '只代表你自己发言，不要替别人说话，也不要在回复开头加自己的名字。',
    '回答控制在 120 字以内，简短、具体。',
    ctx.references ? `\n以下是检索到的资料，用了就请在句末用 [1][2] 这样的角标标出来：\n${ctx.references}` : '',
  ].join('\n');

  const messages = [
    { role: 'system', content: system },
    ...ctx.history,
    { role: 'user', content: ctx.userText },
  ];

  const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, messages, stream: true, temperature: 0.7 }),
  });

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    throw new Error(`模型请求失败 ${res.status} ${body.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const json = JSON.parse(data);
        const delta = json?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) yield delta;
      } catch {
        // 忽略不完整分片
      }
    }
  }
}

export async function* generateReply(ctx: StreamContext, fallback: ModelConfig | null): AsyncGenerator<string> {
  const cfg = ctx.modelConfig ?? fallback;
  if (cfg && cfg.baseUrl.trim() && cfg.apiKey.trim()) {
    yield* llmStream(ctx, cfg);
    return;
  }
  yield* mockStream(ctx);
}
