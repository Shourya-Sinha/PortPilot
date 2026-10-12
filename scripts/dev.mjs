#!/usr/bin/env node
/**
 * Development mode: builds once, then runs the API and the Vite dev server
 * (with HMR) side by side. The dashboard proxies /api to the API process.
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

console.log('[dev] Building server packages...');
let res = spawnSync('npx', ['tsc', '-b', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit', shell: isWin });
if (res.status !== 0) process.exit(1);

if (!fs.existsSync(path.join(root, 'node_modules'))) {
  console.log('[dev] Installing dependencies first (npm install)...');
  res = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: root, stdio: 'inherit', shell: isWin });
  if (res.status !== 0) process.exit(1);
}

const children = [];
function start(name, cmd, args, cwd) {
  const child = spawn(cmd, args, { cwd, stdio: 'inherit', shell: isWin, env: { ...process.env, FORCE_COLOR: '1' } });
  child.on('exit', (code) => {
    console.log(`[dev] ${name} exited with code ${code}`);
    shutdown(code ?? 0);
  });
  children.push(child);
  return child;
}

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    try {
      if (isWin) spawnSync('taskkill', ['/pid', String(c.pid), '/T', '/F'], { shell: false });
      else process.kill(-c.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('[dev] Starting API on http://127.0.0.1:4300 ...');
start('api', 'node', ['apps/api/dist/index.js'], root);
console.log('[dev] Starting dashboard dev server on http://127.0.0.1:5173 ...');
start('dashboard', 'npm', ['run', 'dev', '--workspace', '@portpilot/dashboard'], root);
console.log('[dev] Open http://127.0.0.1:5173/ (login token is printed by the API process).');
