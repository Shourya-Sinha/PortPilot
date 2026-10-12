# PortPilot Troubleshooting

Run `npm run doctor` first — it checks Node/Git versions, build output, database, ports, and
service health.

## Setup & startup

**`npm run setup` fails at "Node.js version"**
Install Node.js 22 LTS or newer from https://nodejs.org (PortPilot uses the built-in
`node:sqlite` module to avoid native compilation on Windows).

**`tsc` or build errors after pulling changes**
Run `npm install` then `npm run build`. If TypeScript project references look stale:
`npm run clean && npm run build`.

**Port 4300 or 8080 already in use**
Change `PORT` / `PROXY_PORT` in `.env`, then restart. `npm run doctor` shows which platform
ports are occupied.

**"Dashboard not built" page**
The API is running but `apps/dashboard/dist` is missing — run `npm run build:dashboard`
(or `npm run dev` to use the Vite dev server on :5173).

## Authentication

**Login rejected**
Use the token printed at startup (also in `data/.session-token`). If lost, delete
`data/.session-token` and restart — a new one is generated. For LAN exposure set
`PORTPILOT_AUTH_TOKEN` in `.env` explicitly.

**403 CSRF errors from scripts**
Mutating calls need the `pp_csrf` cookie value in the `x-csrf-token` header. Use the dashboard
or replicate the login + cookie flow.

## Deployments

**Clone fails: "Repository not found" / auth**
Public repos need no token. For private repos add a fine-grained PAT (Contents: Read) on the
GitHub Integration page, or set `PORTPILOT_GITHUB_TOKEN`. Tokens in URLs are rejected by design.

**Build fails at install**
Read the build log phase output. `npm ci` needs a lockfile — PortPilot falls back to
`npm install` once automatically. Corporate proxies may need `HTTPS_PROXY` in the environment.

**Build succeeded but health check failed**
The app may listen on the wrong port. PortPilot passes `PORT` and `HOSTNAME` env vars — apps must
bind `127.0.0.1:${PORT}`. Adjust the health-check path (default `/`) or preferred port.

**Old version still served after a failed deploy**
This is by design: a failed build never replaces the running deployment. Fix the build and
redeploy, or use Rollback on the Deployments page.

**Process keeps running after "stop" on Windows**
`scripts\stop.ps1` and the supervisor use `taskkill /T /F` for process trees. If a spawned
child escaped (e.g. a detached installer), end it from Task Manager; PortPilot records the PID
on the project page.

## Hostnames & proxy

**`http://my-app.localhost:8080` doesn't resolve**
`*.localhost` requires Windows 10+ (or a browser that implements RFC 6761). Fallback that always
works: `http://127.0.0.1:8080` with a `Host: my-app.localhost` header, or open the app URL shown
on the Projects page (`http://127.0.0.1:<port>`).

**404 "No route for ..." page**
The hostname isn't registered or the project hasn't been deployed yet. Check the Domains &
Hostnames page.

**Two projects want the same website name**
Website names are globally unique per installation (they define hostnames). Rename one.

## DNS module

**"Cannot bind DNS port"**
Port 53 requires administrator rights on Windows. Either use the default `DNS_PORT=5353`, or run
elevated with explicit consent. This is never done silently.

**Client doesn't see the local zone**
Only clients configured to use your resolver see it. Windows: Settings → Network → adapter →
Edit DNS → Manual → `127.0.0.1` (requires the DNS listener on port 53). Test with
`Resolve-DnsName -Server 127.0.0.1`.

## Public access

**Diagnostics say "inconclusive"**
Your router's WAN IP could not be read (UPnP disabled is common). Check the router admin page
manually; PortPilot will not guess.

**Everything works locally but not from the internet**
Expected when you're behind CGNAT or haven't configured port forwarding + firewall + public DNS.
See the Network & Public Access page for Strategy A/B guidance. Local mode needs none of this.

**Where is my public URL?**
It appears only after a real public hostname resolves in public DNS **and** an external HTTP
check succeeds. PortPilot never displays an unverified public URL.

## Logs

| Log | Location |
|---|---|
| Platform/API logs | `logs/api-YYYY-MM-DD.log`, `logs/proxy-*.log` |
| Build logs (per deployment) | `logs/deployments/<deploymentId>.log` |
| App stdout/stderr | `logs/runtime/<website-name>.log` |
| Live tail | Dashboard → Build Logs / Runtime Logs (SSE) |

Secrets are redacted before any log line is written. If you still find a leak, open an issue.

## Data & resets

* All state lives in `data/portpilot.db` (+ `data/secret.key`). Deleting `data/` resets everything
  (back it up first — the key decrypts stored secrets).
* `scripts\uninstall.ps1 -PurgeData` removes runtime data after typed confirmation.
* App source checkouts: `workspaces/`, built artifacts: `artifacts/` — both safe to delete;
  the next deploy recreates them.
