import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import type { PortPilotDb } from '@portpilot/database';
import { redactSecrets, type Logger } from '@portpilot/shared';

export interface ProxyOptions {
  port: number;
  host?: string;
  db: PortPilotDb;
  logger?: Logger;
  /** Optional fallback target for the dashboard (API server), routed by Host header `portpilot.localhost` etc. */
  dashboardPort?: number | null;
}

export interface ProxyRouteInfo {
  hostname: string;
  targetPort: number | null;
  projectId: string | null;
}

/**
 * Hostname-based reverse proxy.
 *
 * Routes requests using the HTTP Host header against hostname->port mappings
 * stored in SQLite. Only explicitly registered hostnames are routable; any
 * other Host receives 404. This prevents the proxy from being used as an open
 * proxy (no absolute-URI forwarding, no arbitrary destinations).
 */
export class ReverseProxy {
  private server: http.Server | null = null;
  private readonly opts: Required<Pick<ProxyOptions, 'port' | 'host'>> & ProxyOptions;

  constructor(opts: ProxyOptions) {
    this.opts = { host: '127.0.0.1', ...opts };
  }

  resolveRoute(hostHeader: string | undefined): ProxyRouteInfo | null {
    if (!hostHeader) return null;
    const hostname = hostHeader.split(':')[0].toLowerCase();
    const rec = this.opts.db.getHostnameByName(hostname);
    if (!rec) return null;
    return { hostname, targetPort: rec.targetPort, projectId: rec.projectId };
  }

  private notFoundPage(host: string): string {
    const routes = this.opts.db.listHostnames();
    const rows = routes
      .map(
        (r) =>
          `<tr><td><a href="http://${escapeHtml(r.hostname)}:${this.opts.port}">${escapeHtml(r.hostname)}</a></td><td>${
            r.targetPort ? `127.0.0.1:${r.targetPort}` : 'not deployed yet'
          }</td><td>${escapeHtml(r.projectId ?? '—')}</td></tr>`,
      )
      .join('');
    return `<!doctype html><html><head><meta charset="utf-8"><title>PortPilot Proxy</title>
<style>body{font-family:Segoe UI,system-ui,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;padding:2.5rem}
h1{font-size:1.4rem}p{color:#94a3b8}table{border-collapse:collapse;margin-top:1rem;min-width:32rem}
td,th{border:1px solid #334155;padding:.5rem .75rem;text-align:left}a{color:#38bdf8}</style></head>
<body><h1>No route for <code>${escapeHtml(host)}</code></h1>
<p>The PortPilot reverse proxy only forwards requests for registered hostnames.
Registered routes (${routes.length}):</p>
<table><tr><th>Hostname</th><th>Target</th><th>Project</th></tr>${rows}</table>
<p>Open a registered hostname such as <a href="http://${
      routes[0]?.hostname ?? 'my-site.localhost'
    }:${this.opts.port}">http://${escapeHtml(routes[0]?.hostname ?? 'my-site.localhost')}:${this.opts.port}</a>.</p>
</body></html>`;
  }

  async listen(): Promise<number> {
    return await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket as Duplex, head));
      server.once('error', reject);
      server.listen(this.opts.port, this.opts.host, () => {
        this.server = server;
        this.opts.logger?.info(`Reverse proxy listening on ${this.opts.host}:${(server.address() as AddressInfo).port}`);
        resolve((server.address() as AddressInfo).port);
      });
    });
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const host = req.headers.host ?? '';
    // Reject absolute-form request targets (open-proxy style) and CONNECT.
    if (req.url?.startsWith('http://') || req.url?.startsWith('https://')) {
      res.writeHead(400).end('Absolute request URIs are not supported.');
      return;
    }
    const route = this.resolveRoute(host);
    if (!route || !route.targetPort) {
      const body = this.notFoundPage(host.split(':')[0]);
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) }).end(body);
      return;
    }
    this.proxyTo(req, res, route);
  }

  private proxyTo(req: http.IncomingMessage, res: http.ServerResponse, route: ProxyRouteInfo): void {
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    headers['x-forwarded-host'] = req.headers.host ?? '';
    headers['x-forwarded-proto'] = 'http';
    headers['x-forwarded-port'] = String(this.opts.port);
    headers['x-portpilot-route'] = route.hostname;
    // Prevent request smuggling / hop-by-hop confusion.
    delete headers['connection'];
    delete headers['keep-alive'];
    delete headers['proxy-authorization'];
    delete headers['te'];
    delete headers['trailer'];
    delete headers['upgrade'];

    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: route.targetPort,
        path: req.url,
        method: req.method,
        headers,
        timeout: 30_000,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers as http.OutgoingHttpHeaders);
        upRes.pipe(res);
      },
    );
    upstream.on('timeout', () => {
      upstream.destroy();
      if (!res.headersSent) res.writeHead(504).end('Upstream timeout');
    });
    upstream.on('error', (err) => {
      this.opts.logger?.warn(`proxy error for ${route.hostname} -> 127.0.0.1:${route.targetPort}: ${redactSecrets(String(err.message))}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end(`Upstream unavailable: ${route.hostname}`);
    });
    req.pipe(upstream);
  }

  /** WebSocket upgrade passthrough, routed by the same Host table. */
  private handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const route = this.resolveRoute(req.headers.host);
    if (!route || !route.targetPort) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const upstream = net.connect(route.targetPort, '127.0.0.1', () => {
      const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`];
      for (const [k, v] of Object.entries(req.headers)) {
        if (Array.isArray(v)) for (const item of v) lines.push(`${k}: ${item}`);
        else if (v != null) lines.push(`${k}: ${v}`);
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
