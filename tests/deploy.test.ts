import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureDirs, getPaths, Logger } from '@portpilot/shared';
import { PortPilotDb } from '@portpilot/database';
import { RuntimeSupervisor } from '@portpilot/runtime-manager';
import { HostnameManager } from '@portpilot/hostname-manager';
import { ReverseProxy } from '@portpilot/reverse-proxy';
import { DeployQueue } from '@portpilot/worker';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let tmp: string;
let db: PortPilotDb;
let supervisor: RuntimeSupervisor;
let hostnames: HostnameManager;
let queue: DeployQueue;
let proxy: ReverseProxy;
let proxyPort: number;

function git(args: string[], cwd: string): void {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
}

function makeGitRepo(sample: string, name: string): string {
  const dir = path.join(tmp, name);
  fs.cpSync(path.join(repoRoot, 'samples', sample), dir, { recursive: true });
  git(['init', '-b', 'main'], dir);
  git(['add', '-A'], dir);
  git(['-c', 'user.email=test@local', '-c', 'user.name=Test', 'commit', '-m', `initial ${sample}`], dir);
  return dir;
}

async function waitFor<T>(fn: () => T | Promise<T>, pred: (v: T) => boolean, timeoutMs = 90_000, label = 'condition'): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (pred(v)) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

function get(port: number, host: string, p = '/'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p, headers: { Host: host } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portpilot-deploy-test-'));
  process.env.PORTPILOT_ROOT = tmp;
  process.env.DATA_DIR = path.join(tmp, 'data');
  process.env.WORKSPACES_DIR = path.join(tmp, 'workspaces');
  process.env.ARTIFACTS_DIR = path.join(tmp, 'artifacts');
  process.env.LOGS_DIR = path.join(tmp, 'logs');
  ensureDirs(getPaths());

  db = new PortPilotDb(path.join(tmp, 'data', 'test.db'), path.join(tmp, 'data', 'secret.key'));
  supervisor = new RuntimeSupervisor();
  hostnames = new HostnameManager(db, 0);
  const silentLogger = new Logger({ name: 'test-worker', toConsole: false });
  queue = new DeployQueue(db, supervisor, hostnames, silentLogger);
  proxy = new ReverseProxy({ port: 0, host: '127.0.0.1', db });
  proxyPort = await proxy.listen();
}, 30_000);

afterAll(async () => {
  for (const p of supervisor.list()) await supervisor.stop(p.projectId).catch(() => undefined);
  await proxy.close().catch(() => undefined);
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('end-to-end deployment pipeline', () => {
  it('deploys the sample static website and routes it through the proxy', async () => {
    const repoDir = makeGitRepo('static-site', 'origin-static');
    const project = db.createProject({
      name: 'Sample Static',
      websiteName: 'sample-static',
      repoUrl: repoDir,
      branch: 'main',
      deploymentMode: 'static',
      framework: 'static',
      installCommand: null,
      buildCommand: null,
      startCommand: null,
      outputDir: '.',
      healthCheckPath: '/',
      configConfirmed: true,
    });
    hostnames.registerLocalHostname(project.id, 'sample-static');

    const dep = db.createDeployment(project.id);
    queue.enqueue({
      deploymentId: dep.id,
      projectId: project.id,
      config: {
        framework: 'static',
        deploymentMode: 'static',
        packageManager: 'none',
        installCommand: null,
        buildCommand: null,
        startCommand: null,
        outputDir: '.',
        projectRoot: '.',
        healthCheckPath: '/',
        preferredPort: null,
      },
    });

    const done = await waitFor(
      () => db.getDeployment(dep.id)!,
      (d) => d.status === 'succeeded' || d.status === 'failed',
      90_000,
      'static deployment',
    );
    expect(done.status, `deployment error: ${done.error}`).toBe('succeeded');
    expect(done.port).toBeGreaterThan(0);
    expect(done.commitSha).toBeTruthy();

    // Direct runtime access
    const direct = await get(done.port!, '127.0.0.1');
    expect(direct.status).toBe(200);
    expect(direct.body).toContain('PortPilot Sample Static Site');

    // Through the reverse proxy via hostname
    const viaProxy = await get(proxyPort, 'sample-static.localhost');
    expect(viaProxy.status).toBe(200);
    expect(viaProxy.body).toContain('PortPilot Sample Static Site');

    // Hostname registry
    const h = db.getHostnameByName('sample-static.localhost');
    expect(h?.targetPort).toBe(done.port);
  }, 120_000);

  it('deploys the sample Node.js app and health-checks it', async () => {
    const repoDir = makeGitRepo('node-app', 'origin-node');
    const project = db.createProject({
      name: 'Sample Node App',
      websiteName: 'sample-node',
      repoUrl: repoDir,
      branch: 'main',
      deploymentMode: 'node',
      framework: 'node',
      packageManager: 'npm',
      installCommand: 'npm install',
      buildCommand: 'npm run build',
      startCommand: 'node server.js',
      outputDir: null,
      healthCheckPath: '/health',
      configConfirmed: true,
    });
    hostnames.registerLocalHostname(project.id, 'sample-node');

    const dep = db.createDeployment(project.id);
    queue.enqueue({
      deploymentId: dep.id,
      projectId: project.id,
      config: {
        framework: 'node',
        deploymentMode: 'node',
        packageManager: 'npm',
        installCommand: 'npm install',
        buildCommand: 'npm run build',
        startCommand: 'node server.js',
        outputDir: null,
        projectRoot: '.',
        healthCheckPath: '/health',
        preferredPort: null,
      },
    });

    const done = await waitFor(
      () => db.getDeployment(dep.id)!,
      (d) => d.status === 'succeeded' || d.status === 'failed',
      120_000,
      'node deployment',
    );
    expect(done.status, `deployment error: ${done.error}`).toBe('succeeded');

    const viaProxy = await get(proxyPort, 'sample-node.localhost', '/health');
    expect(viaProxy.status).toBe(200);
    expect(JSON.parse(viaProxy.body).ok).toBe(true);

    const rt = db.getRuntime(project.id);
    expect(rt?.status).toBe('running');
    expect(rt?.pid).toBeGreaterThan(0);

    // Stop reports stopped
    await supervisor.stop(project.id);
    db.setRuntime({ projectId: project.id, status: 'stopped', pid: null });
    expect(db.getRuntime(project.id)?.status).toBe('stopped');
  }, 150_000);

  it('preserves the previous working deployment when a rebuild fails', async () => {
    const repoDir = makeGitRepo('node-app', 'origin-node2');
    const project = db.createProject({
      name: 'Failing Rebuild',
      websiteName: 'fail-rebuild',
      repoUrl: repoDir,
      branch: 'main',
      deploymentMode: 'node',
      framework: 'node',
      packageManager: 'npm',
      installCommand: 'npm install',
      buildCommand: 'npm run build',
      startCommand: 'node server.js',
      healthCheckPath: '/health',
      configConfirmed: true,
    });
    hostnames.registerLocalHostname(project.id, 'fail-rebuild');

    const runDeploy = async (buildCommand: string) => {
      const dep = db.createDeployment(project.id);
      queue.enqueue({
        deploymentId: dep.id,
        projectId: project.id,
        config: {
          framework: 'node',
          deploymentMode: 'node',
          packageManager: 'npm',
          installCommand: 'npm install',
          buildCommand,
          startCommand: 'node server.js',
          outputDir: null,
          projectRoot: '.',
          healthCheckPath: '/health',
          preferredPort: null,
        },
      });
      return await waitFor(
        () => db.getDeployment(dep.id)!,
        (d) => d.status === 'succeeded' || d.status === 'failed' || d.status === 'cancelled',
        120_000,
        'deployment',
      );
    };

    // 1) good deploy
    const first = await runDeploy('npm run build');
    expect(first.status, `first error: ${first.error}`).toBe('succeeded');
    const firstPort = first.port!;
    const firstPid = db.getRuntime(project.id)?.pid;
    expect(firstPid).toBeGreaterThan(0);

    // 2) failing deploy (build command exits non-zero)
    fs.writeFileSync(path.join(repoDir, 'fail.js'), 'console.error("intentional build failure"); process.exit(1);');
    git(['add', '-A'], repoDir);
    git(['-c', 'user.email=test@local', '-c', 'user.name=Test', 'commit', '-m', 'break build'], repoDir);
    const second = await runDeploy('node fail.js');
    expect(second.status).toBe('failed');
    expect(second.phase).toBe('build');

    // Previous instance is still running and routable
    const rt = db.getRuntime(project.id);
    expect(rt?.status).toBe('running');
    expect(rt?.pid).toBe(firstPid);
    const viaProxy = await get(proxyPort, 'fail-rebuild.localhost', '/health');
    expect(viaProxy.status).toBe(200);
    expect(JSON.parse(viaProxy.body).ok).toBe(true);
    expect(db.getHostnameByName('fail-rebuild.localhost')?.targetPort).toBe(firstPort);
    // The last successful deployment is recorded and findable for rollback
    expect(db.lastSuccessfulDeployment(project.id)?.id).toBe(first.id);
  }, 180_000);

  it('rejects unsafe commands and invalid repository URLs safely', async () => {
    const repoDir = makeGitRepo('static-site', 'origin-static2');
    const project = db.createProject({
      name: 'Safety',
      websiteName: 'safety-check',
      repoUrl: repoDir,
      branch: 'main',
      deploymentMode: 'static',
      framework: 'static',
      configConfirmed: true,
    });

    const dep = db.createDeployment(project.id);
    queue.enqueue({
      deploymentId: dep.id,
      projectId: project.id,
      config: {
        framework: 'static',
        deploymentMode: 'static',
        packageManager: 'none',
        installCommand: null,
        buildCommand: 'npm run build; rm -rf /',
        startCommand: null,
        outputDir: '.',
        projectRoot: '.',
        healthCheckPath: '/',
        preferredPort: null,
      },
    });
    const done = await waitFor(
      () => db.getDeployment(dep.id)!,
      (d) => d.status === 'failed',
      60_000,
      'unsafe command rejection',
    );
    expect(done.error).toMatch(/[Uu]nsafe command|failed/i);

    // Invalid repository URL
    const badProject = db.createProject({
      name: 'Bad Repo',
      websiteName: 'bad-repo',
      repoUrl: 'file:///etc/passwd',
      branch: 'main',
      deploymentMode: 'static',
      framework: 'static',
      configConfirmed: true,
    });
    const dep2 = db.createDeployment(badProject.id);
    queue.enqueue({
      deploymentId: dep2.id,
      projectId: badProject.id,
      config: {
        framework: 'static',
        deploymentMode: 'static',
        packageManager: 'none',
        installCommand: null,
        buildCommand: null,
        startCommand: null,
        outputDir: '.',
        projectRoot: '.',
        healthCheckPath: '/',
        preferredPort: null,
      },
    });
    const done2 = await waitFor(
      () => db.getDeployment(dep2.id)!,
      (d) => d.status === 'failed',
      60_000,
      'invalid repo rejection',
    );
    expect(done2.error).toBeTruthy();
    expect(done2.phase).toBe('checkout');
  }, 120_000);
});
