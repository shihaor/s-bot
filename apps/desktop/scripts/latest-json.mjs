import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 打包收尾：生成本次构建的 latest.json（客户端检查更新用）。
 * 放在安装包同目录，配合 S-BOT Setup <version>.exe 一起上传到 Artifactory。
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(__dirname, '..');
const repo = path.resolve(desktop, '../..');
const release = path.join(desktop, 'release');

const pkg = JSON.parse(readFileSync(path.join(desktop, 'package.json'), 'utf8'));
const version = String(pkg.version ?? '').trim();
if (!version) {
  console.error('[latest.json] 读不到版本号');
  process.exit(1);
}

const changelogPath = path.join(repo, 'CHANGELOG.md');
let notes = '';
if (existsSync(changelogPath)) {
  const md = readFileSync(changelogPath, 'utf8');
  // 取当前版本对应的那一节（## 0.2.13 ... 到下一个 ## 之前）
  const re = new RegExp(`^##\\s+v?${version.replace(/\./g, '\\.')}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'm');
  const m = md.match(re);
  notes = (m?.[1] ?? '').trim();
  if (!notes) {
    // 没写这一版就退化成取第一节，避免客户端显示空
    const first = md.match(/^##\s[^\n]*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m);
    notes = (first?.[1] ?? '').trim();
  }
}

const fileName = `S-BOT Setup ${version}.exe`;
const exePath = path.join(release, fileName);
if (!existsSync(exePath)) {
  console.error(`[latest.json] 找不到安装包：${exePath}`);
  process.exit(1);
}

const buffer = readFileSync(exePath);
const sha256 = createHash('sha256').update(buffer).digest('hex');

const base = (process.env.SBOT_UPDATE_BASE || 'http://10.201.1.19:80/artifactory/installer/sbot').replace(/\/+$/, '');
const manifest = {
  version,
  url: `${base}/S-BOT%20Setup%20${version}.exe`,
  notes,
  size: statSync(exePath).size,
  sha256,
  releasedAt: Date.now(),
};

const out = path.join(release, 'latest.json');
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`[latest.json] ${out}`);
console.log(`[latest.json] version=${version} size=${manifest.size} sha256=${sha256.slice(0, 12)}…`);
