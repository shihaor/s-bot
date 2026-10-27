/**
 * 假 RAGFlow：验证知识库列表 / 检索 / 引用角标。跑法：node scripts/fake-ragflow.mjs
 */
import http from 'node:http';

const datasets = [
  { id: 'ds_zhjt', name: 'ZHJT', description: '集团制度与项目资料', document_count: 31, chunk_count: 2757 },
  { id: 'ds_gz', name: '贵州大数据', description: '贵州项目资料', document_count: 4, chunk_count: 146 },
];

const chunks = [
  {
    content: '首页改版的第一目标是让新用户在 30 秒内知道产品能做什么，其次才是视觉风格。建议首屏只保留一个主行动点。',
    document_keyword: '首页改版评审纪要.md',
    similarity: 0.842,
    dataset_id: 'ds_zhjt',
  },
  {
    content: '新用户在前 10 秒的退出率为 62%，主要原因是首屏没有明确的下一步。改版后以「首次有效点击率」作为验收指标。',
    document_keyword: '新用户行为分析-2026Q3.pdf',
    similarity: 0.791,
    dataset_id: 'ds_zhjt',
  },
  {
    content: '知识库数据源存在重复文档，需要按内容 hash 去重后再入向量库。',
    document_keyword: '知识库数据治理.md',
    similarity: 0.734,
    dataset_id: 'ds_gz',
  },
];

http
  .createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/api/v1/datasets')) {
      res.end(JSON.stringify({ code: 0, data: datasets }));
      return;
    }
    if (req.url?.startsWith('/api/v1/retrieval')) {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw); } catch { /* ignore */ }
        const ids = Array.isArray(body.dataset_ids) ? body.dataset_ids : [];
        const hit = chunks.filter((c) => !ids.length || ids.includes(c.dataset_id));
        res.end(JSON.stringify({ code: 0, data: { chunks: hit } }));
      });
      return;
    }
    res.statusCode = 404;
    res.end('{"code":404}');
  })
  .listen(9998, '127.0.0.1', () => console.log('fake ragflow on http://127.0.0.1:9998'));
