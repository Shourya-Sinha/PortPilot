import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getPaths, ensureDirs } from '@portpilot/shared';

/** Minimal .env loader (no dependency). Existing process env wins. */
export function loadDotEnv(root: string): void {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    if (process.env[key] !== undefined) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export interface AppConfig {
  host: string;
  port: number;
  proxyHost: string;
  proxyPort: number;
  dnsEnabled: boolean;
  dnsPort: number;
  dnsHost: string;
  dnsZone: string;
  dnsTtl: number;
  publicIpCheckUrl: string;
  authToken: string;
  isLoopback: boolean;
  root: string;
  /** Restart applications that were running before a PortPilot restart. */
  autostart?: boolean;
  /** GitHub polling interval in ms (0 disables the poller). */
  pollIntervalMs?: number;
  /** Primary nameserver name published in SOA/NS (enables authoritative mode). */
  dnsNsName?: string | null;
  /** Public IP published for the zone apex and wildcard. */
  dnsPublicIp?: string | null;
  /** Listen on TCP as well (required for public authoritative DNS). */
  dnsTcp?: boolean;
}

export function loadConfig(): AppConfig {
  const paths = getPaths();
  ensureDirs(paths);
  loadDotEnv(paths.root);

  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 4300);
  const proxyHost = process.env.PROXY_HOST ?? '127.0.0.1';
  const proxyPort = Number(process.env.PROXY_PORT ?? 8080);
  const dnsEnabled = (process.env.DNS_ENABLED ?? 'false').toLowerCase() === 'true';
  const isLoopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';

  let authToken = process.env.PORTPILOT_AUTH_TOKEN ?? '';
  if (!authToken && fs.existsSync(paths.sessionTokenFile)) {
    authToken = fs.readFileSync(paths.sessionTokenFile, 'utf8').trim();
  }
  if (!authToken) {
    authToken = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(paths.sessionTokenFile, authToken, { mode: 0o600 });
  }

  if (!isLoopback && !process.env.PORTPILOT_AUTH_TOKEN) {
    // LAN exposure requires an explicitly configured token.
    // We keep running but warn loudly; non-loopback + no explicit token is a
    // misconfiguration the doctor will flag.
    console.warn('[PortPilot] WARNING: HOST is not loopback but PORTPILOT_AUTH_TOKEN is not set explicitly in .env. Set it before exposing the dashboard on a LAN.');
  }

  return {
    host,
    port,
    proxyHost,
    proxyPort,
    dnsEnabled,
    dnsPort: Number(process.env.DNS_PORT ?? 5353),
    dnsHost: process.env.DNS_HOST ?? '127.0.0.1',
    dnsZone: process.env.DNS_ZONE ?? 'portpilot.home.arpa',
    dnsTtl: Number(process.env.DNS_TTL ?? 60),
    publicIpCheckUrl: process.env.PUBLIC_IP_CHECK_URL ?? 'https://api.ipify.org',
    authToken,
    isLoopback,
    root: paths.root,
    autostart: (process.env.AUTOSTART ?? 'true').toLowerCase() !== 'false',
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 300_000),
    dnsNsName: process.env.DNS_NS_NAME?.trim() || null,
    dnsPublicIp: process.env.DNS_PUBLIC_IP?.trim() || null,
    dnsTcp: (process.env.DNS_TCP ?? 'false').toLowerCase() === 'true',
  };
}

export { getPaths };
