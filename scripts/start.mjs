#!/usr/bin/env node
/** Start PortPilot in the foreground (API + reverse proxy + optional DNS). */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

if (!fs.existsSync(path.join(root, 'apps/api/dist/index.js'))) {
  console.log('[start] Build output missing — running build first...');
  let res = spawnSync('npx', ['tsc', '-b', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit', shell: isWin });
  if (res.status !== 0) process.exit(1);
}
if (!fs.existsSync(path.join(root, 'apps/dashboard/dist/index.html'))) {
  console.log('[start] Dashboard build missing — building...');
  const res = spawnSync('npm', ['run', 'build', '--workspace', '@portpilot/dashboard'], { cwd: root, stdio: 'inherit', shell: isWin });
  if (res.status !== 0) process.exit(1);
}

const res = spawnSync('node', ['apps/api/dist/index.js'], { cwd: root, stdio: 'inherit', shell: isWin });
process.exit(res.status ?? 0);
