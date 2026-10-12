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

function csrfToken(): string {
  const m = document.cookie.match(/(?:^|;\s*)pp_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

export async function api<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; raw?: boolean } = {},
): Promise<T> {
  const method = opts.method ?? 'GET';
  const res = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(method !== 'GET' && method !== 'HEAD' ? { 'x-csrf-token': csrfToken() } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
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
  return api('/api/auth/login', { method: 'POST', body: { token } });
}

export async function me(): Promise<{ authenticated: boolean; csrf?: string }> {
  const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
  if (res.status === 401) return { authenticated: false };
  return res.json();
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
