import { getSettings } from './repo.js';

export interface KbDataset {
  id: string;
  name: string;
  description: string;
  documentCount: number;
  chunkCount: number;
  enabled: boolean;
}

export interface Citation {
  n: number;
  kb: string;
  doc: string;
  score: number;
  text: string;
}

interface RfConfig {
  baseUrl: string;
  apiKey: string;
  enabled: string[];
}

export function ragflowConfig(): RfConfig {
  const s = getSettings();
  return {
    baseUrl: s.ragflowBaseUrl.replace(/\/+$/, ''),
    apiKey: s.ragflowApiKey,
    enabled: s.ragflowEnabledKbs,
  };
}

let datasetCache: { at: number; data: KbDataset[] } | null = null;
let lastError = '';

async function rf(path: string, init: RequestInit = {}, timeout = 6000): Promise<any> {
  const { baseUrl, apiKey } = ragflowConfig();
  if (!baseUrl) throw new Error('没有配置 RAGFlow 地址');
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`RAGFlow 返回了非 JSON（HTTP ${res.status}）`);
  }
  if (!res.ok) throw new Error(json?.message ?? `RAGFlow HTTP ${res.status}`);
  if (json?.code !== undefined && json.code !== 0) throw new Error(json?.message ?? `RAGFlow code ${json.code}`);
  return json;
}

export async function ragflowStatus(): Promise<{
  ok: boolean;
  configured: boolean;
  baseUrl: string;
  error?: string;
  datasets?: number;
}> {
  const { baseUrl, apiKey } = ragflowConfig();
  if (!apiKey) {
    return { ok: false, configured: false, baseUrl, error: '还没有填 RAGFlow API Key' };
  }
  try {
    const json = await rf('/api/v1/datasets?page=1&page_size=100', {}, 5000);
    const list = Array.isArray(json?.data) ? json.data : [];
    return { ok: true, configured: true, baseUrl, datasets: list.length };
  } catch (e) {
    lastError = String((e as Error).message ?? e);
    return { ok: false, configured: true, baseUrl, error: lastError };
  }
}

export async function listDatasets(force = false): Promise<KbDataset[]> {
  const now = Date.now();
  if (!force && datasetCache && now - datasetCache.at < 30000) {
    return withEnabled(datasetCache.data);
  }
  const json = await rf('/api/v1/datasets?page=1&page_size=100', {}, 8000);
  const list: any[] = Array.isArray(json?.data) ? json.data : [];
  const mapped: KbDataset[] = list.map((d) => ({
    id: String(d.id ?? d.dataset_id ?? ''),
    name: String(d.name ?? d.title ?? d.id ?? '未命名'),
    description: String(d.description ?? ''),
    documentCount: Number(d.document_count ?? d.doc_count ?? 0),
    chunkCount: Number(d.chunk_count ?? d.chunk_num ?? 0),
    enabled: false,
  })).filter((d) => d.id);
  datasetCache = { at: now, data: mapped };
  return withEnabled(mapped);
}

function withEnabled(list: KbDataset[]): KbDataset[] {
  const { enabled } = ragflowConfig();
  return list.map((d) => ({ ...d, enabled: enabled.includes(d.id) }));
}

/* ---------- 数据集文件管理 ---------- */

export interface RfDocument {
  id: string;
  name: string;
  size: number;
  /** RAGFlow run 状态：0 未解析 / 1 解析中 / 2 已取消 / 3 完成 / 4 失败 */
  status: number;
  progress: number;
  chunks: number;
  createdAt: number;
  error?: string;
}

function mapDocument(d: any): RfDocument {
  return {
    id: String(d?.id ?? ''),
    name: String(d?.name ?? d?.title ?? '未命名文档'),
    size: Number(d?.size ?? 0),
    status: Number(d?.run ?? d?.status ?? 0),
    progress: Number(d?.progress ?? 0),
    chunks: Number(d?.chunk_count ?? d?.chunk_num ?? 0),
    createdAt: Number(d?.create_time ?? d?.create_date ?? 0),
    error: d?.progress_msg ? String(d.progress_msg) : undefined,
  };
}

export async function listDocuments(datasetId: string): Promise<RfDocument[]> {
  const json = await rf(
    `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents?page=1&page_size=100&orderby=create_time&desc=true`,
    {},
    15000,
  );
  const docs: any[] = Array.isArray(json?.data?.docs)
    ? json.data.docs
    : Array.isArray(json?.data)
      ? json.data
      : [];
  return docs.map(mapDocument).filter((d: RfDocument) => d.id);
}

/** 上传文件（multipart），上传成功后立刻触发解析 */
export async function uploadDocuments(
  datasetId: string,
  files: Array<{ name: string; type?: string; buffer: Buffer }>,
): Promise<{ uploaded: RfDocument[]; parsed: number }> {
  const { baseUrl, apiKey } = ragflowConfig();
  const form = new FormData();
  for (const f of files) {
    form.append('file', new Blob([new Uint8Array(f.buffer)], { type: f.type || 'application/octet-stream' }), f.name);
  }
  const res = await fetch(`${baseUrl}/api/v1/datasets/${encodeURIComponent(datasetId)}/documents`, {
    method: 'POST',
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    body: form,
    signal: AbortSignal.timeout(300000),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`RAGFlow 返回了非 JSON（HTTP ${res.status}）`);
  }
  if (!res.ok) throw new Error(json?.message ?? `RAGFlow HTTP ${res.status}`);
  if (json?.code !== undefined && json.code !== 0) throw new Error(json?.message ?? `RAGFlow code ${json.code}`);

  const docs: RfDocument[] = (Array.isArray(json?.data) ? json.data : []).map(mapDocument).filter((d: RfDocument) => d.id);
  let parsed = 0;
  if (docs.length) {
    try {
      await parseDocuments(datasetId, docs.map((d) => d.id));
      parsed = docs.length;
    } catch (e) {
      // 上传成功但解析没触发：文件还在，用户可在列表里重试
      throw new Error(`文件已上传，但自动解析失败：${String((e as Error).message ?? e)}`);
    }
  }
  return { uploaded: docs, parsed };
}

/** 触发解析；兼容不同 RAGFlow 版本的接口 */
export async function parseDocuments(datasetId: string, ids: string[]): Promise<void> {
  const path = `/api/v1/datasets/${encodeURIComponent(datasetId)}`;
  const body = JSON.stringify({ document_ids: ids });
  try {
    await rf(`${path}/chunks`, { method: 'POST', body }, 120000);
    return;
  } catch (e) {
    await rf(`${path}/documents/parse`, { method: 'POST', body }, 120000);
  }
}

export async function deleteDocuments(datasetId: string, ids: string[]): Promise<void> {
  await rf(
    `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents`,
    { method: 'DELETE', body: JSON.stringify({ ids }) },
    30000,
  );
}

/* ---------- 文档分块（chunk） ---------- */

export interface RfChunk {
  id: string;
  content: string;
  keywords: string[];
  tokens: number;
  available: boolean;
}

export async function listChunks(datasetId: string, documentId: string): Promise<RfChunk[]> {
  const json = await rf(
    `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents/${encodeURIComponent(documentId)}/chunks?page=1&page_size=100`,
    {},
    20000,
  );
  const list: any[] = Array.isArray(json?.data?.chunks)
    ? json.data.chunks
    : Array.isArray(json?.data)
      ? json.data
      : [];
  return list
    .map((c) => ({
      id: String(c?.id ?? ''),
      content: String(c?.content ?? c?.content_with_weight ?? ''),
      keywords: Array.isArray(c?.important_keywords) ? c.important_keywords.map(String) : [],
      tokens: Number(c?.token_num ?? c?.token_count ?? 0),
      available: c?.available === undefined ? true : !!c.available,
    }))
    .filter((c) => c.id);
}

export async function updateChunk(
  datasetId: string,
  documentId: string,
  chunkId: string,
  input: { content: string; keywords?: string[]; available?: boolean },
): Promise<void> {
  const body: Record<string, unknown> = {
    content: input.content,
    important_keywords: input.keywords ?? [],
  };
  if (input.available !== undefined) body.available = input.available;
  await rf(
    `/api/v1/datasets/${encodeURIComponent(datasetId)}/documents/${encodeURIComponent(documentId)}/chunks/${encodeURIComponent(chunkId)}`,
    { method: 'PUT', body: JSON.stringify(body) },
    30000,
  );
}

/** 从 RAGFlow 取分块，按内容去重；失败/超时返回空数组，不影响发言 */
export async function retrieve(question: string, datasetIds: string[], timeout = 800): Promise<Citation[]> {
  const ids = datasetIds.filter(Boolean);
  if (!ids.length || !question.trim()) return [];
  const { apiKey } = ragflowConfig();
  if (!apiKey) return [];

  try {
    const json = await rf(
      '/api/v1/retrieval',
      {
        method: 'POST',
        body: JSON.stringify({
          question: question.slice(0, 500),
          dataset_ids: ids,
          top_k: 6,
          similarity_threshold: 0.2,
          page_size: 100,
        }),
      },
      timeout,
    );

    const chunks: any[] = Array.isArray(json?.data?.chunks) ? json.data.chunks : Array.isArray(json?.data) ? json.data : [];
    const names = new Map<string, string>();
    for (const d of datasetCache?.data ?? []) names.set(d.id, d.name);

    const seen = new Set<string>();
    const out: Citation[] = [];
    for (const c of chunks) {
      const text = String(c.content ?? c.text ?? '').trim();
      if (!text) continue;
      const key = text.replace(/\s+/g, ' ').slice(0, 200);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        n: out.length + 1,
        kb: names.get(String(c.dataset_id ?? '')) ?? String(c.dataset_name ?? '知识库'),
        doc: String(c.document_keyword ?? c.document_name ?? c.doc_name ?? '未命名文档'),
        score: Number(c.similarity ?? c.score ?? 0),
        text: text.slice(0, 1200),
      });
      if (out.length >= 4) break;
    }
    return out;
  } catch (e) {
    lastError = String((e as Error).message ?? e);
    return [];
  }
}

export function ragflowLastError(): string {
  return lastError;
}
