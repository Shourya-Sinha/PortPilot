import dgram from 'node:dgram';
import dns from 'node:dns';
import {
  buildResponse,
  ipv4ToRdata,
  parseQuery,
  RCODE_NXDOMAIN,
  RCODE_NOTIMP,
  RCODE_REFUSED,
  TYPE_A,
  TYPE_AAAA,
  CLASS_IN,
} from './wire.js';
import type { Logger } from '@portpilot/shared';

export interface DnsRecord {
  name: string;
  address: string;
  ttl: number;
}

export interface DnsServerOptions {
  host?: string;
  port: number;
  zone: string;
  ttl?: number;
  logger?: Logger;
  /** Called on each query for logging/diagnostics. */
  onQuery?: (info: { name: string; type: string; client: string; rcode: number; answer?: string }) => void;
}

/**
 * PortPilot local DNS server (educational + functional).
 *
 * - Authoritative-style responses for a configurable local zone.
 * - A-records only; no recursion (RA=0). It is NOT an open resolver.
 * - Binds to 127.0.0.1 by default. Port 53 requires elevation; 5353 does not.
 *
 * IMPORTANT (documented in docs/networking-architecture.md):
 * - Only clients pointed at this resolver see these names.
 * - DNS records do not create network connectivity, public IPs, or bypass CGNAT.
 * - Names like home.arpa are for private networks only.
 */
export class DnsServer {
  private socket: dgram.Socket | null = null;
  private boundPort: number | null = null;
  private readonly opts: Required<Pick<DnsServerOptions, 'host' | 'ttl'>> & DnsServerOptions;
  private records = new Map<string, DnsRecord>();
  readonly queries: { ts: string; name: string; type: string; client: string; rcode: number }[] = [];

  constructor(opts: DnsServerOptions) {
    this.opts = { host: '127.0.0.1', ttl: opts.ttl ?? 60, ...opts };
    this.opts.zone = this.opts.zone.toLowerCase().replace(/\.$/, '');
  }

  get zone(): string {
    return this.opts.zone;
  }

  /** The actual bound UDP port (may differ from the requested one when 0 was requested). */
  get port(): number {
    return this.boundPort ?? this.opts.port;
  }

  get running(): boolean {
    return this.socket !== null;
  }

  setRecord(name: string, address: string, ttl?: number): void {
    const normalized = name.toLowerCase().replace(/\.$/, '');
    this.records.set(normalized, { name: normalized, address, ttl: ttl ?? this.opts.ttl });
  }

  removeRecord(name: string): void {
    this.records.delete(name.toLowerCase().replace(/\.$/, ''));
  }

  listRecords(): DnsRecord[] {
    return [...this.records.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  inZone(name: string): boolean {
    const n = name.toLowerCase().replace(/\.$/, '');
    // The configured zone, plus the RFC 6761 ".localhost" special-use suffix
    // (the OS resolves it to loopback anyway; answering here keeps the zone
    // data consistent when clients point at this resolver explicitly).
    return n === this.opts.zone || n.endsWith(`.${this.opts.zone}`) || n === 'localhost' || n.endsWith('.localhost');
  }

  async listen(): Promise<number> {
    return await new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socket.once('error', reject);
      socket.on('message', (msg, rinfo) => this.handleMessage(msg, rinfo));
      socket.bind(this.opts.port, this.opts.host, () => {
        this.socket = socket;
        const addr = socket.address();
        this.boundPort = addr.port;
        this.opts.logger?.info(`DNS server listening on ${addr.address}:${addr.port} (zone: ${this.opts.zone})`);
        resolve(addr.port);
      });
    });
  }

  async close(): Promise<void> {
    if (!this.socket) return;
    await new Promise<void>((resolve) => this.socket!.close(() => resolve()));
    this.socket = null;
  }

  private handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    const query = parseQuery(msg);
    if (!query || query.questions.length === 0) return;
    const q = query.questions[0];
    const qname = q.name.toLowerCase();

    let response: Buffer;
    let rcode = 0;
    let answerAddr: string | undefined;

    if (!this.inZone(qname)) {
      // Out-of-zone queries are refused: this is not a recursive resolver.
      rcode = RCODE_REFUSED;
      response = buildResponse(query, [], rcode);
    } else if (q.type !== TYPE_A && q.type !== TYPE_AAAA) {
      rcode = RCODE_NOTIMP;
      response = buildResponse(query, [], rcode);
    } else {
      const rec = this.records.get(qname) ?? this.records.get(`${qname}.`);
      if (rec && q.type === TYPE_A) {
        answerAddr = rec.address;
        rcode = 0;
        response = buildResponse(query, [{ name: qname, type: TYPE_A, ttl: rec.ttl, rdata: ipv4ToRdata(rec.address) }], 0);
      } else if (rec && q.type === TYPE_AAAA) {
        // No AAAA records configured: NOERROR with empty answer (nodata).
        rcode = 0;
        response = buildResponse(query, [], 0);
      } else {
        rcode = RCODE_NXDOMAIN;
        response = buildResponse(query, [], RCODE_NXDOMAIN);
      }
    }

    const entry = { ts: new Date().toISOString(), name: qname, type: q.type === TYPE_A ? 'A' : q.type === TYPE_AAAA ? 'AAAA' : String(q.type), client: `${rinfo.address}:${rinfo.port}`, rcode };
    this.queries.push(entry);
    if (this.queries.length > 500) this.queries.splice(0, this.queries.length - 500);
    this.opts.onQuery?.({ ...entry, answer: answerAddr });
    this.opts.logger?.debug(`DNS ${entry.type} ${qname} -> rcode ${rcode}${answerAddr ? ` ${answerAddr}` : ''} (${entry.client})`);

    this.socket?.send(response, rinfo.port, rinfo.address);
  }
}

/**
 * Test utility: resolve a name through the PortPilot DNS server using Node's
 * resolver pointed at the local listener (used by `npm run doctor` and the
 * dashboard "DNS lookup" button).
 */
export async function lookupViaDns(name: string, serverHost: string, serverPort: number): Promise<{ ok: boolean; address: string | null; error?: string }> {
  return await new Promise((resolve) => {
    const resolver = new dns.promises.Resolver();
    resolver.setServers([`${serverHost}:${serverPort}`]);
    const timer = setTimeout(() => resolve({ ok: false, address: null, error: 'DNS lookup timed out' }), 5000);
    resolver
      .resolve4(name)
      .then((addrs) => {
        clearTimeout(timer);
        resolve({ ok: true, address: addrs[0] ?? null });
      })
      .catch((err: Error) => {
        clearTimeout(timer);
        resolve({ ok: false, address: null, error: err.message });
      });
  });
}
