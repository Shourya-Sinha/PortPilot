# PortPilot — HomeDeploy Dashboard

**A local-first deployment platform for your own Windows PC (and Linux/macOS).**
Connect GitHub repositories, build and run web apps, and reach them through custom local hostnames —
with **no mandatory VPS, no purchased domain, no Docker, and no paid hosting or tunnel service**.

```
┌────────────────────────────────────────────────────────────────────────┐
│                     PortPilot HomeDeploy Dashboard                     │
│  Overview · Projects · Create · Deployments · Build/Runtime Logs ·     │
│  Domains & Hostnames · DNS · Network & Public Access · Env · GitHub ·  │
│  Settings                                                              │
└──────────────┬─────────────────────────────────────────────────────────┘
               │  (React + Vite dashboard, served by the local API)
┌──────────────┴───────────┬──────────────────┬──────────────────────────┐
│  GitHub Engine           │  Build Engine    │  App Runtime             │
│  clone · branches ·      │  install · build │  port allocation ·       │
│  commits · webhooks      │  logs · artifacts│  supervisor · health     │
├──────────────────────────┴──────────────────┴──────────────────────────┤
│  Name & Routing Engine                                                  │
│  website-name registration · *.localhost hostnames · reverse proxy      │
│  (optional) local DNS zone · network diagnostics · public-access module │
└─────────────────────────────────────────────────────────────────────────┘
        All core services run locally on your PC (SQLite + Node.js)
```

---

## Quick start (Windows 10/11)

```powershell
git clone <YOUR-PORTPILOT-REPOSITORY-URL>
cd PortPilot
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
npm run dev          # development (hot-reload dashboard)
# or
npm start            # production
```

`scripts\install.ps1` checks Node.js (≥ 22) and Git, installs dependencies, creates the data
directories, initializes the SQLite database, builds everything, and prints the dashboard URL.

On first start the API prints a **one-time access token** (also stored in `data/.session-token`):

```
Dashboard:  http://127.0.0.1:4300/?token=<your-token>
Proxy:      http://127.0.0.1:8080  (hostname routing)
```

Open the dashboard URL — the token logs you in once and the session cookie takes over.

> macOS/Linux: the same commands work (`npm install && npm run setup && npm run dev`).

---

## What you can do

| Area | Capabilities |
|---|---|
| **Projects** | Create from a GitHub URL (public repos need **no** GitHub account), branch selection, framework detection with **confirmation before first deploy**, install/build/start command overrides, project root, output dir, port, health-check path |
| **Website Name (required)** | Validated name → saved in SQLite → auto local hostname `my-portfolio.localhost` → reverse-proxy route created → local URL shown immediately after deploy. Optional public hostname setting, only displayed as public after **external** verification |
| **GitHub Engine** | `git` CLI clone/pull/ls-remote (+ submodules), private repos via a least-privilege PAT — saved in the dashboard or `PORTPILOT_GITHUB_TOKEN` — stored AES-256-GCM encrypted and never logged; signed webhooks (HMAC-SHA256); outbound polling so auto-redeploy works without inbound webhooks (`POLL_INTERVAL_MS`); manual **Pull & Redeploy** |
| **Build Engine** | Full lifecycle with live logs: checkout → detect → install → build → artifact → port allocation → startup → health check → done. Timestamps, exit codes, duration, cancel, retry, rollback. Versioned artifacts: a failed build **never** overwrites the last working deployment |
| **App Runtime** | Per-app loopback ports, PID/cwd/status tracking, static file server for static sites, graceful stop (process-tree kill), crash detection, duplicate-launch prevention, **autostart after a PortPilot restart** (`AUTOSTART`) |
| **Name & Routing Engine** | Hostname CRUD with conflict checks, Host-header reverse proxy with WebSocket passthrough, route auto-update on redeploy, friendly routing status page |
| **DNS module (optional)** | Own authoritative-style local zone, A records, TTLs, zone API, conflict detection, query log, `dig`-style test utility, loopback-only by default, **no recursion** |
| **Network & Public Access** | Local IP, gateway, internet check, public IP vs router WAN IP, CGNAT heuristics (honestly *inconclusive* when the WAN IP is unknown), occupied ports. Strategy A (direct hosting guidance) and Strategy B (pluggable relay adapter). No settings are changed without your explicit action |
| **Security** | Loopback binding by default, session + CSRF protection, rate limits, command/URL/path validation, secret redaction in logs, webhook signatures, destructive-action confirmation. See [docs/security.md](docs/security.md) for the honest limits |

---

## Website name registration

Every project has a **required Website Name** (lowercase letters, digits, hyphens).

1. You enter `my-portfolio` in the Create Project flow.
2. PortPilot validates it and rejects invalid characters and duplicates.
3. It is stored in SQLite and linked to the project (persistent across restarts/redeploys).
4. The local hostname `my-portfolio.localhost` is registered and routed by the reverse proxy.
5. After a successful deployment the dashboard shows `http://my-portfolio.localhost:8080` immediately.

**Honest scope:** `*.localhost` names resolve to your PC via the operating system (RFC 6761 —
Windows 10/11, Linux, and modern browsers support this without any DNS server or admin rights).
They are **locally registered only** — never a globally registered domain, never reachable from
the internet as-is. The optional **Public Hostname** setting is displayed publicly **only** after
the configured name exists in real public DNS and external HTTP reachability has been verified.
See [docs/networking-architecture.md](docs/networking-architecture.md).

---

## Commands

| Command | What it does |
|---|---|
| `npm install` | Install workspace dependencies |
| `npm run setup` | Verify Node ≥ 22 + Git, create `data/ workspaces/ artifacts/ logs/`, initialize SQLite + schema, build everything, verify ports, print the dashboard URL |
| `npm run dev` | Build once, then run API + Vite dev server (hot reload) |
| `npm run build` | Compile all TypeScript packages + build the dashboard |
| `npm start` | Run the full platform (API + reverse proxy + optional DNS) |
| `npm run doctor` | Environment & service diagnostics |
| `npm test` | Unit + integration tests (deployment pipeline, proxy routing, DNS, API auth) |
| `npm run stop` | Stop a background instance started with `scripts\start.ps1` |
| `npm run clean` | Remove build output (runtime data preserved) |

PowerShell scripts (in `scripts/`): `install.ps1`, `start.ps1`, `stop.ps1`, `doctor.ps1`,
`uninstall.ps1`, `install-startup.ps1` (optional per-user Startup integration — explicit consent,
no administrator rights required).

---

## Configuration

Copy `.env.example` to `.env` (done automatically by setup). Key values:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4300` | Dashboard + API port |
| `HOST` | `127.0.0.1` | API bind address (loopback by default) |
| `PROXY_PORT` | `8080` | Reverse-proxy port for `*.localhost` routing |
| `DNS_ENABLED` | `false` | Turn on the optional local DNS module |
| `DNS_PORT` | `5353` | DNS listener (53 needs elevation; 5353 does not) |
| `DNS_ZONE` | `portpilot.home.arpa` | Local DNS zone |
| `PORTPILOT_AUTH_TOKEN` | *(generated)* | Dashboard access token (required for LAN exposure) |
| `PORTPILOT_GITHUB_TOKEN` | *(unset)* | Optional fine-grained PAT for private repos |

---

## Repository layout

```
PortPilot/
├── apps/
│   ├── dashboard/        React + Vite dashboard (12 pages)
│   ├── api/              Fastify REST + SSE API, static serving, bootstrap
│   └── worker/           Deployment queue (build → runtime lifecycle)
├── packages/
│   ├── shared/           Types, validation, redaction, logging, event bus
│   ├── database/         SQLite (node:sqlite) schema, repos, AES-256-GCM secrets
│   ├── github/           git CLI engine, webhook signature verification
│   ├── build-engine/     Framework detection, safe command runner, pipeline
│   ├── runtime-manager/  Port allocation, static server, process supervisor
│   ├── hostname-manager/ Website names, hostname registry, status checks
│   ├── reverse-proxy/    Host-header router (HTTP + WebSocket)
│   ├── dns-server/       Minimal loopback-only DNS (A records, no recursion)
│   ├── network-diagnostics/  Honest LAN/WAN/CGNAT diagnostics
│   └── public-access/    Strategy A/B adapters (direct, relay interface)
├── scripts/              install/start/stop/doctor/uninstall (.ps1 + .mjs)
├── samples/              static-site + node-app test projects
├── docs/                 networking architecture, security, troubleshooting
├── data/ workspaces/ artifacts/ logs/   (runtime — git-ignored)
└── package.json  .env.example  README.md
```

---

## Testing

`npm test` runs 57+ automated checks, including:

* input validation (website names, repo URLs, command-injection attempts),
* SQLite repositories + encrypted secrets,
* framework detection (static, Vite/React, Next.js, Express, Fastify, Maven),
* DNS wire format + a live DNS server (A, NXDOMAIN, REFUSED for out-of-zone),
* reverse-proxy routing of two projects by Host header + open-proxy rejection,
* **end-to-end deployments** of `samples/static-site` and `samples/node-app` (clone → build →
  start → health check → proxy routing), failed-build preservation of the live version,
  unsafe-command and invalid-repo rejection,
* API auth, CSRF, origin checks, website-name registration conflicts.

Environment note: this repository's automated tests were executed on **Linux** (Node 22). The
platform code is cross-platform (no Linux-only APIs; Windows uses `cmd.exe`/`taskkill` paths),
but the bundled **PowerShell scripts are written for Windows and are labeled UNVERIFIED here**
until run on a real Windows machine — see “Verified vs unverified” below.

---

## Verified vs unverified (honest status)

| Item | Status |
|---|---|
| All `npm test` suites (Linux, Node 22) | ✅ verified passing |
| Sample static + Node deployments through the full pipeline | ✅ verified |
| Reverse proxy routing two projects by hostname | ✅ verified |
| DNS module (bind, A answers, NXDOMAIN, REFUSED) | ✅ verified on loopback |
| Dashboard builds and is served by the API | ✅ verified |
| PowerShell scripts (`install/start/stop/doctor/uninstall`) | ⚠️ UNVERIFIED on Windows in this environment |
| `*.localhost` resolution on Windows 10/11 | ⚠️ UNVERIFIED here (documented RFC 6761 behavior) |
| Public reachability / DDNS / certificates | ❌ never claimed — requires your network + external verification |
| Windows service auto-start | ⚠️ per-user Startup shortcut provided instead (no admin needed) |

---

## Limitations you should know

* **Build scripts are arbitrary code.** Command validation blocks shell metacharacters, but this is
  hardening — **not a sandbox**. Only deploy repositories you trust. Never run PortPilot as
  administrator for routine builds.
* **Webhooks need inbound reachability.** GitHub cannot deliver push webhooks to a PC behind
  CGNAT/home NAT without a reachable endpoint. Use **Pull & Redeploy**, or your own relay.
* **A local DNS zone only serves clients pointed at it.** It cannot bypass CGNAT, cannot create a
  public IP, and `home.arpa` names are private-only by design.
* **Public mode never lies.** A public URL appears only when a real hostname is configured in real
  public DNS *and* external HTTP reachability has been verified. Everything else is labeled local.
* **Node.js ≥ 22** is required (the built-in `node:sqlite` module avoids native compilation on
  Windows).

## Documentation

* [docs/networking-architecture.md](docs/networking-architecture.md) — routing, DNS, public access strategies, CGNAT reality check
* [docs/security.md](docs/security.md) — threat model, protections, honest sandbox limits
* [docs/troubleshooting.md](docs/troubleshooting.md) — common problems and fixes

## License

MIT
