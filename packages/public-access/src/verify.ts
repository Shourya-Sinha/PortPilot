import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

/**
 * Public domain verification.
 *
 * Answering "will my purchased domain actually work?" means checking the four
 * links in the chain separately, because each one fails differently and the fix
 * is different:
 *
 *   1. NAME   — does the domain resolve at all, publicly?
 *   2. TARGET — does it point at this PC's public IP (or a tunnel)?
 *   3. PORT   — does something accept a connection from the internet?
 *   4. APP    — does the request come back answered by PortPilot?
 *
 * Testing only step 1 (a DNS lookup) is what makes people think a domain works
 * when it does not. This verifier checks the whole path and reports per-link
 * results, so the dashboard can say exactly which link is broken.
 */

export type LinkState = 'ok' | 'broken' | 'unknown';

export interface PublicDomainCheck {
  domain: string;
  /** 1. Name: public DNS resolution. */
  resolves: boolean;
  resolvedAddresses: string[];
  /** CNAME target when the record is aliased (typical for tunnels). */
  cnameTarget: string | null;
  /** 2. Target: does the name point at our detected public IP? */
  pointsAtThisPc: boolean | null;
  /** 3. + 4. Port/App: an HTTP(S) request from this process to the domain. */
  httpReachable: boolean;
  httpStatus: number | null;
  httpsReachable: boolean;
  httpsStatus: number | null;
  /** True when the response was served by PortPilot's own reverse proxy. */
  servedByPortPilot: boolean;
  /** Caveat: a failed fetch may be NAT hairpinning, not a real failure. */
  possibleHairpinFalseNegative: boolean;
  verdict: 'works' | 'reachable_not_ours' | 'name_only' | 'not_reachable' | 'not_configured';
  links: {
    name: { state: LinkState; detail: string };
    target: { state: LinkState; detail: string };
    port: { state: LinkState; detail: string };
    app: { state: LinkState; detail: string };
  };
  nextSteps: string[];
  checkedAt: string;
}

export interface VerifyOptions {
  /** Public IP of this PC from diagnostics, when known. */
  expectedPublicIp?: string | null;
  /** Port the reverse proxy listens on locally (for the 'app' link). */
  localProxyPort?: number;
  timeoutMs?: number;
}

const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8'];

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  return ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80');
}

/** Resolve using public resolvers, so we see what the internet sees. */
async function resolvePublic(domain: string): Promise<{ addresses: string[]; cname: string | null }> {
  const resolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
  try {
    resolver.setServers(PUBLIC_RESOLVERS);
  } catch {
    /* keep system resolvers */
  }
  const addresses: string[] = [];
  try {
    addresses.push(...(await resolver.resolve4(domain)));
  } catch {
    /* no A record */
  }
  if (addresses.length === 0) {
    try {
      addresses.push(...(await resolver.resolve6(domain)));
    } catch {
      /* no AAAA record */
    }
  }
  let cname: string | null = null;
  try {
    const records = await resolver.resolveCname(domain);
    cname = records[0] ?? null;
  } catch {
    /* not a CNAME */
  }
  return { addresses, cname };
}

function httpGet(domain: string, secure: boolean, timeoutMs: number): Promise<{ ok: boolean; status: number | null; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve) => {
    const mod = secure ? https : http;
    const req = mod.request(
      {
        host: domain,
        port: secure ? 443 : 80,
        path: `/?portpilot-verify=${Date.now()}`,
        method: 'GET',
        timeout: timeoutMs,
        headers: { 'user-agent': 'PortPilot-Verifier/1.0' },
        // Certificates may be self-signed while the user is still setting up.
        ...(secure ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        res.resume();
        resolve({ ok: (res.statusCode ?? 500) < 500, status: res.statusCode ?? null, headers: res.headers });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: null, headers: {} });
    });
    req.on('error', () => resolve({ ok: false, status: null, headers: {} }));
    req.end();
  });
}

export async function verifyPublicDomain(rawDomain: string, opts: VerifyOptions = {}): Promise<PublicDomainCheck> {
  const domain = rawDomain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  const timeoutMs = opts.timeoutMs ?? 8000;
  const expected = opts.expectedPublicIp ?? null;

  const { addresses, cname } = await resolvePublic(domain);
  const resolves = addresses.length > 0 || cname !== null;

  // A tunnel publishes a CNAME and resolves to the tunnel provider, so matching
  // our own IP is only meaningful for the direct A-record strategy.
  let pointsAtThisPc: boolean | null = null;
  if (expected && addresses.length > 0) {
    pointsAtThisPc = addresses.includes(expected);
  } else if (expected && cname) {
    pointsAtThisPc = false; // aliased to a tunnel: intentionally not our IP
  }

  const httpsRes = domain ? await httpGet(domain, true, timeoutMs) : { ok: false, status: null, headers: {} };
  const httpRes = !httpsRes.ok && domain ? await httpGet(domain, false, timeoutMs) : { ok: false, status: null, headers: {} };
  const servedByPortPilot = Boolean(httpsRes.headers['x-portpilot-route'] || httpRes.headers['x-portpilot-route']);

  const anyReachable = httpsRes.ok || httpRes.ok;

  const nameState: LinkState = resolves ? 'ok' : 'broken';
  const targetState: LinkState = pointsAtThisPc === true ? 'ok' : pointsAtThisPc === false ? 'unknown' : 'unknown';
  const portState: LinkState = anyReachable ? 'ok' : resolves ? 'broken' : 'unknown';
  const appState: LinkState = servedByPortPilot ? 'ok' : anyReachable ? 'broken' : 'unknown';

  let verdict: PublicDomainCheck['verdict'];
  if (!resolves) verdict = 'not_configured';
  else if (!anyReachable) verdict = 'not_reachable';
  else if (servedByPortPilot) verdict = 'works';
  else verdict = 'reachable_not_ours';

  const nextSteps: string[] = [];
  if (!resolves) {
    nextSteps.push(`Create the DNS record for ${domain}: an A record to your public IP, or a CNAME if you are using a tunnel.`);
    nextSteps.push('Wait for propagation (usually 1-5 minutes with Cloudflare, up to an hour elsewhere).');
  } else if (!anyReachable) {
    nextSteps.push('The name resolves, but nothing answered on port 80 or 443 from the public internet.');
    nextSteps.push('If your router WAN IP is private (CGNAT), port forwarding cannot work — use a tunnel.');
    nextSteps.push('Otherwise forward TCP 80/443 to this PC and allow it through Windows Firewall.');
  } else if (!servedByPortPilot) {
    nextSteps.push('The domain is reachable, but the response did not come from PortPilot.');
    nextSteps.push('Point the record at this PC (A record) or at your tunnel (CNAME), then verify again.');
  } else {
    nextSteps.push('Working: the domain resolves, is reachable, and PortPilot answered.');
    nextSteps.push('Add HTTPS (e.g. Cloudflare proxy or the tunnel) if the site still loads over http.');
  }

  return {
    domain,
    resolves,
    resolvedAddresses: addresses,
    cnameTarget: cname,
    pointsAtThisPc,
    httpReachable: httpRes.ok,
    httpStatus: httpRes.status,
    httpsReachable: httpsRes.ok,
    httpsStatus: httpsRes.status,
    servedByPortPilot,
    // If the name resolves to our own public IP but fails from this machine, the
    // router may simply not hairpin. It can still work from outside.
    possibleHairpinFalseNegative: Boolean(expected && pointsAtThisPc && resolves && !anyReachable),
    verdict,
    links: {
      name: { state: nameState, detail: resolves ? `resolves to ${addresses.join(', ') || cname}` : `no public A/AAAA/CNAME record for ${domain}` },
      target: {
        state: targetState,
        detail: expected
          ? pointsAtThisPc
            ? `points at this PC (${expected})`
            : cname
              ? `aliased to ${cname} (tunnel or third party)`
              : `resolves to ${addresses.join(', ')}, not ${expected}`
          : 'public IP unknown — run network diagnostics first',
      },
      port: { state: portState, detail: anyReachable ? 'a connection was accepted from the internet' : resolves ? 'no response on 80/443' : 'cannot test — name does not resolve' },
      app: { state: appState, detail: servedByPortPilot ? 'answered by the PortPilot proxy' : anyReachable ? 'answered by something else' : 'no response to inspect' },
    },
    nextSteps,
    checkedAt: new Date().toISOString(),
  };
}
