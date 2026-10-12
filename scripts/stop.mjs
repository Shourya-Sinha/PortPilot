#!/usr/bin/env node
/** Stop a background PortPilot process started via scripts/start.ps1. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pidFile = path.join(root, 'data', 'portpilot.pid');
const isWin = process.platform === 'win32';

if (!fs.existsSync(pidFile)) {
  console.log('[stop] No pid file found — PortPilot does not appear to be running in the background.');
  process.exit(0);
}
const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
if (!Number.isInteger(pid) || pid <= 0) {
  console.log('[stop] Invalid pid file — removing.');
  fs.unlinkSync(pidFile);
  process.exit(0);
}

try {
  process.kill(pid, 0);
} catch {
  console.log(`[stop] Process ${pid} is not running — cleaning up.`);
  fs.unlinkSync(pidFile);
  process.exit(0);
}

console.log(`[stop] Stopping PortPilot (pid ${pid})...`);
try {
  if (isWin) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  } else {
    process.kill(pid, 'SIGTERM');
  }
  console.log('[stop] Stopped.');
} catch (err) {
  console.error('[stop] Failed to stop process:', err.message);
  process.exitCode = 1;
}
try {
  fs.unlinkSync(pidFile);
} catch {
  /* ignore */
}
