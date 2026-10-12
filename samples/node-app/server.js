/**
 * PortPilot sample Node.js application (zero dependencies).
 * Reads the PORT environment variable that PortPilot assigns,
 * exposes / and /health for health checks.
 */
import http from 'node:http';

const port = Number(process.env.PORT ?? 3000);
const startedAt = Date.now();

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html>
<html><head><title>PortPilot Sample Node App</title>
<style>
  body{font-family:'Segoe UI',system-ui,sans-serif;background:#0b1220;color:#e6edf7;
       display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .card{background:#12203a;border:1px solid #27406a;border-radius:12px;padding:2.4rem;max-width:560px}
  h1{margin-top:0;color:#38bdf8}code{background:#0e1a30;padding:.15em .5em;border-radius:6px}
</style></head>
<body><div class="card">
  <h1>PortPilot Sample Node App</h1>
  <p>This Node.js process was cloned, built and started by the PortPilot deployment pipeline.</p>
  <p>Listening on <code>127.0.0.1:${port}</code> (from the <code>PORT</code> environment variable).</p>
  <p>Health endpoint: <a style="color:#38bdf8" href="/health">/health</a></p>
  <p>Uptime: ${Math.round((Date.now() - startedAt) / 1000)}s</p>
</div></body></html>`);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`sample-node-app listening on 127.0.0.1:${port}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`${sig} received, shutting down gracefully...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
