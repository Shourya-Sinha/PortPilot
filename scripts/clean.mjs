#!/usr/bin/env node
/** Remove build output (never touches data/, workspaces/, artifacts/). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  'apps/api/dist',
  'apps/worker/dist',
  'apps/dashboard/dist',
  ...fs.existsSync(path.join(root, 'packages'))
    ? fs.readdirSync(path.join(root, 'packages')).map((p) => `packages/${p}/dist`)
    : [],
];
for (const t of targets) {
  const full = path.join(root, t);
  if (fs.existsSync(full)) {
    fs.rmSync(full, { recursive: true, force: true });
    console.log(`[clean] removed ${t}`);
  }
}
for (const f of fs.readdirSync(root)) {
  if (f.endsWith('.tsbuildinfo')) {
    fs.rmSync(path.join(root, f), { force: true });
    console.log(`[clean] removed ${f}`);
  }
}
console.log('[clean] done (runtime data preserved)');
