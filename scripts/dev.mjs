import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const procs = [
  spawn(npm, ['run', 'dev', '-w', '@sbot/server'], { stdio: 'inherit', shell: process.platform === 'win32' }),
  spawn(npm, ['run', 'dev', '-w', '@sbot/web'], { stdio: 'inherit', shell: process.platform === 'win32' }),
];

let closing = false;
function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  for (const p of procs) {
    if (!p.killed) p.kill();
  }
  setTimeout(() => process.exit(code), 200);
}

for (const p of procs) {
  p.on('exit', (code) => {
    if (!closing && code !== 0) {
      console.error(`[dev] 子进程退出，code=${code}`);
      shutdown(code ?? 1);
    }
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
