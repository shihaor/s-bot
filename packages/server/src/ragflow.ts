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
          page_size: 10,
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
