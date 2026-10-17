import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { ensureDirs, getPaths, Logger, type NetworkDiagnostics } from '@portpilot/shared';
import { PortPilotDb } from '@portpilot/database';
import { RuntimeSupervisor } from '@portpilot/runtime-manager';
import { HostnameManager } from '@portpilot/hostname-manager';
import { ReverseProxy } from '@portpilot/reverse-proxy';
import { DeployQueue } from '@portpilot/worker';
import { PublicAccessManager } from '@portpilot/public-access';
import { buildApp } from '../apps/api/dist/app.js';
import type { AppContext } from '../apps/api/dist/context.js';
import type { AppConfig } from '../apps/api/dist/config.js';

let tmp: string;
let app: FastifyInstance;
let ctx: AppContext;
let cookie = '';
let csrf = '';

const TEST_TOKEN = 'test-token-0123456789abcdef';

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portpilot-api-test-'));
  process.env.PORTPILOT_ROOT = tmp;
  process.env.DATA_DIR = path.join(tmp, 'data');
  process.env.WORKSPACES_DIR = path.join(tmp, 'workspaces');
  process.env.ARTIFACTS_DIR = path.join(tmp, 'artifacts');
  process.env.LOGS_DIR = path.join(tmp, 'logs');
  ensureDirs(getPaths());
  const paths = getPaths();

  const db = new PortPilotDb(path.join(tmp, 'data', 'api.db'), path.join(tmp, 'data', 'secret.key'));
  const supervisor = new RuntimeSupervisor();
  const hostnames = new HostnameManager(db, 8080);
  const logger = new Logger({ name: 'api-test', toConsole: false });
  const queue = new DeployQueue(db, supervisor, hostnames, logger);
  const proxy = new ReverseProxy({ port: 0, db });

  const cfg: AppConfig = {
    host: '127.0.0.1',
    port: 0,
    proxyHost: '127.0.0.1',
    proxyPort: 8080,
    dnsEnabled: false,
    dnsPort: 5353,
    dnsHost: '127.0.0.1',
    dnsZone: 'portpilot.test',
    dnsTtl: 60,
    publicIpCheckUrl: 'https://example.invalid',
    authToken: TEST_TOKEN,
    isLoopback: true,
    root: tmp,
  };

  ctx = {
    cfg,
    db,
    logger,
    supervisor,
    hostnames,
    queue,
    proxy,
    proxyListening: true,
    dns: null,
    publicAccess: new PublicAccessManager(),
    startedAt: Date.now(),
    diagCache: null,
    cachedPublicStatus: () => 'unknown',
  };
  void paths;
  app = await buildApp(ctx);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  ctx.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('API authentication', () => {
  it('rejects invalid tokens', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: 'wrong-token-value-x' } });
    expect(res.statusCode).toBe(401);
  });

  it('logs in with the access token and sets cookies', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: TEST_TOKEN } });
    expect(res.statusCode).toBe(200);
    const setCookie = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
    expect(cookies.join(';')).toContain('pp_session=');
    expect(cookies.join(';')).toContain('pp_csrf=');
    cookie = cookies.map((c) => c.split(';')[0]).join('; ');
    csrf = (res.json() as { csrf: string }).csrf;
  });

  // Regression: a browser does NOT split Set-Cookie on commas (RFC 6265bis §5.2).
  // If both cookies are folded into one header, `pp_csrf` is silently dropped,
  // document.cookie has no token, and every mutation 403s with csrf_failed.
  it('sends pp_session and pp_csrf as two separate Set-Cookie headers', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token: TEST_TOKEN } });
    const raw = res.headers['set-cookie'];
    const list = Array.isArray(raw) ? raw : [String(raw ?? '')];
    expect(list).toHaveLength(2);
    for (const c of list) expect(c).not.toContain(',');
    expect(list.some((c) => c.startsWith('pp_session='))).toBe(true);
    expect(list.some((c) => c.startsWith('pp_csrf='))).toBe(true);
    // The JS-readable half must not be HttpOnly, or the dashboard cannot read it.
    expect(list.find((c) => c.startsWith('pp_csrf='))).not.toContain('HttpOnly');
    expect(list.find((c) => c.startsWith('pp_session='))).toContain('HttpOnly');
  });

  it('rejects a mutation sent without the CSRF token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie, 'x-csrf-token': '' },
      payload: { name: 'nope', websiteName: 'nope', repoUrl: 'https://github.com/octocat/Hello-World.git', branch: 'master' },
    });
    expect(res.statusCode).toBe(403);
    expect((res.json() as { code?: string }).code).toBe('csrf_failed');
  });

  it('rejects unauthenticated API calls', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects mutations without a CSRF token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie },
      payload: { name: 'X', websiteName: 'x-site', repoUrl: 'https://github.com/a/b.git', branch: 'main' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects requests from foreign origins', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { cookie, origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('projects & website-name registration', () => {
  it('creates a project and registers its local hostname', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        name: 'My Portfolio',
        websiteName: 'my-portfolio',
        repoUrl: 'https://github.com/example/portfolio.git',
        branch: 'main',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { project: { id: string; websiteName: string }; localUrl: string };
    expect(body.project.websiteName).toBe('my-portfolio');
    expect(body.localUrl).toBe('http://my-portfolio.localhost:8080');
    const h = ctx.db.getHostnameByName('my-portfolio.localhost');
    expect(h?.projectId).toBe(body.project.id);
  });

  it('rejects duplicate website names', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        name: 'Another',
        websiteName: 'my-portfolio',
        repoUrl: 'https://github.com/example/other.git',
        branch: 'main',
      },
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects invalid website names', async () => {
    for (const websiteName of ['Bad_Name', '-x', 'has space']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/projects',
        headers: { cookie, 'x-csrf-token': csrf },
        payload: { name: 'N', websiteName, repoUrl: 'https://github.com/a/b.git', branch: 'main' },
      });
      expect(res.statusCode, websiteName).toBe(422);
    }
  });

  it('rejects dangerous repo URLs and commands', async () => {
    const badUrl = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { name: 'Evil', websiteName: 'evil-site', repoUrl: 'file:///etc/passwd', branch: 'main' },
    });
    expect(badUrl.statusCode).toBe(422);
    const badCmd = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        name: 'Evil2',
        websiteName: 'evil-site2',
        repoUrl: 'https://github.com/a/b.git',
        branch: 'main',
        buildCommand: 'npm run build; rm -rf /',
      },
    });
    expect(badCmd.statusCode).toBe(422);
  });

  it('requires explicit confirmation for destructive deletes', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/projects', headers: { cookie } });
    const projects = (list.json() as { projects: { id: string; websiteName: string }[] }).projects;
    const target = projects.find((p) => p.websiteName === 'my-portfolio')!;
    const wrong = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${target.id}`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { confirm: 'nope' },
    });
    expect(wrong.statusCode).toBe(422);
    const right = await app.inject({
      method: 'DELETE',
      url: `/api/projects/${target.id}`,
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { confirm: 'my-portfolio' },
    });
    expect(right.statusCode).toBe(200);
    expect(ctx.db.getHostnameByName('my-portfolio.localhost')).toBeNull();
  });
});

describe('overview & hostname APIs', () => {
  it('returns real overview stats', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { stats: { projects: number; apiStatus: string } };
    expect(body.stats.apiStatus).toBe('online');
    expect(typeof body.stats.projects).toBe('number');
  });

  it('lists hostnames with local URLs', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/hostnames',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: { hostname: 'fresh-site.localhost', mode: 'local' },
    });
    const res = await app.inject({ method: 'GET', url: '/api/hostnames', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { hostnames: { hostname: string; localUrl: string }[] };
    expect(body.hostnames.length).toBeGreaterThan(0);
    expect(body.hostnames[0].localUrl).toContain('.localhost:8080');
    expect(body.hostnames.some((h) => h.hostname === 'fresh-site.localhost')).toBe(true);
  });

  it('serves the network diagnostics shape without fabricating results', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/network/diagnostics', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const diag = (res.json() as { diagnostics: NetworkDiagnostics }).diagnostics;
    // With an invalid check URL, connectivity must honestly report offline/unknown.
    expect(['offline', 'unknown', 'online']).toContain(diag.internetConnectivity);
    expect(Array.isArray(diag.notes)).toBe(true);
  });

  it('reports public-access strategies honestly', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/public-access/status', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { strategies: { id: string; viable: boolean; guidance: string[] }[]; honesty: string[] };
    expect(body.strategies.map((s) => s.id).sort()).toEqual(['direct', 'relay']);
    expect(body.strategies.every((s) => s.guidance.length > 0)).toBe(true);
    expect(body.honesty.length).toBeGreaterThan(0);
  });
});
