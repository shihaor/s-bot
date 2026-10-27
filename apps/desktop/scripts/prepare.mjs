import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(__dirname, '..');
const repo = path.resolve(desktop, '../..');

console.log('[prepare] build web');
execSync('npm run build -w @sbot/web', { cwd: repo, stdio: 'inherit' });

console.log('[prepare] bundle server');
rmSync(path.join(desktop, 'server'), { recursive: true, force: true });
mkdirSync(path.join(desktop, 'server'), { recursive: true });
await esbuild.build({
  entryPoints: [path.join(repo, 'packages/server/src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: path.join(desktop, 'server/index.cjs'),
  external: ['node:*'],
  logLevel: 'info',
});

console.log('[prepare] copy web dist');
rmSync(path.join(desktop, 'web'), { recursive: true, force: true });
cpSync(path.join(repo, 'apps/web/dist'), path.join(desktop, 'web'), { recursive: true });

console.log('[prepare] done');
