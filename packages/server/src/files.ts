import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * 文件中心：真人互传的文件落在本机，消息里只存一个 fileId。
 * 不把内容塞进消息 JSON —— 200MB 的包塞进去会把数据库和 P2P 请求一起拖垮。
 */
const dataDir = resolve(process.env.SBOT_DATA_DIR ?? dirname(process.env.SBOT_DB ?? './data/sbot.db'));
export const filesDir = join(dataDir, 'files');

/** 单文件上限 200MB */
export const MAX_FILE_BYTES = 200 * 1024 * 1024;

export interface FileMeta {
  id: string;
  name: string;
  size: number;
  mime: string;
  createdAt: number;
}

function ensureDir(): void {
  mkdirSync(filesDir, { recursive: true });
}

function blobPath(id: string): string {
  return join(filesDir, `${id}.bin`);
}

function metaPath(id: string): string {
  return join(filesDir, `${id}.json`);
}

function cleanName(name: string): string {
  return (name || 'file')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .trim()
    .slice(0, 180) || 'file';
}

export function getFileMeta(id: string): FileMeta | null {
  if (!/^f_[0-9a-f]{8,40}$/.test(id)) return null;
  try {
    const meta = JSON.parse(readFileSync(metaPath(id), 'utf8')) as FileMeta;
    if (!meta?.id) return null;
    if (!existsSync(blobPath(id))) return null;
    return meta;
  } catch {
    return null;
  }
}

export function fileBlobPath(id: string): string {
  return blobPath(id);
}

export function openFileStream(id: string) {
  return createReadStream(blobPath(id));
}

/* ---------- 写盘 ---------- */

async function writeStream(
  source: AsyncIterable<Uint8Array> | Readable,
  name: string,
  mime: string,
  limit = MAX_FILE_BYTES,
  onProgress?: (received: number, total: number) => void,
  total = 0,
): Promise<FileMeta> {
  ensureDir();
  const id = `f_${randomBytes(9).toString('hex')}`;
  const target = blobPath(id);
  const tmp = `${target}.part`;
  const out = createWriteStream(tmp);
  let size = 0;

  const readable = source instanceof Readable ? source : Readable.from(source as AsyncIterable<Uint8Array>);
  let over = false;
  readable.on('data', (chunk: Buffer | Uint8Array) => {
    size += chunk.length;
    if (size > limit && !over) {
      over = true;
      readable.destroy(new Error('文件超过 200MB 上限'));
      return;
    }
    if (onProgress) {
      try { onProgress(size, total); } catch { /* 进度回调不能影响传输 */ }
    }
  });

  try {
    await pipeline(readable as any, out);
    if (over) throw new Error('文件超过 200MB 上限');
    renameSync(tmp, target);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    try { unlinkSync(target); } catch { /* ignore */ }
    throw err;
  }

  const meta: FileMeta = {
    id,
    name: cleanName(name),
    size,
    mime: mime || 'application/octet-stream',
    createdAt: Date.now(),
  };
  writeFileSync(metaPath(id), JSON.stringify(meta), 'utf8');
  return meta;
}

/** 浏览器上传：直接把请求体当文件内容流过来 */
export async function saveUpload(body: ReadableStream<Uint8Array>, name: string, mime: string): Promise<FileMeta> {
  const stream = Readable.fromWeb(body as any);
  return writeStream(stream, name, mime);
}

/** 从远端 S-BOT 拉文件：一边收一边写，不占内存；onProgress 用于界面进度条 */
export async function saveFromResponse(
  res: Response,
  name: string,
  mime: string,
  onProgress?: (received: number, total: number) => void,
): Promise<FileMeta> {
  if (!res.body) throw new Error('对方返回空文件');
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_FILE_BYTES) throw new Error('文件超过 200MB 上限');
  const stream = Readable.fromWeb(res.body as any);
  return writeStream(
    stream,
    name,
    mime || res.headers.get('content-type') || 'application/octet-stream',
    MAX_FILE_BYTES,
    onProgress,
    declared,
  );
}

/** 本地已存在的文件信息（用于消息里补全大小） */
export function fileSize(id: string): number {
  try {
    return statSync(blobPath(id)).size;
  } catch {
    return 0;
  }
}
