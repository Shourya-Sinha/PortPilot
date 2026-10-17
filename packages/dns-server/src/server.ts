import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';
import {
  buildResponse,
  ipv4ToRdata,
  nameToRdata,
  parseQuery,
  soaToRdata,
  RCODE_FORMERR,
  RCODE_NXDOMAIN,
  RCODE_NOTIMP,
  RCODE_REFUSED,
  TYPE_A,
  TYPE_AAAA,
  TYPE_ANY,
  TYPE_NS,
  TYPE_SOA,
  TYPE_AXFR,
  TYPE_IXFR,
  CLASS_IN,
  type DnsQuestion,
  type ResourceRecord,
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
  /**
   * Primary nameserver name published in SOA/NS, e.g. `ns1.example.com`.
   * Without it the zone is still answered but is not a valid delegation target.
   */
  nsName?: string;
  /** RNAME field of the SOA (admin mailbox encoded as a name). */
  hostmaster?: string;
  /** Start of authority serial. Defaults to a date-derived value. */
  soaSerial?: number;
  /** Listen for TCP as well (required for public authoritative DNS). */
  tcp?: boolean;
  /** Enable `*.<zone>` wildcard answers from a configured wildcard address. */
  wildcardAddress?: string | null;
  /** Allow AXFR from these client addresses (empty = refuse all transfers). */
  allowAxfrFrom?: string[];
  /** Called on each query for logging/diagnostics. */
  onQuery?: (info: { name: string; type: string; client: string; rcode: number; answer?: string }) => void;
}

const UDP_MAX = 512;

/**
 * PortPilot DNS server.
 *
 * Two modes share one implementation:
 *
 *  - **LAN / local** (default): loopback, UDP, answers `<name>.<zone>` and
 *    `*.localhost` for machines explicitly pointed at it.
 *  - **Authoritative** (opt-in): add SOA + NS records, listen on TCP as well,
 *    answer wildcards, and return SOA in the authority section for NXDOMAIN /
 *    NODATA as RFC 1034 requires. That is what a registrar delegation needs.
 *
 * It is still **not** a recursive resolver: out-of-zone questions are REFUSED
 * (RA=0), so it cannot be abused as an open resolver.
 */
export class DnsServer {
  private socket: dgram.Socket | null = null;
  private tcpServer: net.Server | null = null;
  private readonly tcpSockets = new Set<net.Socket>();
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

  get tcpRunning(): boolean {
    return this.tcpServer !== null;
  }

  /** True when the zone publishes the records a delegation requires. */
  get authoritative(): boolean {
    return Boolean(this.soaRecord() && this.nsRecords().length > 0);
  }

  setRecord(name: string, address: string, ttl?: number): void {
    const normalized = name.toLowerCase().replace(/\.$/, '');
    this.records.set(normalized, { name: normalized, address, ttl: ttl ?? this.opts.ttl });
  }

  /** Publish `<zone>` and `*.<zone>` at once — the usual public setup. */
  setWildcard(address: string, ttl?: number): void {
    this.setRecord(this.opts.zone, address, ttl);
    this.setRecord(`*.${this.opts.zone}`, address, ttl);
  }

  setNsName(nsName: string): void {
    this.opts.nsName = nsName.toLowerCase().replace(/\.$/, '');
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

  // ---------- SOA / NS ----------

  private soaRecord(): ResourceRecord | null {
    const ns = this.opts.nsName;
    if (!ns) return null;
    const serial = this.opts.soaSerial ?? Number(new Date().toISOString().slice(0, 10).replace(/-/g, ''));
    return {
      name: this.opts.zone,
      type: TYPE_SOA,
      ttl: this.opts.ttl,
      rdata: soaToRdata({
        mname: ns,
        rname: (this.opts.hostmaster ?? `hostmaster.${this.opts.zone}`).toLowerCase(),
        serial,
        refresh: 3600,
        retry: 600,
        expire: 604800,
        minimum: this.opts.ttl,
      }),
    };
  }

  private nsRecords(): ResourceRecord[] {
    const ns = this.opts.nsName;
    if (!ns) return [];
    return [{ name: this.opts.zone, type: TYPE_NS, ttl: this.opts.ttl, rdata: nameToRdata(ns) }];
  }

  /**
   * Exact record, then the closest-encloser wildcard (RFC 4592).
   *
   * `*.example.com` matches `a.example.com` *and* `a.b.example.com` as long as
   * no closer name exists. Searching only the immediate parent would break
   * multi-label names, which is exactly what people use for per-project hosts.
   */
  private lookup(name: string): DnsRecord | null {
    const exact = this.records.get(name);
    if (exact) return exact;
    // The apex is matched exactly, never through a wildcard.
    if (name === this.opts.zone) return null;

    // Walk from the immediate parent up to the zone apex. The first ancestor
    // that actually exists stops the search (RFC 4592 closest encloser); the
    // wildcard at that level is the only one that can apply.
    const zone = this.opts.zone;
    let ancestor = name.split('.').slice(1).join('.');
    while (ancestor && (ancestor === zone || ancestor.endsWith(`.${zone}`))) {
      const wildcard = this.records.get(`*.${ancestor}`);
      if (wildcard) return wildcard;
      if (this.records.has(ancestor)) return null;
      if (ancestor === zone) break;
      ancestor = ancestor.split('.').slice(1).join('.');
    }
    return null;
  }

  private nameExists(name: string): boolean {
    if (this.records.has(name)) return true;
    // Any record below this name means the name exists as an empty non-terminal.
    for (const key of this.records.keys()) if (key.endsWith(`.${name}`)) return true;
    if (this.records.has(`*.${name}`)) return true;
    return name === this.opts.zone;
  }

  // ---------- listeners ----------

  async listen(): Promise<number> {
    const udpPort = await new Promise<number>((resolve, reject) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socket.once('error', reject);
      socket.on('message', (msg, rinfo) => {
        const response = this.answer(msg, `${rinfo.address}:${rinfo.port}`, 'udp');
        if (response) socket.send(response, rinfo.port, rinfo.address);
      });
      socket.bind(this.opts.port, this.opts.host, () => {
        this.socket = socket;
        const addr = socket.address();
        this.boundPort = addr.port;
        this.opts.logger?.info(`DNS server listening on ${addr.address}:${addr.port} (zone: ${this.opts.zone})`);
        resolve(addr.port);
      });
    });

    if (this.opts.tcp) {
      await new Promise<void>((resolve) => {
        const server = net.createServer((sock) => this.handleTcp(sock));
        server.once('error', (err) => {
          // TCP is required for large answers and zone transfers, but a failure
          // must not take the UDP listener (and the whole LAN feature) down.
          this.opts.logger?.warn(`DNS TCP listener failed on ${this.opts.host}:${udpPort}: ${String(err)}`);
          resolve();
        });
        server.listen(udpPort, this.opts.host, () => {
          this.tcpServer = server;
          this.opts.logger?.info(`DNS TCP listener on ${this.opts.host}:${udpPort}`);
          resolve();
        });
      });
    }

    return udpPort;
  }

  async close(): Promise<void> {
    for (const sock of this.tcpSockets) sock.destroy();
    this.tcpSockets.clear();
    if (this.tcpServer) {
      await new Promise<void>((resolve) => this.tcpServer!.close(() => resolve()));
      this.tcpServer = null;
    }
    if (this.socket) {
      await new Promise<void>((resolve) => this.socket!.close(() => resolve()));
      this.socket = null;
    }
  }

  private handleTcp(sock: net.Socket): void {
    this.tcpSockets.add(sock);
    sock.on('close', () => this.tcpSockets.delete(sock));
    sock.on('error', () => sock.destroy());
    let buffer = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const len = buffer.readUInt16BE(0);
        if (buffer.length < 2 + len) return;
        const msg = buffer.subarray(2, 2 + len);
        buffer = buffer.subarray(2 + len);
        const response = this.answer(msg, `${sock.remoteAddress}:${sock.remotePort}`, 'tcp');
        if (response) {
          const prefix = Buffer.alloc(2);
          prefix.writeUInt16BE(response.length, 0);
          sock.write(Buffer.concat([prefix, response]));
        }
      }
    });
  }

  // ---------- query handling ----------

  private answer(msg: Buffer, client: string, transport: 'udp' | 'tcp'): Buffer | null {
    const query = parseQuery(msg);
    if (!query || query.questions.length === 0) return null;
    const q = query.questions[0];
    const qname = q.name.toLowerCase();

    const result = this.resolveQuestion(q, client);
    const soa = this.soaRecord();

    // RFC 1034 §4.3.1: NXDOMAIN and NODATA carry the zone SOA in authority so
    // resolvers can negative-cache. Not needed when the zone has no SOA yet.
    const authority = result.negative && soa ? [soa] : [];

    let answers = result.answers;
    let truncated = false;
    if (transport === 'udp') {
      const size = this.estimateSize(query.questions[0], answers, authority);
      if (size > UDP_MAX) {
        // Signal TC so the client retries over TCP instead of receiving a
        // silently incomplete answer.
        truncated = true;
        answers = [];
      }
    }

    const response = buildResponse(query, answers, result.rcode, {
      authority,
      truncated,
      authoritative: result.rcode === 0 || result.rcode === RCODE_NXDOMAIN,
    });

    const entry = { ts: new Date().toISOString(), name: qname, type: typeName(q.type), client, rcode: result.rcode };
    this.queries.push(entry);
    if (this.queries.length > 500) this.queries.splice(0, this.queries.length - 500);
    this.opts.onQuery?.({ ...entry, answer: result.summary });
    this.opts.logger?.debug(`DNS ${entry.type} ${qname} -> rcode ${result.rcode}${result.summary ? ` ${result.summary}` : ''} (${client}/${transport})${truncated ? ' [truncated]' : ''}`);
    return response;
  }

  private estimateSize(question: DnsQuestion | undefined, answers: ResourceRecord[], authority: ResourceRecord[]): number {
    const qlen = question ? question.name.length + 6 : 0;
    const rr = (r: ResourceRecord) => r.rdata.length + 12;
    return 12 + qlen + answers.reduce((n, r) => n + rr(r), 0) + authority.reduce((n, r) => n + rr(r), 0);
  }

  /**
   * Full zone contents for an allowed secondary: SOA first, every record, SOA
   * last (RFC 5936 §2.2). Only reachable from allowAxfrFrom.
   */
  private zoneTransfer(): { rcode: number; answers: ResourceRecord[]; negative: boolean; summary?: string } {
    const soa = this.soaRecord();
    if (!soa) return { rcode: RCODE_REFUSED, answers: [], negative: false };
    const records: ResourceRecord[] = [soa, ...this.nsRecords()];
    for (const rec of this.records.values()) {
      records.push({ name: rec.name, type: TYPE_A, ttl: rec.ttl, rdata: ipv4ToRdata(rec.address) });
    }
    records.push(soa);
    return { rcode: 0, answers: records, negative: false, summary: `${records.length} records` };
  }

  private resolveQuestion(
    q: DnsQuestion,
    client: string,
  ): { rcode: number; answers: ResourceRecord[]; negative: boolean; summary?: string } {
    const qname = q.name.toLowerCase();

    // Zone transfers (AXFR 252, IXFR 251). Only from explicitly allowed peers;
    // everything else is REFUSED so the zone cannot be dumped by strangers.
    if (q.type === TYPE_AXFR || q.type === TYPE_IXFR) {
      const allowed = (this.opts.allowAxfrFrom ?? []).includes(client.split(':')[0]);
      if (!allowed) return { rcode: RCODE_REFUSED, answers: [], negative: false };
      return this.zoneTransfer();
    }

    if (!this.inZone(qname)) {
      // Not a recursive resolver. Refusing keeps this from becoming an open
      // resolver / amplification source.
      return { rcode: RCODE_REFUSED, answers: [], negative: false };
    }

    // SOA / NS at (or below) the zone apex.
    if (q.type === TYPE_SOA || q.type === TYPE_ANY) {
      const soa = this.soaRecord();
      if (qname === this.opts.zone && soa) {
        return { rcode: 0, answers: [{ name: qname, type: TYPE_SOA, ttl: soa.ttl, rdata: soa.rdata }], negative: false, summary: 'SOA' };
      }
    }
    if (q.type === TYPE_NS || q.type === TYPE_ANY) {
      const ns = this.nsRecords();
      if (qname === this.opts.zone && ns.length > 0) {
        return { rcode: 0, answers: ns.map((r) => ({ ...r, name: qname })), negative: false, summary: 'NS' };
      }
    }

    if (q.type !== TYPE_A && q.type !== TYPE_AAAA && q.type !== TYPE_ANY && q.type !== TYPE_NS && q.type !== TYPE_SOA) {
      return { rcode: RCODE_NOTIMP, answers: [], negative: false };
    }

    const rec = this.lookup(qname);
    if (rec) {
      if (q.type === TYPE_AAAA) {
        // No AAAA records configured: NOERROR with an empty answer (NODATA).
        return { rcode: 0, answers: [], negative: true };
      }
      return {
        rcode: 0,
        answers: [{ name: qname, type: TYPE_A, ttl: rec.ttl, rdata: ipv4ToRdata(rec.address) }],
        negative: false,
        summary: rec.address,
      };
    }

    // The name exists but has no record of this type (empty non-terminal): NODATA.
    if (this.nameExists(qname)) return { rcode: 0, answers: [], negative: true };

    return { rcode: RCODE_NXDOMAIN, answers: [], negative: true };
  }
}

function typeName(t: number): string {
  switch (t) {
    case TYPE_A:
      return 'A';
    case TYPE_AAAA:
      return 'AAAA';
    case TYPE_NS:
      return 'NS';
    case TYPE_SOA:
      return 'SOA';
    case TYPE_ANY:
      return 'ANY';
    case TYPE_AXFR:
      return 'AXFR';
    case TYPE_IXFR:
      return 'IXFR';
    default:
      return String(t);
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

/** SOA/NS helpers re-exported for tests and the DNS settings API. */
export { TYPE_SOA, TYPE_NS, CLASS_IN, RCODE_FORMERR };
