# PortPilot — Deployment Pipeline Audit

**Date:** 2026-10-17
**Scope:** Does PortPilot actually (a) fetch a GitHub codebase, (b) build and run it locally,
(c) serve it on a custom website name via its own custom DNS server, automatically?
**Method:** every claim below was exercised against a running instance, not read off the README.

---

## Fix status (2026-10-17, later the same day)

All items below marked **FIXED** are implemented and covered by tests
(`tests/fixes.test.ts`, `tests/api.test.ts`) or verified against a running instance.

| Item | Status |
|---|---|
| BUG-1 saved PAT ignored | **FIXED** — `db.resolveGithubToken()` is used by clone, ls-remote, fetch and the worker |
| BUG-2 DNS records only at startup | **FIXED** — synced on hostname/project create, rename and delete |
| BUG-3 SPA fallback always on | **FIXED** — opt-in per framework (`isSpaFramework`), plain static sites now 404 |
| LIMIT-2 apps die with PortPilot | **FIXED** — autostart restarts previously running apps (`AUTOSTART=true`) |
| LIMIT-3 no webhook alternative | **FIXED** — outbound git poller (`POLL_INTERVAL_MS`, default 5 min) |
| LIMIT-4 no submodules/LFS | **FIXED** — `--recurse-submodules` + `submodule update` |
| LIMIT-5 sessions lost on restart | **FIXED** — sessions persisted to `data/sessions.json` (0600, same TTL) |
| BUG-4 path containment allowed siblings sharing a prefix | **FIXED** — `isPathInside()` (path.relative based) replaces `startsWith` in the dashboard server and static file server |
| LIMIT-1 DNS could not be delegated | **FIXED IN CODE** — SOA, NS, TCP/53, wildcards, NODATA/NXDOMAIN semantics, gated AXFR added; verified with a real resolver |
| LIMIT-6 Windows unverified | **FIXED IN CODE** — credential helper replaces the fragile `.cmd` askpass, and `verifyGitCredentialTransport()` proves it on any platform (`npm run doctor`, `POST /api/diagnostics/git-credentials`) |

### Proving the private-repo path (previously a caveat)

GitHub returns "Repository not found" identically for a missing repo and for bad credentials, so
a GitHub integration test cannot distinguish "token sent" from "no token sent". The transport is
therefore observed directly:

* `tests/token-transport.test.ts` stands up a local HTTP git remote that returns `401` and records
  the `Authorization` header. With a token, git retries with credentials containing it; without
  one, no credential is ever sent; and the token never appears in git output.
* End-to-end against the running API: a project created the way the UI creates it had
  `githubTokenRef = null`, and the clone triggered by `/api/projects/:id/detect` delivered an
  `Authorization` header containing the token stored through the dashboard. Removing the token
  produced zero credential headers.

### LIMIT-1: what was implemented

The server now publishes everything a delegation needs:

| Requirement | Before | Now |
|---|---|---|
| SOA at the apex | absent | emitted (serial, refresh, retry, expire, minimum) |
| NS at the apex | absent | emitted from `DNS_NS_NAME` |
| TCP/53 | not implemented | TCP listener with length-prefixed framing (`DNS_TCP=true`) |
| Wildcard hosts | absent | `*.zone` with RFC 4592 closest-encloser matching |
| NXDOMAIN / NODATA | bare rcode | SOA in the authority section, as RFC 1034 requires |
| UDP truncation | silent | TC bit set so clients retry over TCP |
| Zone transfer | absent | AXFR/IXFR over TCP, REFUSED unless the client is in `allowAxfrFrom` |
| Recursion | refused | still refused (RA=0) — never an open resolver |

Verified with a real resolver against the running server:

```
SOA      : { nsname: 'ns1.anantainfratech.test', serial: 20261017, refresh: 3600, ... }
NS       : [ 'ns1.anantainfratech.test' ]
apex A   : [ '203.0.113.10' ]
wildcard : [ '203.0.113.10' ]   shop.eu.<zone>
out-zone : EREFUSED
TCP A    : { rcode: 0, answers: 1 }
```

**What software still cannot supply** is the network side: a public static IP, inbound port 53,
and registrar delegation. Those are configuration and connectivity, not code. With them set,
this server answers correctly; without them no DNS software anywhere can help. Two nameservers
on distinct IPs are still required by most registrars for production use.

### LIMIT-6: what was implemented

Windows could not be executed in this environment, so instead of documenting the gap the fragile
part was removed and the rest made self-verifying:

* **Credential delivery no longer depends on a `.cmd` script.** The default is now a credential
  helper (`credential.helper=!node <script>`), which reads the token from the environment and is
  executed by git's own shell identically on Windows, macOS and Linux. The old `GIT_ASKPASS`
  `.cmd` path remains behind `PORTPILOT_GIT_CREDENTIALS=askpass` as a fallback.
* **An ambient-helper reset** (`credential.helper=` first) stops Git Credential Manager from
  interfering with the token PortPilot supplies.
* **The mechanism is proven at runtime, per machine:** `verifyGitCredentialTransport()` starts a
  throwaway HTTP remote that answers 401, runs a real `git ls-remote`, and checks that the token
  arrived. Exposed as `npm run doctor` and `POST /api/diagnostics/git-credentials`, so a Windows
  user gets a definitive pass/fail instead of "works on Linux, unverified here".

Still not executable without a Windows machine: `taskkill /T /F` tree shutdown, `cmd.exe /d /s /c`
command execution, and `*.localhost` handling in Edge/Chrome. Those run through
`npm run verify:flow` on the target PC.

## Verdict

| Question | Answer |
|---|---|
| Does it fetch GitHub code correctly? | **Yes for public repos.** Private repos: **no** — see BUG-1. |
| Does it build and run locally? | **Yes**, for Node/Express, Vite/React, CRA, Next (server + export), and plain static sites. |
| Does it serve a custom website name? | **Yes**, as `<name>.localhost:8080` — but by browser RFC 6761 behaviour, **not** by the DNS server. |
| Does the custom DNS server make it work automatically? | **No.** Off by default, empty records until restart, binds a port no OS resolver uses. |
| Is everything complete and automatic? | **No.** Core deploy loop is complete; private repos, DNS automation, restart persistence and webhooks need work. |

---

## What was verified working

| Test | Result |
|---|---|
| Clone public static repo (`octocat/Spoon-Knife`) | ✓ 3 branches listed, deployed, **HTTP 200 / 355 bytes** via proxy |
| Clone + run public Node app (`heroku/nodejs-getting-started`) | ✓ detected `express`/`node`, installed, started on port 4354, health-checked, **HTTP 200 / 9109 bytes** via proxy |
| Framework detection | ✓ static, express, vite/react, next, CRA, java-maven/gradle paths present |
| Reverse proxy host routing | ✓ `<name>.localhost` → app port; unknown host → 404 |
| Pull & Redeploy | ✓ re-ran pipeline, re-synced hostname target port, app still serving |
| Rollback / versioned artifacts | ✓ failed build does not overwrite last good artifact (covered by test suite) |
| Webhook signature validation | ✓ HMAC-SHA256, timing-safe, unsigned rejected |
| Test suite | ✓ 73/73 passing |

---

## Gaps and defects

### BUG-1 — A saved GitHub PAT is silently ignored (High)
`POST /api/github/token` stores the token and `token-status` reports `configured: true`, but
`POST /api/projects` never sets `githubTokenRef` on the project. Every deploy resolves the
credential as:

```ts
project.githubTokenRef ? db.getSecret(project.githubTokenRef) : process.env.PORTPILOT_GITHUB_TOKEN ?? null
```

so a project created through the UI always falls back to the env var. Result: **private
repositories fail even though the dashboard says a token is configured.** Only
`PORTPILOT_GITHUB_TOKEN` in `.env` actually works today.

Observed:

```
store token:        200
token-status:       { configured: true, source: 'database' }
created project:    githubTokenRef = null      <-- saved token unused
```

**Fix:** fall back to the global `github_token_ref` setting at credential-resolution time, in
`apps/api/src/routes-projects.ts` (4 sites) and `apps/worker/src/index.ts` (1 site).

### BUG-2 — DNS records sync only at startup (High)
`dns.setRecord()` is called in `apps/api/src/index.ts` during boot and by the manual DNS routes.
Creating a project or hostname does **not** add a record. Observed live: DNS ran with
`records: []` while a project existed; records appeared only after restarting PortPilot.

**Fix:** call `dns.setRecord` / `dns.removeRecord` from the hostname create/update/delete paths.

### LIMIT-1 — The custom DNS server cannot resolve your names for real clients
* Binds `127.0.0.1:5353` by default. OS resolver settings accept an **IP only** (implicit port
  53), so no operating system can point at it where it listens.
* Port 53 requires administrator/root elevation.
* `DNS_ENABLED=false` by default; it is never started automatically.

Custom names work because every browser resolves `*.localhost` to loopback under RFC 6761 —
independent of PortPilot. Verified: the OS resolver in the test environment returned
`ENOTFOUND` for `anything.localhost` while the browser-based path served the app fine.

**Positioning fix:** describe `*.localhost` as browser-native local names, and the DNS module as
an optional LAN/evaluation tool that needs `DNS_PORT=53` (elevated) plus manual client
configuration. It is not, and cannot be, an automatic public domain.

### LIMIT-2 — Apps do not survive a PortPilot restart (Medium)
Shutdown stops every supervised app; startup marks previous PIDs `crashed` instead of restarting
them. The README's "survives dashboard restarts" is true of the database rows, not of the running
processes. Verified: after a restart the runtime showed `crashed`, and a manual redeploy was
required.

**Fix:** on boot, re-launch projects whose last runtime state was `running` (opt-in flag).

### LIMIT-3 — Auto-redeploy on push does not work out of the box (Medium)
GitHub cannot reach a home PC behind NAT/CGNAT. The UI is honest and points to manual
**Pull & Redeploy**, but the "outbound poller" option listed there is not implemented.

### BUG-3 — Static SPA fallback is always enabled (Low)
`createStaticServer(..., { spa: true })` is unconditional in `supervisor.ts`, so a missing asset
returns `index.html` with **200** instead of 404. Should be per-project and exclude real files.

### LIMIT-4 — No Git LFS or submodule support (Low)
`git clone` runs without `--recurse-submodules`; LFS files arrive as pointer text.

### LIMIT-5 — Sessions live in memory (Info)
Every restart invalidates sessions; the user re-enters `data/.session-token`. Not a defect, but
worth documenting.

### LIMIT-6 — Windows remains unverified (Info)
`*.localhost` behaviour on Windows is marked "UNVERIFIED" in the README; all audit runs here were
on Linux.

---

## Recommended order

1. **BUG-1** — small, and it is the difference between "private repos supported" and "documented
   but broken".
2. **BUG-2 + LIMIT-1** — sync DNS records, and correct the claim so users are not misled about
   custom domains.
3. **LIMIT-2** — auto-start previously running apps (this is what "always on" actually means).
4. **BUG-3** — make SPA fallback opt-in.
5. **LIMIT-3/4** — poller, LFS, submodules, as follow-ups.

## What is genuinely complete

The core loop — *public GitHub repo → detect → install → build → version → run → health check →
`<name>.localhost:8080`* — works end to end, with live logs, redeploy, rollback, crash detection
and a leak-resistant credential path (`GIT_ASKPASS`, never in URLs or argv). What is not complete
is the automation around it and the private-repo credential wiring.
