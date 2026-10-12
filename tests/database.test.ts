import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PortPilotDb } from '@portpilot/database';

let dir: string;
let db: PortPilotDb;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portpilot-db-test-'));
  db = new PortPilotDb(path.join(dir, 'test.db'), path.join(dir, 'secret.key'));
});

afterAll(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('projects repository', () => {
  it('creates and reads a project', () => {
    const p = db.createProject({
      name: 'Test Site',
      websiteName: 'test-site',
      repoUrl: 'https://github.com/example/test-site.git',
      branch: 'main',
    });
    expect(p.id).toMatch(/^prj_/);
    expect(p.websiteName).toBe('test-site');
    expect(db.getProject(p.id)?.name).toBe('Test Site');
    expect(db.getProjectByWebsiteName('test-site')?.id).toBe(p.id);
  });

  it('enforces unique website names', () => {
    expect(() =>
      db.createProject({ name: 'Other', websiteName: 'test-site', repoUrl: 'https://github.com/a/b.git', branch: 'main' }),
    ).toThrow();
  });

  it('updates fields', () => {
    const p = db.getProjectByWebsiteName('test-site')!;
    const updated = db.updateProject(p.id, { branch: 'develop', configConfirmed: true });
    expect(updated?.branch).toBe('develop');
    expect(updated?.configConfirmed).toBe(true);
  });
});

describe('deployments repository', () => {
  it('tracks deployment lifecycle', () => {
    const p = db.getProjectByWebsiteName('test-site')!;
    const d = db.createDeployment(p.id);
    expect(d.status).toBe('queued');
    db.updateDeployment(d.id, { status: 'running', phase: 'build', startedAt: new Date().toISOString() });
    db.updateDeployment(d.id, { status: 'failed', phase: 'build', error: 'boom', finishedAt: new Date().toISOString(), durationMs: 1234 });
    const got = db.getDeployment(d.id)!;
    expect(got.status).toBe('failed');
    expect(got.error).toBe('boom');
    expect(got.durationMs).toBe(1234);
    expect(db.countDeploymentsByStatus('failed')).toBeGreaterThanOrEqual(1);
  });

  it('finds last successful deployment', () => {
    const p = db.getProjectByWebsiteName('test-site')!;
    const d = db.createDeployment(p.id);
    db.updateDeployment(d.id, { status: 'succeeded', finishedAt: new Date().toISOString() });
    expect(db.lastSuccessfulDeployment(p.id)?.id).toBe(d.id);
  });
});

describe('env vars (encrypted)', () => {
  it('stores values encrypted and returns masked values only', () => {
    const p = db.getProjectByWebsiteName('test-site')!;
    const ev = db.setEnvVar(p.id, 'API_KEY', 'super-secret-value');
    expect(ev.maskedValue).not.toContain('super-secret-value');
    expect(ev.maskedValue.startsWith('su')).toBe(true);
    // plaintext only via explicit getEnvPlain
    expect(db.getEnvPlain(p.id)['API_KEY']).toBe('super-secret-value');
    // ciphertext at rest
    const row = db.db.prepare('SELECT value_cipher FROM env_vars WHERE id = ?').get(ev.id) as { value_cipher: string };
    expect(row.value_cipher).not.toContain('super-secret-value');
  });
});

describe('secrets store', () => {
  it('round-trips a github token', () => {
    db.putSecret('github_token', 'ghp_testtokenvalue123456');
    expect(db.getSecret('github_token')).toBe('ghp_testtokenvalue123456');
    db.deleteSecret('github_token');
    expect(db.getSecret('github_token')).toBeNull();
  });
});

describe('hostnames, runtime, settings, activity', () => {
  it('manages hostname mappings', () => {
    const p = db.getProjectByWebsiteName('test-site')!;
    const h = db.createHostname({ projectId: p.id, hostname: 'test-site.localhost', targetPort: 4310 });
    expect(db.getHostnameByName('test-site.localhost')?.id).toBe(h.id);
    const updated = db.updateHostname(h.id, { targetPort: 4311, resolutionStatus: 'resolvable_local' });
    expect(updated?.targetPort).toBe(4311);
    expect(db.listHostnames(p.id).length).toBe(1);
    expect(db.deleteHostname(h.id)).toBe(true);
  });

  it('persists runtime state', () => {
    const p = db.getProjectByWebsiteName('test-site')!;
    db.setRuntime({ projectId: p.id, deploymentId: 'dep_x', status: 'running', pid: 4242, port: 4312, cwd: '/tmp' });
    expect(db.getRuntime(p.id)?.port).toBe(4312);
  });

  it('stores settings and activity', () => {
    db.setSetting('k', 'v1');
    db.setSetting('k', 'v2');
    expect(db.getSetting('k')).toBe('v2');
    const a = db.logActivity('test', 'hello');
    expect(db.listActivity(5)[0].id).toBe(a.id);
  });
});
