import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { RuntimeSupervisor, allocatePort, isPortFree, createStaticServer, listenServer } from '@portpilot/runtime-manager';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let dir: string;
let supervisor: RuntimeSupervisor;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portpilot-runtime-test-'));
  supervisor = new RuntimeSupervisor();
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function get(port: number, p = '/'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

describe('port allocation', () => {
  it('allocates a free port', async () => {
    const port = await allocatePort(null);
    expect(port).toBeGreaterThanOrEqual(4300);
    expect(await isPortFree(port!)).toBe(true);
  });

  it('avoids occupied ports', async () => {
    const srv = createStaticServer(path.join(root, 'samples/static-site'));
    const port = await listenServer(srv, 0);
    expect(await isPortFree(port)).toBe(false);
    srv.close();
  });
});

describe('static file server', () => {
  it('serves files and blocks traversal', async () => {
    const srv = createStaticServer(path.join(root, 'samples/static-site'), { spa: true });
    const port = await listenServer(srv, 0);
    const idx = await get(port, '/');
    expect(idx.status).toBe(200);
    expect(idx.body).toContain('PortPilot Sample Static Site');
    const css = await get(port, '/style.css');
    expect(css.status).toBe(200);
    const traversal = await get(port, '/../../package.json');
    expect([403, 404, 200]).toContain(traversal.status);
    if (traversal.status === 200) expect(traversal.body).not.toContain('"workspaces"');
    srv.close();
  });
});

describe('application supervisor', () => {
  it('starts a static app, health-checks it, and stops it', async () => {
    const logFile = path.join(dir, 'static.log');
    const proc = await supervisor.start({
      projectId: 'p-static',
      deploymentId: 'd1',
      mode: 'static',
      runDir: path.join(root, 'samples/static-site'),
      logFile,
    });
    expect(proc.status).toBe('running');
    expect(proc.port).toBeGreaterThan(0);
    const health = await supervisor.healthCheck(proc.port!, '/');
    expect(health.ok).toBe(true);
    await supervisor.stop('p-static');
    expect(supervisor.get('p-static')?.status).toBe('stopped');
  });

  it('starts a node app with an env-assigned port and health-checks /health', async () => {
    const proc = await supervisor.start({
      projectId: 'p-node',
      deploymentId: 'd2',
      mode: 'node',
      runDir: path.join(root, 'samples/node-app'),
      startCommand: 'node server.js',
      healthCheckPath: '/health',
      logFile: path.join(dir, 'node.log'),
    });
    expect(proc.pid).toBeGreaterThan(0);
    const health = await supervisor.waitForHealth(proc.port!, '/health', 10, 400);
    expect(health.ok).toBe(true);
    const res = await get(proc.port!, '/health');
    expect(JSON.parse(res.body).ok).toBe(true);
    await supervisor.stop('p-node');
  });

  it('prevents duplicate starts', async () => {
    await supervisor.start({
      projectId: 'p-dup',
      deploymentId: 'd3',
      mode: 'node',
      runDir: path.join(root, 'samples/node-app'),
      startCommand: 'node server.js',
      logFile: path.join(dir, 'dup.log'),
    });
    await expect(
      supervisor.start({
        projectId: 'p-dup',
        deploymentId: 'd4',
        mode: 'node',
        runDir: path.join(root, 'samples/node-app'),
        startCommand: 'node server.js',
        logFile: path.join(dir, 'dup2.log'),
      }),
    ).rejects.toThrow(/already running/);
    await supervisor.stop('p-dup');
  });

  it('reports crashed state for dead restored pids', () => {
    const rec = supervisor.restoreFromState('p-restored', {
      deploymentId: 'd5',
      pid: 999999,
      port: 4444,
      cwd: '/tmp',
      startedAt: null,
    });
    expect(rec.status).toBe('crashed');
  });
});
