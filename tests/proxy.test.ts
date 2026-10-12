import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PortPilotDb } from '@portpilot/database';
import { ReverseProxy } from '@portpilot/reverse-proxy';

let dir: string;
let db: PortPilotDb;
let proxy: ReverseProxy;
let proxyPort: number;
let backendA: http.Server;
let backendB: http.Server;
let portA: number;
let portB: number;

function makeBackend(tag: string): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tag, host: req.headers.host, url: req.url, forwarded: req.headers['x-forwarded-proto'] }));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

function get(host: string, urlPath = '/'): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: proxyPort, path: urlPath, headers: { Host: host } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      })
      .on('error', reject);
  });
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portpilot-proxy-test-'));
  db = new PortPilotDb(path.join(dir, 'p.db'), path.join(dir, 'secret.key'));
  const a = await makeBackend('alpha');
  backendA = a.server;
  portA = a.port;
  const b = await makeBackend('beta');
  backendB = b.server;
  portB = b.port;

  const pa = db.createProject({ name: 'Alpha', websiteName: 'alpha', repoUrl: 'https://github.com/a/a.git', branch: 'main' });
  const pb = db.createProject({ name: 'Beta', websiteName: 'beta', repoUrl: 'https://github.com/b/b.git', branch: 'main' });
  db.createHostname({ projectId: pa.id, hostname: 'alpha.localhost', targetPort: portA });
  db.createHostname({ projectId: pb.id, hostname: 'beta.localhost', targetPort: portB });

  proxy = new ReverseProxy({ port: 0, host: '127.0.0.1', db });
  proxyPort = await proxy.listen();
});

afterAll(async () => {
  await proxy.close();
  backendA.close();
  backendB.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('hostname-based reverse proxy', () => {
  it('routes project A by Host header', async () => {
    const res = await get('alpha.localhost', '/hello');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.tag).toBe('alpha');
    expect(body.url).toBe('/hello');
    expect(body.forwarded).toBe('http');
  });

  it('routes project B by Host header', async () => {
    const res = await get('beta.localhost');
    const body = JSON.parse(res.body);
    expect(body.tag).toBe('beta');
  });

  it('ignores the port in the Host header', async () => {
    const res = await get(`alpha.localhost:${proxyPort}`);
    expect(JSON.parse(res.body).tag).toBe('alpha');
  });

  it('returns a friendly 404 page for unknown hosts (not an open proxy)', async () => {
    const res = await get('unknown.example');
    expect(res.status).toBe(404);
    expect(res.body).toContain('No route');
    expect(res.body).toContain('alpha.localhost');
  });

  it('rejects absolute-form request targets', async () => {
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: proxyPort, path: 'http://evil.example/steal', method: 'GET', headers: { Host: 'alpha.localhost' } },
        (r) => {
          r.resume();
          resolve({ status: r.statusCode ?? 0 });
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(res.status).toBe(400);
  });

  it('returns 502 when the upstream app is down', async () => {
    const down = db.createHostname({ projectId: null, hostname: 'down.localhost', targetPort: 59999 });
    const res = await get('down.localhost');
    expect(res.status).toBe(502);
    db.deleteHostname(down.id);
  });
});
