#!/usr/bin/env node
/**
 * PortPilot setup: verifies prerequisites, initializes data + database,
 * builds all packages and the dashboard, and prints the dashboard URL.
 * Cross-platform (Windows PowerShell scripts wrap the same steps).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

function step(msg) {
  console.log(`\n[setup] ${msg}`);
}
function ok(msg) {
  console.log(`  ✓ ${msg}`);
}
function warn(msg) {
  console.log(`  ! ${msg}`);
}
function fail(msg) {
  console.error(`  ✗ ${msg}`);
  process.exitCode = 1;
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: isWin, ...opts });
  return res.status === 0;
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function main() {
  console.log('==========================================================');
  console.log(' PortPilot HomeDeploy Dashboard — setup');
  console.log('==========================================================');

  step('Checking Node.js version (>= 22 required)...');
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 22) ok(`Node.js ${process.version}`);
  else {
    fail(`Node.js ${process.version} is too old. Install Node.js 22 LTS or newer from https://nodejs.org`);
    return;
  }

  step('Checking Git availability...');
  const git = spawnSync('git', ['--version'], { encoding: 'utf8', shell: isWin });
  if (git.status === 0) ok(git.stdout.trim());
  else {
    fail('Git was not found on PATH. Install Git for Windows (https://git-scm.com/download/win) and re-run setup.');
    return;
  }

  step('Installing npm dependencies...');
  if (run('npm', ['install', '--no-audit', '--no-fund'])) ok('Dependencies installed');
  else {
    fail('npm install failed.');
    return;
  }

  step('Creating data directories...');
  for (const dir of ['data', 'workspaces', 'artifacts', 'logs', 'logs/deployments', 'logs/runtime']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    const keep = path.join(root, dir, '.gitkeep');
    if (!fs.existsSync(keep)) fs.writeFileSync(keep, '');
  }
  ok('data/, workspaces/, artifacts/, logs/ ready');

  step('Initializing SQLite database and schema...');
  const { PortPilotDb } = await import(path.join(root, 'packages/database/dist/db.js'));
  const { getPaths, ensureDirs } = await import(path.join(root, 'packages/shared/dist/paths.js'));
  const paths = getPaths();
  ensureDirs(paths);
  const db = new PortPilotDb(paths.dbFile, paths.secretKeyFile);
  db.setSetting('setup_completed_at', new Date().toISOString());
  db.close();
  ok(`Database ready at ${path.relative(root, paths.dbFile)}`);

  step('Building packages (TypeScript)...');
  if (run('npx', ['tsc', '-b', 'tsconfig.build.json'])) ok('Server packages compiled');
  else {
    fail('TypeScript build failed.');
    return;
  }

  step('Building dashboard (React + Vite)...');
  if (run('npm', ['run', 'build', '--workspace', '@portpilot/dashboard'])) ok('Dashboard built');
  else {
    fail('Dashboard build failed.');
    return;
  }

  step('Verifying ports...');
  const apiPort = Number(process.env.PORT ?? 4300);
  const proxyPort = Number(process.env.PROXY_PORT ?? 8080);
  for (const [label, port] of [['API', apiPort], ['proxy', proxyPort]]) {
    if (await portFree(port)) ok(`Port ${port} (${label}) is available`);
    else warn(`Port ${port} (${label}) is already in use — change PORT/PROXY_PORT in .env if needed.`);
  }

  step('Safe initial configuration...');
  if (!fs.existsSync(path.join(root, '.env'))) {
    fs.copyFileSync(path.join(root, '.env.example'), path.join(root, '.env'));
    ok('.env created from .env.example (edit to customize)');
  } else ok('.env already exists — left untouched');

  console.log('\n==========================================================');
  console.log(' Setup complete.');
  console.log('==========================================================');
  console.log('');
  console.log(' Start the platform:      npm run dev      (dev)  or  npm start');
  console.log(' Run diagnostics:         npm run doctor');
  console.log(' Run tests:               npm test');
  console.log(` Dashboard URL:           http://127.0.0.1:${apiPort}/  (sign in with the token printed at startup)`);
  console.log(` Reverse proxy:           http://<website-name>.localhost:${proxyPort}`);
  console.log('');
  console.log(' Optional features not configured yet:');
  console.log('  - GitHub token for private repos (GitHub Integration page or PORTPILOT_GITHUB_TOKEN)');
  console.log('  - Local DNS module (set DNS_ENABLED=true in .env)');
  console.log('  - Public access (see Network & Public Access page; never required)');
  console.log('');
  console.log(' Notes:');
  console.log('  - No administrator privileges are required for the default setup.');
  console.log('  - Elevated rights are only needed if you choose DNS port 53 or install the startup service.');
}

main().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});
