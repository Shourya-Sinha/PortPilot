import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getPaths } from '@portpilot/shared';

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

/**
 * Sessions are persisted to <dataDir>/sessions.json so restarting PortPilot
 * (or letting autostart bring apps back up) does not log you out of the
 * dashboard. The file holds only random session ids and CSRF tokens, with the
 * same 12-hour expiry; it is written with mode 0600 and best-effort.
 */
function sessionsFile(): string | null {
  try {
    return path.join(getPaths().dataDir, 'sessions.json');
  } catch {
    return null;
  }
}

function loadSessions(): void {
  const file = sessionsFile();
  if (!file || !fs.existsSync(file)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Session>;
    const now = Date.now();
    for (const [sid, s] of Object.entries(raw)) {
      if (s && typeof s.csrf === 'string' && typeof s.expiresAt === 'number' && s.expiresAt > now) {
        sessions.set(sid, s);
      }
    }
  } catch {
    /* corrupt or unreadable: start clean */
  }
}

let saveTimer: NodeJS.Timeout | null = null;
function saveSessions(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const file = sessionsFile();
    if (!file) return;
    try {
      const now = Date.now();
      const plain: Record<string, Session> = {};
      for (const [sid, s] of sessions) {
        if (s.expiresAt > now) plain[sid] = s;
        else sessions.delete(sid);
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(plain), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      /* persistence is best-effort; in-memory sessions still work */
    }
  }, 250);
  saveTimer.unref?.();
}

loadSessions();

export function createSession(): { cookie: string; csrf: string } {
  const sid = crypto.randomBytes(32).toString('hex');
  const csrf = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, { csrf, expiresAt: Date.now() + SESSION_TTL_MS });
  saveSessions();
  return { cookie: sid, csrf };
}

export function destroySession(sid: string): void {
  sessions.delete(sid);
  saveSessions();
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
export function isTrustedOrigin(origin: string | undefined, host: string | undefined, forwardedHost?: string): boolean {
  if (!origin) return true; // same-origin non-browser or curl
  try {
    const o = new URL(origin);
    const hostname = o.hostname;
    if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1') return true;
    // Same-origin: the origin host must match the Host (or X-Forwarded-Host
    // when running behind a local/preview reverse proxy).
    if (host && o.host === host) return true;
    if (forwardedHost && o.host === forwardedHost.split(',')[0].trim()) return true;
    return false;
  } catch {
    return false;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function authGuard(req: FastifyRequest, reply: FastifyReply, authToken: string): boolean {
  const fwdHost = req.headers['x-forwarded-host'];
  if (!isTrustedOrigin(req.headers.origin as string | undefined, req.headers.host, Array.isArray(fwdHost) ? fwdHost[0] : (fwdHost as string | undefined))) {
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

/**
 * IMPORTANT: each cookie must be sent as its OWN `Set-Cookie` header.
 *
 * `Set-Cookie` is exempt from the usual comma-folding rule (RFC 6265bis §5.2,
 * fetch spec "set-cookie" handling): browsers do NOT split it on commas. Sending
 * `pp_session=...; Path=/, pp_csrf=...; Path=/` as one header makes the browser
 * store a single `pp_session` cookie and treat `pp_csrf` as an unknown attribute
 * of it — so `document.cookie` never contains `pp_csrf`, the dashboard sends an
 * empty `x-csrf-token`, and every POST/PATCH/DELETE fails with
 * `403 {"code":"csrf_failed"}`. Always pass an array, never a joined string.
 */
export function setSessionCookies(reply: FastifyReply, sid: string, csrf: string, secure: boolean): void {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const attrs = `Path=/; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  reply.header('set-cookie', [`pp_session=${sid}; HttpOnly; ${attrs}`, `pp_csrf=${csrf}; ${attrs}`]);
}

export function clearSessionCookies(reply: FastifyReply): void {
  reply.header('set-cookie', ['pp_session=; Path=/; HttpOnly; Max-Age=0', 'pp_csrf=; Path=/; Max-Age=0']);
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
