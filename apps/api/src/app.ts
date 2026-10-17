import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { AppError, isPathInside, redactSecrets } from '@portpilot/shared';
import { RateLimiter } from './auth.js';
import { registerCoreRoutes } from './routes-core.js';
import { registerProjectRoutes } from './routes-projects.js';
import { registerNetworkRoutes } from './routes-network.js';
import type { AppContext } from './context.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024, // 1 MiB
    requestTimeout: 120_000,
    connectionTimeout: 120_000,
    trustProxy: false,
  });

  // Security headers + basic request logging.
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('permissions-policy', 'geolocation=(), microphone=(), camera=()');
    if (req.url.startsWith('/api/')) {
      reply.header('cache-control', 'no-store');
      // API responses must never be framed (clickjacking).
      reply.header('x-frame-options', 'DENY');
    }
    return payload;
  });

  const apiLimiter = new RateLimiter(600, 60_000);
  const authLimiter = new RateLimiter(20, 60_000);
  app.addHook('onRequest', async (req, reply) => {
    const key = req.ip || 'unknown';
    if (req.url.startsWith('/api/auth/login')) {
      if (!authLimiter.check(key)) {
        return reply.code(429).send({ error: 'Too many login attempts. Try again in a minute.' });
      }
    } else if (req.url.startsWith('/api/')) {
      if (!apiLimiter.check(key)) {
        return reply.code(429).send({ error: 'Rate limit exceeded' });
      }
    }
  });

  // Global error handler: never leak stack traces or secrets.
  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: err.message, code: err.code, details: err.details });
    }
    const statusCode = err.statusCode ?? 500;
    if (statusCode >= 500) {
      ctx.logger.error(`Unhandled error on ${req.method} ${req.url}: ${redactSecrets(String(err.stack ?? err.message))}`);
      return reply.code(500).send({ error: 'Internal server error' });
    }
    return reply.code(statusCode).send({ error: redactSecrets(err.message) });
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    // SPA fallback below.
    return serveStatic(ctx.cfg.root, req.url, reply);
  });

  registerCoreRoutes(app, ctx);
  registerProjectRoutes(app, ctx);
  registerNetworkRoutes(app, ctx);

  // ---------- dashboard static files (production) ----------
  const dashboardDist = path.join(ctx.cfg.root, 'apps', 'dashboard', 'dist');
  app.get('/*', async (req, reply) => serveStatic(dashboardDist, req.url, reply));
  app.get('/', async (req, reply) => serveStatic(dashboardDist, '/', reply));

  return app;
}

function serveStatic(root: string, url: string, reply: { code: (n: number) => { send: (b: unknown) => unknown; header: (k: string, v: string) => unknown }; send?: unknown; raw?: unknown }): unknown {
  const res = reply as unknown as import('fastify').FastifyReply;
  if (!fs.existsSync(root)) {
    return res.code(404).type('text/plain').send('Dashboard not built. Run "npm run build" first, or use "npm run dev" for the Vite dev server.');
  }
  let rel = decodeURIComponent((url ?? '/').split('?')[0]);
  if (rel.endsWith('/')) rel += 'index.html';
  const filePath = path.resolve(root, '.' + rel);
  if (!isPathInside(path.resolve(root), filePath)) {
    return res.code(403).send('Forbidden');
  }
  let serve = filePath;
  if (!fs.existsSync(serve) || fs.statSync(serve).isDirectory()) {
    serve = path.join(root, 'index.html');
    if (!fs.existsSync(serve)) return res.code(404).send('Not found');
  }
  const ext = path.extname(serve).toLowerCase();
  res.header('content-type', MIME[ext] ?? 'application/octet-stream');
  if (ext === '.html') res.header('cache-control', 'no-cache');
  return res.send(fs.createReadStream(serve));
}
