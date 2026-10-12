# PortPilot Security Model

PortPilot runs build scripts and applications on **your** PC with **your** user account. This
document is explicit about what is protected, how, and what is *not* protected.

## Threat model

| Asset | Threat | Mitigation |
|---|---|---|
| Dashboard/API | Drive-by web pages calling the API (DNS rebinding, CSRF) | Loopback bind by default; session cookie (HttpOnly, SameSite=Strict) + CSRF double-submit on mutations; strict Origin checks; rate limits |
| Dashboard on LAN | Unauthorized users on your network | `PORTPILOT_AUTH_TOKEN` required for non-loopback binds; login throttled (20/min) |
| Secrets (GitHub PAT, env vars) | Leakage via logs/API/source | AES-256-GCM at rest (`data/secret.key`, 0600); values shown masked; automatic redaction of token-shaped strings in every log line and SSE payload; tokens passed to git via temporary `GIT_ASKPASS`, never in URLs/argv |
| Host OS | Command injection via user input | Command strings validated (no `; | & \` $() <>`, no line breaks, no sudo) before any shell execution; git invoked with argv arrays only |
| Host OS | Path traversal (artifacts, static server, log names) | Relative-path validation (`..`, absolute, drive, UNC rejected); static server roots resolved and containment-checked |
| Network | SSRF-style abuse of the reverse proxy | Host-based allowlist from SQLite; absolute-form requests rejected; only loopback upstreams |
| Network | Open DNS resolver abuse | DNS binds loopback; recursion disabled; out-of-zone queries REFUSED |
| Projects/webhooks | Spoofed push events | Per-project HMAC-SHA256 webhook secrets, timing-safe comparison |
| API inputs | Malformed/hostile payloads | All inputs validated (website names, URLs, branches, env keys, ports); 1 MiB body limit; timeouts; security headers (`X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`) |
| Destructive ops | Accidental data loss | Project deletion requires typing the website name; rollbacks only target successful deployments |

## What is NOT protected (read this)

* **Build scripts are arbitrary code.** `npm install` / `npm run build` executes whatever the
  repository ships. Command-string validation stops *accidental and casual* injection at the
  PortPilot input layer — it does **not** sandbox the build. Windows process isolation for
  arbitrary builds (Job Objects/AppContainer/WDAG) is out of scope; treat untrusted repositories
  as untrusted code. PortPilot therefore never recommends running as administrator.
* **The static server and app processes share your user account.** A malicious app can read what
  your user can read.
* **Token storage is encrypted, not hardware-protected.** Anyone with your Windows login and the
  `data/` folder can decrypt stored secrets.
* **Webhook endpoints know your project ids.** Keep the per-project secret; signature checks
  reject unsigned traffic, but treat the URL as semi-sensitive.
* **Public exposure is your choice.** When you enable LAN/public access you widen the attack
  surface; the auth token, firewall and port-forwarding guidance exist to make that choice
  informed, not automatic.

## Secure defaults

* API + proxy + DNS all bind `127.0.0.1` unless you change `.env`.
* Session cookies: `HttpOnly`, `SameSite=Strict`, random 48-hex session ids, 12-hour expiry.
* CSRF: `x-csrf-token` header must match the `pp_csrf` cookie for every non-GET API call.
* Git credentials: never stored in `git remote` URLs; askpass helper is created with restrictive
  permissions and deleted after each git call.
* Logs: every write path passes through `redactSecrets()` (GitHub tokens, JWTs, private keys,
  `password=/token=` pairs, URL credentials).
* Environment variables: stored as AES-256-GCM ciphertext; the API only ever returns
  `maskValue()` output; plaintext exists only in deployment process environments.
* Ports: application listeners bind `127.0.0.1` and are reachable through the proxy, not raw.

## Responsible disclosure

This is a local developer platform, not a hardened multi-tenant service. If you find a security
issue in the code, treat the repository's issue tracker accordingly and avoid testing against
systems you do not own.
