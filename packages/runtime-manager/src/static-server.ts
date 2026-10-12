import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

/**
 * Minimal static file server used for static deployments. Binds to loopback.
 * Serves only files inside root (path traversal protected). SPA fallback to
 * index.html when enabled.
 */
export function createStaticServer(root: string, opts: { spa?: boolean } = {}): http.Server {
  const rootResolved = path.resolve(root);
  return http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let rel = decodeURIComponent(url.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const filePath = path.resolve(rootResolved, '.' + rel);
      if (!filePath.startsWith(rootResolved + path.sep) && filePath !== rootResolved) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      let servePath = filePath;
      if (!fs.existsSync(servePath) || fs.statSync(servePath).isDirectory()) {
        if (opts.spa) {
          servePath = path.join(rootResolved, 'index.html');
        } else if (fs.existsSync(path.join(filePath, 'index.html'))) {
          servePath = path.join(filePath, 'index.html');
        } else {
          res.writeHead(404, { 'content-type': 'text/plain' }).end('Not Found');
          return;
        }
      }
      const ext = path.extname(servePath).toLowerCase();
      const stat = fs.statSync(servePath);
      res.writeHead(200, {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'content-length': stat.size,
        'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      });
      fs.createReadStream(servePath).pipe(res);
    } catch {
      res.writeHead(500).end('Internal Server Error');
    }
  });
}

export function listenServer(server: http.Server, port: number, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address() as AddressInfo;
      resolve(addr.port);
    });
  });
}
