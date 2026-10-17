# Going public: buying a domain and serving your local app worldwide

**Short answer:** buying a domain is necessary but not sufficient. It fixes the *name*. You
still need a way for traffic from the internet to reach your PC — and on most home connections
that means a tunnel, not port forwarding.

## The chain (each link fails differently)

```
NAME ──────► IP ──────► PORT ──────► APP
 ①            ②           ③           ④
```

| # | Link | Fixed by | PortPilot can verify? |
|---|---|---|---|
| ① | `app.yourdomain.com` resolves | domain + DNS record | ✅ |
| ② | It points at something that can answer | public IP **or** tunnel | ✅ |
| ③ | A connection is accepted from outside | port forward **or** tunnel | ✅ |
| ④ | PortPilot answers, not some other server | correct target + route | ✅ |

Use **Network → Verify a public domain** (or `POST /api/public-access/verify`) to check all four
at once. It reports which link is broken instead of a vague failure.

> A DNS lookup alone does **not** mean the site works. That is the single most common mistake
> after buying a domain.

## Step 0 — can your line even accept inbound traffic?

```powershell
curl ifconfig.me            # your public IP as the internet sees it
# compare with the WAN IP on your router's status page
```

* **Same** → a public IP exists; port forwarding *may* work.
* **Different** → you are behind **CGNAT**; inbound port forwarding is impossible. Use a tunnel.

Indian residential fibre (Jio, Airtel, ACT) is frequently CGNAT. If your WAN address is in
`100.64.0.0/10`, `10.x`, `172.16–31.x` or `192.168.x`, you are behind carrier NAT.

## Path A — Tunnel (recommended; works behind CGNAT)

No open ports, no static IP, free TLS.

1. Buy a domain (registrar of your choice, ~₹700–1200/year).
2. Create a free Cloudflare account, add the domain, and change the registrar's nameservers to
   the two Cloudflare gives you.
3. Install `cloudflared` on the Windows PC and run a named tunnel pointing at your proxy:
   ```powershell
   cloudflared tunnel login
   cloudflared tunnel create portpilot
   cloudflared tunnel route dns portpilot app.yourdomain.com
   cloudflared tunnel run --url http://127.0.0.1:8080 portpilot
   ```
   `--url http://127.0.0.1:8080` sends everything to PortPilot's reverse proxy, which routes by
   the `Host` header — so every project keeps its own hostname.
4. In PortPilot, add the hostname `app.yourdomain.com` (mode: public) and point it at the project.
5. Verify: **Network → Verify a public domain** → expect `works`.

Wildcard bonus: `cloudflared tunnel route dns portpilot *.yourdomain.com` gives every project an
automatic name under your domain.

## Path B — Direct hosting (only with a real public IP)

1. Port-forward TCP 80 and 443 to this PC's LAN IP.
2. Allow the same ports through Windows Firewall.
3. Create an A record: `app.yourdomain.com → <your public IP>`.
4. Verify. If the name resolves but nothing answers, either the forward or the firewall is wrong.
5. For HTTPS with a home IP, DNS-01 (e.g. `win-acme` with a DNS plugin) avoids needing port 80.

Dynamic IP? Use a CNAME to a DDNS hostname, or update the A record via your registrar's API.

## What NOT to do

* **Do not invent a name** like `myapp.anything` that is not under a domain you own. It fails on
  every resolver on earth — the root zone is not writable by you.
* **Do not delegate your domain to a home PC's DNS server.** Registrars require two nameservers
  on distinct IPs; a residential line cannot provide that, and one reboot takes the domain (and
  its email) offline.
* **Do not expose a recursive/forwarding resolver** to the internet — it becomes a DDoS
  amplifier and gets blacklisted.
* PortPilot's DNS module is a **LAN tool** (UDP only, A records only, no SOA/NS/TCP). It cannot
  be a public authoritative nameserver.

## If you want to run authoritative DNS yourself

Run a **hidden primary**: a normal DNS server (NSD, Knot, or `dns2`) on a machine you control,
then have a public secondary host pull the zone over **AXFR + TSIG**. Only the secondary's IPs
are delegated at the registrar. That gives redundancy and DDoS protection; the home PC can be
off without breaking the domain.

## Cost and effort summary

| Approach | Domain needed | Public IP needed | Ports open | Cost |
|---|---|---|---|---|
| `*.localhost` | no | no | no | free |
| `*.nip.io` / DuckDNS | no | no | no | free |
| Cloudflare Tunnel + domain | **yes** | **no** | **no** | domain only |
| Direct hosting + domain | **yes** | **yes (static)** | 80/443 | domain only |
| Own authoritative DNS | yes | yes + 2 NS | 53 UDP/TCP | domain + VPS |

For most people: **domain + tunnel**. That is what makes "build locally, serve globally" actually
work, and it is what PortPilot's verifier is built to confirm.
