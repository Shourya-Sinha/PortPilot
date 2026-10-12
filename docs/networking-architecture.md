# PortPilot Networking Architecture

This document explains exactly how PortPilot names and routes traffic, what works offline/LAN,
and what genuinely requires publicly reachable network infrastructure. Nothing in this document
is aspirational: each claim maps to implemented code.

## 1. Layers of naming — and what each one proves

| Layer | Example | Where it works | What a success proves |
|---|---|---|---|
| **Local registration** | `my-portfolio` saved in SQLite | This PC | Name is unique and reserved inside PortPilot |
| **Local hostname** | `http://my-portfolio.localhost:8080` | This PC (OS/browser resolves `*.localhost` → 127.0.0.1 per RFC 6761) | The app is reachable **locally** |
| **LAN hostname** | `http://192.168.1.20:8080` with Host header / custom name via DNS module | Devices on your LAN | Reachable **inside your network** |
| **Public DNS resolution** | `app.example.com` → your public IP | Global DNS | The name resolves publicly — **not** that anything answers |
| **Verified external HTTP(S)** | A request from outside your network returns 200 | Internet | The app is **actually public** |

PortPilot keeps these layers separate in the UI (`resolutionStatus`, `reachabilityStatus`).
A successful local DNS lookup is **never** reported as public availability.

## 2. Local hostname routing (`*.localhost`)

```
Browser ── Host: my-portfolio.localhost ──► Reverse proxy :8080 ──► 127.0.0.1:<app port>
                                                     │
                                         SQLite hostname → port table
```

* Windows 10/11, Linux (systemd-resolved), macOS and Chromium/Firefox resolve `*.localhost` to
  loopback **without a DNS server and without administrator rights** (RFC 6761).
* The reverse proxy routes strictly by the HTTP `Host` header using the SQLite mapping.
  Unregistered hostnames get a 404 status page listing known routes — the proxy refuses
  absolute-form request targets and cannot be used as an open proxy.
* WebSocket upgrades are passed through the same routing table.
* After every redeploy the hostname's target port is re-synced automatically.

Why the proxy port appears in the URL (`:8080`): binding port 80 on Windows requires either
administrator rights or a URL-ACL reservation (`netsh http add urlacl`). PortPilot does not
make system-level changes without explicit consent — so the default is an unprivileged port.
You may set `PROXY_PORT=80` if you accept an elevated setup.

## 3. Optional local DNS module

Implemented in `packages/dns-server` (dependency-free RFC 1035 subset):

* Authoritative-style answers for one configurable zone (default `portpilot.home.arpa`),
  A records with configurable TTL, NXDOMAIN for unknown names inside the zone, **REFUSED for
  everything else** (it is not a recursive resolver and cannot be used as one).
* Binds `127.0.0.1` by default. Port 5353 needs no privileges; port 53 does (Windows:
  run elevated **with your explicit consent**, or forward port 53 to 5353).
* Zone management API + query log + lookup test utility in the dashboard.

**Hard truths (also printed in the API):**

* A local zone works **only** for clients configured to use this resolver. Other devices need
  their DNS settings pointed at your PC manually.
* Public DNS delegation requires control of a real domain (or an applicable delegated namespace).
* `home.arpa` is reserved for private networks — it is not a public domain you can register.
* **DNS records do not create network connectivity.** Answering `1.2.3.4` for a name does not
  route packets there, does not open ports, and does not bypass CGNAT.
* PortPilot never overwrites the Windows hosts file or network settings without explicit consent.

## 4. Public access: two honest strategies

### Strategy A — Direct public hosting (needs inbound connectivity)

Viable when your router WAN address is a real public IP and your ISP allows inbound connections:

1. Router port-forwarding: TCP 80/443 (or your chosen port) → this PC's LAN IP.
2. Windows Firewall inbound rule for the proxy port (PowerShell snippet is provided on the
   Network & Public Access page — applied only by you).
3. Public DNS A-record (or a legitimate free dynamic-DDNS hostname) pointing at your public IP.
   Dynamic IPs require an updater or manual record changes.
4. HTTPS with a publicly trusted certificate (e.g. Let's Encrypt DNS-01). Self-signed
   certificates do **not** provide public trust.
5. **Verification:** test HTTP from an external network. Only then does the dashboard treat the
   app as publicly reachable.

### Strategy B — No direct inbound (CGNAT / blocked ports)

* All local features keep working unchanged.
* The `PublicAccessAdapter` interface (`packages/public-access`) accepts a **user-operated relay**
  or an external tunnel agent you already run. A clean adapter seam exists so a relay
  implementation can be added without touching the core.
* A fully custom public relay needs *some* publicly reachable endpoint (a VPS you control, a
  friend's server, a free-tier host). If no reachable endpoint exists and no third-party relay is
  permitted, **globally accessible hosting cannot be guaranteed** — PortPilot says so instead of
  pretending otherwise.
* No third-party tunnel service (Cloudflare, ngrok, etc.) is required, bundled, or mandated.

### CGNAT diagnostics — what they can and cannot prove

| Observation | Conclusion |
|---|---|
| Router WAN IP is RFC1918 (10.x/172.16-31.x/192.168.x) | CGNAT/double-NAT **likely**; inbound hosting unlikely |
| Router WAN IP is public and equals the observed public IP | Direct inbound **possible** (still needs port forwarding + firewall + external test) |
| Router WAN IP unavailable (UPnP disabled — common) | **Inconclusive** — PortPilot never claims a verdict here |

The router's WAN IP is attempted via UPnP `GetExternalIPAddress` only; no router configuration is
ever changed.

## 5. Process/port topology

```
127.0.0.1:4300   Fastify API + dashboard + SSE log streams
127.0.0.1:8080   Reverse proxy (Host-based routing, WS passthrough)
127.0.0.1:5353   DNS module (optional, off by default)
127.0.0.1:43xx   One loopback port per running application (4300–4999 auto-allocated)
```

All management listeners bind loopback by default. LAN exposure of the dashboard requires
`HOST=0.0.0.0` **and** an explicit `PORTPILOT_AUTH_TOKEN` (session auth + CSRF are enforced
regardless of binding).

## 6. Failure modes by design

* App down → proxy returns 502 for that hostname only.
* Unknown hostname → 404 route list (never proxied anywhere).
* Upstream timeout → 504.
* DNS query outside the zone → REFUSED (no open resolver).
* Public checks fail (offline PC) → diagnostics report `unknown/offline`; no public URL is shown.
