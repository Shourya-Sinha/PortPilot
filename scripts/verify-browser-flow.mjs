#!/usr/bin/env node
/**
 * Manual end-to-end check that mirrors what the dashboard does in a real browser:
 * login -> read the JS-visible cookie exactly like `document.cookie` does ->
 * call the GitHub + deploy APIs with the CSRF header the way api.ts builds it.
 *
 * Usage: node scripts/verify-browser-flow.mjs [repoUrl] [branch]
 * Requires the API to be running (npm start) and the token in data/.session-token.
 */
import fs from 'node:fs';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.PORTPILOT_BASE ?? 'http://127.0.0.1:4300';
const repoUrl = process.argv[2] ?? 'https://github.com/octocat/Spoon-Knife.git';
const branch = process.argv[3] ?? 'main';

const tokenFile = path.join(root, 'data', '.session-token');
const token = process.env.PORTPILOT_AUTH_TOKEN ?? fs.readFileSync(tokenFile, 'utf8').trim();

/** Minimal browser-like cookie store (domain/path ignored: single-origin localhost). */
const jar = new Map(); // name -> { value, httpOnly }
const docCookie = () => [...jar].filter(([, c]) => !c.httpOnly).map(([n, c]) => `${n}=${c.value}`).join('; ');
const cookieHeader = () => [...jar].map(([n, c]) => `${n}=${c.value}`).join('; ');

function storeSetCookie(headers) {
  // fetch exposes one entry per Set-Cookie header; a joined header would be ONE
  // entry and browsers would not split it — that is the bug this script guards.
  for (const raw of headers.getSetCookie()) {
    const [pair, ...attrs] = raw.split(';').map((s) => s.trim());
    const idx = pair.indexOf('=');
    if (idx < 1) continue;
    const name = pair.slice(0, idx);
    const value = pair.slice(idx + 1);
    const httpOnly = attrs.some((a) => a.toLowerCase() === 'httponly');
    const maxAge = attrs.find((a) => /^max-age=/i.test(a));
    if (maxAge && Number(maxAge.split('=')[1]) === 0) jar.delete(name);
    else jar.set(name, { value, httpOnly });
  }
}

async function call(method, urlPath, body) {
  const hasBody = body !== undefined;
  const res = await fetch(BASE + urlPath, {
    method,
    // Exactly api.ts: no content-type when there is no body, csrf on mutations.
    headers: {
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-csrf-token': readCsrf() } : {}),
      ...(jar.size ? { cookie: cookieHeader() } : {}),
    },
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  storeSetCookie(res.headers);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${urlPath} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

// --- the two sources api.ts uses, in priority order -------------------------
let memoryCsrf = '';
function readCsrf() {
  if (memoryCsrf) return memoryCsrf;
  const m = docCookie().match(/(?:^|;\s*)pp_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

const step = (n, msg) => console.log(`\n[${n}] ${msg}`);

step(1, 'Login with the printed access token');
const login = await call('POST', '/api/auth/login', { token });
memoryCsrf = login.csrf;
console.log(`    pp_session stored : ${jar.has('pp_session') ? 'yes (HttpOnly, not visible to JS)' : 'NO'}`);
console.log(`    pp_csrf stored    : ${jar.has('pp_csrf') ? 'yes' : 'NO'}`);
console.log(`    document.cookie   : ${docCookie() || '(empty)'}`);
console.log(`    csrf sent on writes: ${readCsrf().slice(0, 12)}…`);
if (!readCsrf()) {
  console.error('\nFAIL: no CSRF token available -> every mutation would 403 csrf_failed.');
  process.exit(1);
}

step(2, `Fetch branches from GitHub (${repoUrl})`);
const branches = await call('GET', `/api/github/branches?url=${encodeURIComponent(repoUrl)}`);
console.log(`    ${branches.branches?.length ?? 0} branches: ${(branches.branches ?? []).slice(0, 5).map((b) => b.name).join(', ')}`);

step(3, 'Create the project (mutation — previously 403 csrf_failed)');
const websiteName = `verify-${Date.now().toString(36)}`;
const created = await call('POST', '/api/projects', { name: websiteName, websiteName, repoUrl, branch });
const projectId = created.project.id;
console.log(`    created ${projectId} (${websiteName}.localhost)`);

step(4, 'Detect framework + confirm first deploy');
const detected = await call('POST', `/api/projects/${projectId}/detect`, {});
console.log(`    detected: ${detected.detected?.framework ?? 'unknown'} / ${detected.detected?.deploymentMode ?? '?'}`);
// The UI confirms by posting the reviewed detection back as `config` (CreateProject.tsx).
const deploy = await call('POST', `/api/projects/${projectId}/deploy`, { confirm: true, config: detected.detected ?? {} });
console.log(`    deploy response: ${deploy.deployment ? `queued ${deploy.deployment.id}` : JSON.stringify(deploy).slice(0, 160)}`);

step(5, 'Wait for the build to finish');
const deadline = Date.now() + 180_000;
let final;
for (;;) {
  const { deployments } = await call('GET', `/api/deployments?projectId=${projectId}&limit=1`);
  final = deployments?.[0];
  if (!final || !['queued', 'running'].includes(final.status) || Date.now() > deadline) break;
  process.stdout.write(`    ${final.status}…\r`);
  await new Promise((r) => setTimeout(r, 1500));
}
console.log(`    status=${final?.status} commit=${(final?.commitSha ?? '').slice(0, 8) || 'n/a'} url=http://${websiteName}.localhost:8080`);

if (final?.status === 'succeeded') {
  // Reverse-proxy check. node:http is used because fetch() silently strips the
  // forbidden `Host` header, which would make every request look like a miss.
  const { status, bytes } = await new Promise((resolve) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: Number(process.env.PROXY_PORT ?? 8080), path: '/', headers: { host: `${websiteName}.localhost` } },
      (res) => {
        let n = 0;
        res.on('data', (c) => (n += c.length));
        res.on('end', () => resolve({ status: res.statusCode, bytes: n }));
      },
    );
    req.on('error', () => resolve({ status: 'n/a', bytes: 0 }));
    req.end();
  });
  console.log(`    proxy served HTTP ${status}, ${bytes} bytes for http://${websiteName}.localhost:8080`);
}

step(6, 'Sign out (mutation with no body — previously 400)');
await call('POST', '/api/auth/logout');
const after = await fetch(`${BASE}/api/auth/me`, { headers: { cookie: cookieHeader() } });
console.log(`    /api/auth/me after logout -> HTTP ${after.status} (401 = session really destroyed)`);

console.log(`\nRESULT: ${final?.status === 'succeeded' ? 'PASS — login, GitHub fetch, deploy and sign-out all work end to end' : `INCOMPLETE — deploy ended as ${final?.status}`}`);
