import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PortPilotDb } from '../packages/database/dist/index.js';
import { GitPoller } from '../apps/api/dist/poller.js';
import { isSpaFramework } from '../packages/build-engine/dist/index.js';
import type { Logger } from '@portpilot/shared';

/**
 * Regression tests for the audit findings:
 *  - a token saved through the dashboard must actually be used (BUG-1)
 *  - the git poller must queue a deploy when the branch head moves (LIMIT-3)
 *  - SPA fallback must be opt-in per framework (BUG-3)
 */

let tmp: string;
let db: PortPilotDb;
let repoDir: string;

const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; }, close() {} } as unknown as Logger;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portpilot-fixes-'));
  db = new PortPilotDb(path.join(tmp, 'test.db'), path.join(tmp, 'secret.key'));

  // A real local git repository so `git ls-remote` behaves exactly as it would
  // against GitHub.
  repoDir = path.join(tmp, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'index.html'), '<h1>v1</h1>');
  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-qm', 'first'], { cwd: repoDir });
});

afterAll(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('GitHub credential resolution', () => {
  it('uses the token stored through the dashboard for projects without their own ref', () => {
    db.putSecret('github_token', 'github_pat_DASHBOARD_TOKEN');
    db.setSetting('github_token_ref', 'github_token');
    // Project created via the UI has githubTokenRef = null; the saved token must
    // still be picked up, otherwise private repositories always fail.
    expect(db.resolveGithubToken(null)).toBe('github_pat_DASHBOARD_TOKEN');
    expect(db.githubTokenSource()).toBe('database');
  });

  it('prefers a project-specific token over the global one', () => {
    db.putSecret('project_token', 'github_pat_PROJECT_TOKEN');
    expect(db.resolveGithubToken('project_token')).toBe('github_pat_PROJECT_TOKEN');
  });

  it('falls back to the environment when nothing is stored', () => {
    db.deleteSecret('github_token');
    db.setSetting('github_token_ref', '');
    const previous = process.env.PORTPILOT_GITHUB_TOKEN;
    process.env.PORTPILOT_GITHUB_TOKEN = 'github_pat_ENV_TOKEN';
    try {
      expect(db.resolveGithubToken(null)).toBe('github_pat_ENV_TOKEN');
      expect(db.githubTokenSource()).toBe('env');
    } finally {
      if (previous === undefined) delete process.env.PORTPILOT_GITHUB_TOKEN;
      else process.env.PORTPILOT_GITHUB_TOKEN = previous;
    }
  });
});

describe('Git poller (auto-redeploy without inbound webhooks)', () => {
  it('queues a deployment only when the branch head moved', async () => {
    const project = db.createProject({
      name: 'poller-test',
      websiteName: 'poller-test',
      repoUrl: repoDir,
      branch: 'main',
      framework: 'static',
      deploymentMode: 'static',
      configConfirmed: true,
    });
    const dep = db.createDeployment(project.id);
    db.updateDeployment(dep.id, { status: 'succeeded', commitSha: 'a'.repeat(40) });
    db.updateProject(project.id, { activeDeploymentId: dep.id });

    const enqueue = vi.fn();
    const ctx = { db, queue: { enqueue }, logger } as never;
    const poller = new GitPoller(ctx, 0);

    const first = await poller.tick();
    expect(first.redeployed).toContain(project.id);
    expect(enqueue).toHaveBeenCalledTimes(1);

    // The queued deployment now blocks a second enqueue for the same project.
    const second = await poller.tick();
    expect(second.redeployed).not.toContain(project.id);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the active deployment already has the current commit', async () => {
    const project = db.createProject({
      name: 'poller-current',
      websiteName: 'poller-current',
      repoUrl: repoDir,
      branch: 'main',
      framework: 'static',
      deploymentMode: 'static',
      configConfirmed: true,
    });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim();
    const dep = db.createDeployment(project.id);
    db.updateDeployment(dep.id, { status: 'succeeded', commitSha: head });
    db.updateProject(project.id, { activeDeploymentId: dep.id });

    const enqueue = vi.fn();
    const poller = new GitPoller({ db, queue: { enqueue }, logger } as never, 0);
    const res = await poller.tick();
    expect(res.redeployed).not.toContain(project.id);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('SPA fallback selection', () => {
  it('is enabled only for client-side rendered frameworks', () => {
    expect(isSpaFramework('react')).toBe(true);
    expect(isSpaFramework('vite')).toBe(true);
    expect(isSpaFramework('static')).toBe(false);
    expect(isSpaFramework('next')).toBe(false);
    expect(isSpaFramework('express')).toBe(false);
    expect(isSpaFramework(null)).toBe(false);
  });
});
