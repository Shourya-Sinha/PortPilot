/** PortPilot API client — same-origin cookie sessions + CSRF double-submit. */

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;
  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * CSRF token handling (double-submit).
 *
 * Preferred source is the value the API returns in the login / `me` JSON body,
 * held in memory: it survives nothing across a reload, but it is NOT readable by
 * JavaScript running on another local port the way a `pp_csrf` cookie is
 * (cookies ignore ports, so a dev server on localhost:5173 can read a cookie set
 * by localhost:4300). The cookie is kept as a fallback for the case where the
 * page re-mounts without going through `me()`.
 */
let memoryCsrf = '';

export function setCsrfToken(token: string | null | undefined): void {
  memoryCsrf = typeof token === 'string' ? token : '';
}

function csrfToken(): string {
  if (memoryCsrf) return memoryCsrf;
  const m = document.cookie.match(/(?:^|;\s*)pp_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; raw?: boolean } = {},
): Promise<T> {
  const method = opts.method ?? 'GET';
  // Only declare a JSON body when we actually send one: Fastify rejects
  // `content-type: application/json` with an empty body (400
  // "Body cannot be empty when content-type is set to 'application/json'"),
  // which is what silently broke POST /api/auth/logout.
  const hasBody = opts.body !== undefined;
  const res = await fetch(path, {
    method,
    headers: {
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' && method !== 'HEAD' ? { 'x-csrf-token': csrfToken() } : {}),
    },
    body: hasBody ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401) {
    throw new ApiError('Not authenticated', 401, 'auth_required');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError((data as { error?: string }).error ?? `Request failed (${res.status})`, res.status, (data as { code?: string }).code, (data as { details?: unknown }).details);
  }
  return data as T;
}

export async function login(token: string): Promise<{ csrf: string }> {
  const res = await api<{ ok: boolean; csrf: string }>('/api/auth/login', { method: 'POST', body: { token } });
  setCsrfToken(res.csrf);
  return res;
}

export async function me(): Promise<{ authenticated: boolean; csrf?: string }> {
  const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
  if (res.status === 401) {
    setCsrfToken(null);
    return { authenticated: false };
  }
  const data = (await res.json()) as { authenticated: boolean; csrf?: string };
  setCsrfToken(data.csrf ?? null);
  return data;
}

export async function logout(): Promise<void> {
  await api('/api/auth/logout', { method: 'POST' });
  setCsrfToken(null);
}

export function sseUrl(path: string): string {
  return path;
}

/** Subscribe to an SSE endpoint with auto-reconnect. Returns unsubscribe. */
export function subscribeSse(
  path: string,
  handlers: Record<string, (data: unknown) => void>,
  onOpen?: () => void,
): () => void {
  const es = new EventSource(path);
  es.onopen = () => onOpen?.();
  for (const [event, handler] of Object.entries(handlers)) {
    es.addEventListener(event, (e) => {
      try {
        handler(JSON.parse((e as MessageEvent).data));
      } catch {
        /* ignore malformed */
      }
    });
  }
  return () => es.close();
}
