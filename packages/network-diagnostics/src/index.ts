import { execFile } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import os from 'node:os';
import { nowIso, type NetworkDiagnostics } from '@portpilot/shared';

const IS_WIN = process.platform === 'win32';

function run(cmd: string, args: string[], timeoutMs = 8000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      resolve(String(stdout ?? ''));
    });
  });
}

function isPrivateIp(ip: string): boolean {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/** Detect the default gateway from the OS routing table (best effort). */
export async function detectDefaultGateway(): Promise<string | null> {
  if (IS_WIN) {
    const out = await run('route', ['print', '-4']);
    // "0.0.0.0 0.0.0.0 192.168.1.1 ..."
    const m = out.match(/0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
  }
  const out = await run('ip', ['route', 'show', 'default']);
  const m = out.match(/default via (\d+\.\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

function httpsGet(url: string, timeoutMs = 6000): Promise<{ ok: boolean; body: string | null; error?: string }> {
  return new Promise((resolve) => {
    const lib = url.startsWith('http:') ? http : https;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ ok: (res.statusCode ?? 500) < 400, body: body.trim() }));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, body: null, error: 'timeout' });
    });
    req.on('error', (err) => resolve({ ok: false, body: null, error: err.message }));
  });
}

/**
 * Attempts to obtain the router's WAN IP from the gateway's UPnP/ICSC info.
 * Most consumer routers do not expose this without UPnP; failure is normal and
 * reported as "unknown" — never conclusive.
 */
export async function detectRouterWanIp(gateway: string | null): Promise<string | null> {
  if (!gateway) return null;
  try {
    const body = await new Promise<string | null>((resolve) => {
      const req = http.request(
        {
          host: gateway,
          port: 5000,
          path: '/upnp/control/WANIPConn1',
          method: 'POST',
          timeout: 2500,
          headers: { 'content-type': 'text/xml; charset="utf-8"', SOAPAction: '"urn:schemas-upnp-org:service:WANIPConnection:1#GetExternalIPAddress"' },
        },
        (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve(b));
        },
      );
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.on('error', () => resolve(null));
      req.end(
        '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:GetExternalIPAddress xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1"/></s:Body></s:Envelope>',
      );
    });
    if (!body) return null;
    const m = body.match(/<NewExternalIPAddress>(\d+\.\d+\.\d+\.\d+)<\/NewExternalIPAddress>/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Full network diagnostics for the Public Access module.
 *
 * Every field reports honest uncertainty: when the router WAN address cannot
 * be obtained, CGNAT status is 'inconclusive' — never a fabricated verdict.
 */
export async function runNetworkDiagnostics(opts: {
  publicIpCheckUrl?: string;
  knownPorts?: { port: number; label: string }[];
  portCheck?: (port: number) => Promise<boolean>;
  publicHostnameConfigured?: boolean;
} = {}): Promise<NetworkDiagnostics> {
  const notes: string[] = [];
  const interfaces = os.networkInterfaces();
  const localAddresses: NetworkDiagnostics['localAddresses'] = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const a of addrs ?? []) {
      if (!a.internal) {
        const fam = String(a.family);
        localAddresses.push({ name, address: a.address, family: fam === 'IPv4' || fam === '4' ? 'IPv4' : 'IPv6' });
      }
    }
  }

  const defaultGateway = await detectDefaultGateway();
  if (!defaultGateway) notes.push('Default gateway could not be determined on this machine.');

  const connectivity = await httpsGet(opts.publicIpCheckUrl ?? 'https://api.ipify.org');
  const internetConnectivity: NetworkDiagnostics['internetConnectivity'] = connectivity.ok ? 'online' : connectivity.error ? 'offline' : 'unknown';
  const publicIp = connectivity.ok && /^\d+\.\d+\.\d+\.\d+$/.test(connectivity.body ?? '') ? connectivity.body : null;
  if (!publicIp) notes.push('Public IP could not be verified (no internet access, or the check service is unreachable). Nothing about public reachability can be concluded.');

  const routerWanIp = await detectRouterWanIp(defaultGateway);
  if (!routerWanIp) notes.push('Router WAN IP could not be obtained (UPnP is often disabled). CGNAT detection is INCONCLUSIVE — a definitive answer needs the router admin page.');

  let behindNat: boolean | null = null;
  let cgnatSuspected: boolean | null = null;
  let cgnatConfidence: NetworkDiagnostics['cgnatConfidence'] = 'inconclusive';
  if (routerWanIp && publicIp) {
    behindNat = routerWanIp !== publicIp;
    if (isPrivateIp(routerWanIp) && routerWanIp !== publicIp) {
      cgnatSuspected = true;
      cgnatConfidence = 'likely';
      notes.push('The router WAN address is a private address, which is consistent with CGNAT or double-NAT. Direct inbound hosting is likely unavailable.');
    } else if (!isPrivateIp(routerWanIp)) {
      cgnatSuspected = behindNat && isPrivateIp(publicIp) ? true : false;
      cgnatConfidence = behindNat ? 'likely' : 'unlikely';
    }
  } else if (routerWanIp && isPrivateIp(routerWanIp)) {
    cgnatSuspected = true;
    cgnatConfidence = 'likely';
    behindNat = true;
    notes.push('The router WAN address is private (RFC1918): this connection is behind NAT and possibly CGNAT.');
  }

  const listeningPorts: NetworkDiagnostics['listeningPorts'] = [];
  if (opts.knownPorts && opts.portCheck) {
    for (const p of opts.knownPorts) {
      const free = await opts.portCheck(p.port);
      if (!free) listeningPorts.push(p);
    }
  }

  let inboundPossible: NetworkDiagnostics['inboundPossible'] = 'unknown';
  if (cgnatConfidence === 'likely') inboundPossible = 'unlikely';
  else if (routerWanIp && !isPrivateIp(routerWanIp)) {
    inboundPossible = 'possible';
    notes.push('A public router WAN address was observed. Inbound connectivity MAY be possible after configuring port forwarding and the firewall — it must still be verified externally.');
  }

  return {
    localAddresses,
    defaultGateway,
    internetConnectivity,
    publicIp,
    routerWanIp,
    behindNat,
    cgnatSuspected,
    cgnatConfidence,
    inboundPossible,
    listeningPorts,
    portForwardingConfigured: null,
    publicHostnameConfigured: opts.publicHostnameConfigured ?? false,
    notes,
    checkedAt: nowIso(),
  };
}
