import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Session auth for the dashboard.
 * - Login with the PortPilot access token -> HttpOnly session cookie.
 * - Mutating requests require a CSRF token (double-submit cookie pattern).
 * - When the API is on loopback, the session is still used so that a webpage
 *   in the user's browser cannot silently call the API cross-origin (DNS
 *   rebinding / CSRF protection).
 */

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

interface Session {
  csrf: string;
  expiresAt: number;
}

const sessions = new Map<string, Session>();

export function createSession(): { cookie: string; csrf: string } {
  const sid = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, { csrf, expiresAt: Date.now() + SESSION_TTL_MS });
  return { cookie: sid, csrf };
}

export function destroySession(sid: string): void {
  sessions.delete(sid);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function getSession(req: FastifyRequest): Session | null {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies['pp_session'];
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (s.expiresAt < Date.now()) {
    sessions.delete(sid);
    return null;
  }
  return s;
}

export function getSessionId(req: FastifyRequest): string | null {
  const cookies = parseCookies(req.headers.cookie);
  return cookies['pp_session'] ?? null;
}

/** True when the request origin is same-origin or a trusted local dev origin. */
export function isTrustedOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true; // same-origin non-browser or curl
  try {
    const o = new URL(origin);
    const hostname = o.hostname;
    if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1') return true;
    // LAN access: allow origins whose host matches the Host header.
    if (host && o.host === host) return true;
    return false;
  } catch {
    return false;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function authGuard(req: FastifyRequest, reply: FastifyReply, authToken: string): boolean {
  if (!isTrustedOrigin(req.headers.origin as string | undefined, req.headers.host)) {
    reply.code(403).send({ error: 'Origin not allowed' });
    return false;
  }
  const session = getSession(req);
  if (!session) {
    reply.code(401).send({ error: 'Authentication required', code: 'auth_required' });
    return false;
  }
  if (!SAFE_METHODS.has(req.method)) {
    const csrfHeader = req.headers['x-csrf-token'];
    if (typeof csrfHeader !== 'string' || csrfHeader !== session.csrf) {
      reply.code(403).send({ error: 'CSRF token missing or invalid', code: 'csrf_failed' });
      return false;
    }
  }
  return true;
}

export function setSessionCookies(reply: FastifyReply, sid: string, csrf: string, secure: boolean): void {
  reply.header(
    'set-cookie',
    [
      `pp_session=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`,
      `pp_csrf=${csrf}; Path=/; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`,
    ].join(', '),
  );
}

export function clearSessionCookies(reply: FastifyReply): void {
  reply.header('set-cookie', ['pp_session=; Path=/; HttpOnly; Max-Age=0', 'pp_csrf=; Path=/; Max-Age=0'].join(', '));
}

/**
 * In-memory sliding-window rate limiter (per client IP).
 */
export class RateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly limit: number, private readonly windowMs: number) {}

  check(key: string): boolean {
    const now = Date.now();
    const b = this.buckets.get(key);
    if (!b || b.resetAt < now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    b.count += 1;
    return b.count <= this.limit;
  }
}
