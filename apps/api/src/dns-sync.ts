import type { DnsServer } from '@portpilot/dns-server';
import type { AppConfig } from './config.js';

/**
 * Keeps the optional DNS module's zone in sync with the hostname table.
 *
 * The DNS server publishes two names per local hostname:
 *   <name>.localhost          (itself resolvable via RFC 6761 in browsers)
 *   <name>.<dnsZone>          (for clients explicitly pointed at this resolver)
 *
 * Before this helper existed, records were only loaded at process start, so a
 * freshly created project never appeared in the zone until PortPilot restarted.
 * Any code path that adds, renames or deletes a hostname must call these.
 */

function zoneAlias(hostname: string, cfg: AppConfig): string | null {
  if (!hostname.endsWith('.localhost')) return null;
  const label = hostname.slice(0, -'.localhost'.length);
  return label ? `${label}.${cfg.dnsZone}` : null;
}

export function syncDnsHostname(dns: DnsServer | null | undefined, cfg: AppConfig, hostname: string): void {
  if (!dns) return;
  const name = hostname.toLowerCase();
  dns.setRecord(name, '127.0.0.1', cfg.dnsTtl);
  const alias = zoneAlias(name, cfg);
  if (alias) dns.setRecord(alias, '127.0.0.1', cfg.dnsTtl);
}

export function removeDnsHostname(dns: DnsServer | null | undefined, cfg: AppConfig, hostname: string): void {
  if (!dns) return;
  const name = hostname.toLowerCase();
  dns.removeRecord(name);
  const alias = zoneAlias(name, cfg);
  if (alias) dns.removeRecord(alias);
}
