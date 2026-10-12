import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { appEvents, getPaths, nowIso, type OverviewStats } from '@portpilot/shared';
import { isPidAlive } from '@portpilot/runtime-manager';
import { clearSessionCookies, createSession, destroySession, getSession, getSessionId, setSessionCookies, authGuard } from './auth.js';
import type { AppContext } from './context.js';

export function registerCoreRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { cfg, db, supervisor } = ctx;

  // ---------- auth ----------
  app.post('/api/auth/login', async (req, reply) => {
    const body = (req.body ?? {}) as { token?: string };
    const provided = typeof body.token === 'string' ? body.token.trim() : '';
    const providedQuery = typeof (req.query as { token?: string })?.token === 'string' ? String((req.query as { token?: string }).token) : '';
    const token = provided || providedQuery;
    if (!token || token.length < 16) {
      return reply.code(401).send({ error: 'Invalid access token' });
    }
    const a = Buffer.from(token);
    const b = Buffer.from(cfg.authToken);
    const ok = a.length === b.length && (await import('node:crypto')).timingSafeEqual(a, b);
    if (!ok) {
      ctx.logger.warn(`Failed login attempt from ${req.ip}`);
      return reply.code(401).send({ error: 'Invalid access token' });
    }
    const s = createSession();
    setSessionCookies(reply, s.cookie, s.csrf, false);
    return { ok: true, csrf: s.csrf };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const sid = getSessionId(req);
    if (sid) destroySession(sid);
    clearSessionCookies(reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req, reply) => {
    const session = getSession(req);
    if (!session) return reply.code(401).send({ authenticated: false });
    return { authenticated: true, csrf: session.csrf };
  });

  // Auth guard for everything below /api except login/webhooks.
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    if (req.url.startsWith('/api/auth/login')) return;
    if (req.url.startsWith('/api/webhooks/')) return; // verified by HMAC signature instead
    if (!authGuard(req, reply, cfg.authToken)) {
      return reply; // already sent
    }
  });

  // ---------- overview ----------
  app.get('/api/overview', async () => {
    const projects = db.listProjects();
    let runningApps = 0;
    for (const p of projects) {
      const rt = db.getRuntime(p.id);
      if (rt && (rt.status === 'running' || (rt.pid != null && isPidAlive(rt.pid)))) runningApps += 1;
    }
    const cpus = os.cpus();
    const load = os.loadavg()[0];
    const cpuPercent = cpus.length > 0 ? Math.min(100, Math.round((load / cpus.length) * 100)) : null;
    const totalMemMb = Math.round(os.totalmem() / 1024 / 1024);
    const freeMemMb = Math.round(os.freemem() / 1024 / 1024);

    const stats: OverviewStats = {
      projects: projects.length,
      runningApps,
      failedDeployments: db.countDeploymentsByStatus('failed'),
      successfulDeployments: db.countDeploymentsByStatus('succeeded'),
      currentBuilds: db.listDeployments({ status: 'running' }).length,
      queuedBuilds: db.listDeployments({ status: 'queued' }).length,
      cpuPercent,
      totalMemMb,
      freeMemMb,
      apiStatus: 'online',
      dnsStatus: ctx.dns ? (ctx.dns.running ? 'running' : 'stopped') : 'disabled',
      proxyStatus: ctx.proxyListening ? 'running' : 'stopped',
      publicAccessStatus: ctx.cachedPublicStatus(),
      uptimeSeconds: Math.round((Date.now() - ctx.startedAt) / 1000),
      nodeVersion: process.version,
      platform: `${os.platform()} ${os.release()}`,
    };
    return {
      stats,
      recentActivity: db.listActivity(12),
      recentDeployments: db.listDeployments({ limit: 8 }).map((d) => ({
        ...d,
        projectName: db.getProject(d.projectId)?.name ?? 'unknown',
      })),
    };
  });

  // ---------- system ----------
  app.get('/api/system/health', async () => ({
    ok: true,
    time: nowIso(),
    api: 'online',
    proxy: ctx.proxyListening ? 'running' : 'stopped',
    dns: ctx.dns ? (ctx.dns.running ? 'running' : 'stopped') : 'disabled',
    queue: ctx.queue.isBusy() ? 'busy' : 'idle',
    node: process.version,
    pid: process.pid,
  }));

  app.get('/api/system/logs', async (req) => {
    const name = String((req.query as { name?: string }).name ?? 'api').replace(/[^A-Za-z0-9._-]/g, '');
    const paths = getPaths();
    const files = fs.existsSync(paths.logsDir) ? fs.readdirSync(paths.logsDir).filter((f) => f.startsWith(name) && f.endsWith('.log')) : [];
    const latest = files.sort().pop();
    if (!latest) return { lines: [] };
    const content = fs.readFileSync(path.join(paths.logsDir, latest), 'utf8');
    return { file: latest, lines: content.split(/\r?\n/).slice(-200) };
  });

  // ---------- settings ----------
  app.get('/api/settings', async () => {
    return {
      settings: db.listSettings(),
      config: {
        host: cfg.host,
        port: cfg.port,
        proxyPort: cfg.proxyPort,
        dnsEnabled: cfg.dnsEnabled,
        dnsPort: cfg.dnsPort,
        dnsZone: cfg.dnsZone,
        isLoopback: cfg.isLoopback,
        node: process.version,
      },
    };
  });

  app.patch('/api/settings', async (req) => {
    const body = (req.body ?? {}) as Record<string, string>;
    for (const [k, v] of Object.entries(body)) {
      if (typeof v === 'string' && k.length <= 64) db.setSetting(k, v.slice(0, 4096));
    }
    return { settings: db.listSettings() };
  });

  // ---------- global SSE stream ----------
  app.get('/api/events', async (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    reply.raw.write('retry: 3000\n\n');

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onDeployLog = (p: unknown) => send('deployment:log', p);
    const onDeployStatus = (p: unknown) => send('deployment:status', p);
    const onRuntime = (p: unknown) => send('runtime:status', p);
    const onActivity = (p: unknown) => send('activity', p);
    appEvents.on('deployment:log', onDeployLog as never);
    appEvents.on('deployment:status', onDeployStatus as never);
    appEvents.on('runtime:status', onRuntime as never);
    appEvents.on('activity', onActivity as never);

    const ping = setInterval(() => {
      try {
        reply.raw.write(': ping\n\n');
      } catch {
        /* closed */
      }
    }, 20_000);

    req.raw.on('close', () => {
      clearInterval(ping);
      appEvents.off('deployment:log', onDeployLog as never);
      appEvents.off('deployment:status', onDeployStatus as never);
      appEvents.off('runtime:status', onRuntime as never);
      appEvents.off('activity', onActivity as never);
    });
    return reply;
  });
}
