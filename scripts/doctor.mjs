#!/usr/bin/env node
/** PortPilot doctor: environment and service diagnostics. Safe to run anytime. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
let issues = 0;

function check(label, pass, detail = '') {
  console.log(`  ${pass ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) issues += 1;
}

function info(label, detail) {
  console.log(`  • ${label}${detail ? ` — ${detail}` : ''}`);
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

function httpGet(url, timeout = 3000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ ok: (res.statusCode ?? 500) < 500, status: res.statusCode, body }));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
}

async function main() {
  console.log('==========================================================');
  console.log(' PortPilot doctor');
  console.log('==========================================================\n');

  console.log('Runtime');
  const major = Number(process.versions.node.split('.')[0]);
  check('Node.js >= 22', major >= 22, process.version);
  info('Platform', `${os.platform()} ${os.release()} (${os.arch()})`);
  const git = spawnSync('git', ['--version'], { encoding: 'utf8', shell: isWin });
  check('Git available', git.status === 0, (git.stdout ?? git.stderr ?? '').trim());

  // Prove credentials reach the remote on THIS machine. This is the check that
  // used to be "looks fine on Linux, unverified on Windows": it now runs the
  // real credential path against a throwaway auth-demanding remote.
  if (git.status === 0 && fs.existsSync(path.join(root, 'packages/github/dist/credentials.js'))) {
    try {
      const { verifyGitCredentialTransport } = await import(
        path.join(root, 'packages/github/dist/credentials.js')
      );
      const res = await verifyGitCredentialTransport();
      check('Git credential delivery', res.ok, res.ok ? `token reached the remote via ${res.strategy}` : res.detail);
    } catch (err) {
      check('Git credential delivery', false, String(err && err.message ? err.message : err));
    }
  }

  console.log('\nFiles & data');
  check('node_modules present', fs.existsSync(path.join(root, 'node_modules')));
  check('Server build present', fs.existsSync(path.join(root, 'apps/api/dist/index.js')), 'run "npm run build" if missing');
  check('Dashboard build present', fs.existsSync(path.join(root, 'apps/dashboard/dist/index.html')), 'run "npm run build" if missing');
  check('Database present', fs.existsSync(path.join(root, 'data/portpilot.db')), 'run "npm run setup" to initialize');
  check('Secret key present', fs.existsSync(path.join(root, 'data/secret.key')));
  check('.env present (optional)', fs.existsSync(path.join(root, '.env')), 'copy .env.example to .env');

  console.log('\nServices (if running)');
  const apiPort = Number(process.env.PORT ?? 4300);
  const proxyPort = Number(process.env.PROXY_PORT ?? 8080);
  const apiHealth = await httpGet(`http://127.0.0.1:${apiPort}/api/system/health`);
  check('API responding', apiHealth.ok, apiHealth.ok ? `port ${apiPort}` : `not reachable on ${apiPort} (${apiHealth.error ?? apiHealth.status}) — start with "npm start"`);
  const proxyProbe = await httpGet(`http://127.0.0.1:${proxyPort}/`);
  info('Reverse proxy', proxyProbe.ok ? `responding on ${proxyPort} (404 page = healthy proxy)` : `not reachable on ${proxyPort}`);
  info('API port free check', (await portFree(apiPort)) ? 'free' : 'in use');
  info('Proxy port free check', (await portFree(proxyPort)) ? 'free' : 'in use');

  console.log('\nNetwork');
  const nets = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(nets)) {
    for (const a of addrs ?? []) {
      if (!a.internal && String(a.family) === 'IPv4') info(`LAN address ${name}`, a.address);
    }
  }
  info('*.localhost hostnames', 'resolvable to loopback by Windows 10+/Linux/macOS without DNS (RFC 6761)');
  info('Public access', 'optional — run the Network & Public Access page for full diagnostics');

  console.log('\nSecurity posture');
  const envHost = process.env.HOST ?? '127.0.0.1';
  check('API binds to loopback by default', envHost === '127.0.0.1' || envHost === '::1', `HOST=${envHost}`);
  check('Session token exists', fs.existsSync(path.join(root, 'data/.session-token')) || Boolean(process.env.PORTPILOT_AUTH_TOKEN));
  info('Build scripts', 'run with your user account — repositories are untrusted code (docs/security.md)');

  console.log('\n==========================================================');
  console.log(issues === 0 ? ' All checks passed.' : ` ${issues} issue(s) found.`);
  console.log('==========================================================');
  process.exitCode = issues > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('Doctor failed:', err);
  process.exit(1);
});
