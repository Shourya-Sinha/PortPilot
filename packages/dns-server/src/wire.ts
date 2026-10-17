/**
 * Minimal DNS wire-format codec (RFC 1035) for the PortPilot educational DNS
 * module: A-record questions/answers, name compression, and standard header
 * flags. Deliberately dependency-free and small enough to audit.
 */

export interface DnsQuestion {
  name: string;
  type: number;
  class: number;
}

export interface DnsMessage {
  id: number;
  flags: number;
  questions: DnsQuestion[];
  answers: { name: string; type: number; class: number; ttl: number; rdata: Buffer }[];
}

export const TYPE_A = 1;
export const TYPE_NS = 2;
export const TYPE_CNAME = 5;
export const TYPE_SOA = 6;
export const TYPE_AAAA = 28;
export const TYPE_ANY = 255;
export const TYPE_IXFR = 251;
export const TYPE_AXFR = 252;
export const CLASS_IN = 1;

export const RCODE_NOERROR = 0;
export const RCODE_FORMERR = 1;
export const RCODE_SERVFAIL = 2;
export const RCODE_NXDOMAIN = 3;
export const RCODE_NOTIMP = 4;
export const RCODE_REFUSED = 5;

function encodeName(name: string): Buffer {
  const labels = name.replace(/\.$/, '').split('.').filter((l) => l.length > 0);
  const parts: Buffer[] = [];
  for (const label of labels) {
    const buf = Buffer.from(label, 'ascii');
    parts.push(Buffer.from([buf.length]), buf);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function readName(buf: Buffer, offset: number): { name: string; next: number } {
  const labels: string[] = [];
  let pos = offset;
  let jumped = false;
  let next = offset;
  let guard = 0;
  while (guard++ < 128) {
    if (pos >= buf.length) throw new Error('Truncated name');
    const len = buf[pos];
    if (len === 0) {
      if (!jumped) next = pos + 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new Error('Truncated pointer');
      const ptr = ((len & 0x3f) << 8) | buf[pos + 1];
      if (!jumped) next = pos + 2;
      pos = ptr;
      jumped = true;
      continue;
    }
    labels.push(buf.subarray(pos + 1, pos + 1 + len).toString('ascii'));
    pos += 1 + len;
    if (!jumped) next = pos;
  }
  return { name: labels.join('.').toLowerCase(), next };
}

export function parseQuery(buf: Buffer): DnsMessage | null {
  try {
    if (buf.length < 12) return null;
    const id = buf.readUInt16BE(0);
    const flags = buf.readUInt16BE(2);
    const qdcount = buf.readUInt16BE(4);
    let offset = 12;
    const questions: DnsQuestion[] = [];
    for (let i = 0; i < qdcount; i++) {
      const { name, next } = readName(buf, offset);
      offset = next;
      if (offset + 4 > buf.length) return null;
      const type = buf.readUInt16BE(offset);
      const qclass = buf.readUInt16BE(offset + 2);
      offset += 4;
      questions.push({ name, type, class: qclass });
    }
    return { id, flags, questions, answers: [] };
  } catch {
    return null;
  }
}

export type ResourceRecord = { name: string; type: number; ttl: number; rdata: Buffer };

export interface BuildOptions {
  /** Extra records for the authority section (e.g. SOA on NXDOMAIN/NODATA). */
  authority?: ResourceRecord[];
  /** Set the TC bit: the answer did not fit in the UDP size limit. */
  truncated?: boolean;
  /** Clear the AA bit (e.g. for REFUSED/NOTIMP, which are not authoritative). */
  authoritative?: boolean;
}

export function buildResponse(
  query: DnsMessage,
  answers: ResourceRecord[],
  rcode: number,
  opts: BuildOptions = {},
): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.id, 0);
  // QR=1, Opcode=0, AA (authoritative answer), TC (truncated), RD copied from
  // the query, RA=0 (this is not a recursive resolver), Z=0, RCODE.
  const rd = (query.flags >> 8) & 0x01;
  const aa = opts.authoritative === false ? 0 : 1;
  const tc = opts.truncated ? 1 : 0;
  const flags = 0x8000 | (aa << 10) | (tc << 9) | (rd << 8) | (rcode & 0x0f);
  header.writeUInt16BE(flags, 2);
  header.writeUInt16BE(query.questions.length, 4);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(opts.authority?.length ?? 0, 8);
  header.writeUInt16BE(0, 10);

  const qParts: Buffer[] = [];
  for (const q of query.questions) {
    const name = encodeName(q.name);
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(q.type, 0);
    tail.writeUInt16BE(q.class, 2);
    qParts.push(name, tail);
  }

  // Compression pointer to the question name (offset 12) when the record name
  // matches the question; otherwise encode the name in full.
  const questionName = query.questions[0]?.name ?? '';
  const encodeRecord = (a: ResourceRecord): Buffer[] => {
    const name = a.name.toLowerCase() === questionName ? Buffer.from([0xc0, 0x0c]) : encodeName(a.name);
    const fixed = Buffer.alloc(10);
    fixed.writeUInt16BE(a.type, 0);
    fixed.writeUInt16BE(CLASS_IN, 2);
    fixed.writeUInt32BE(a.ttl >>> 0, 4);
    fixed.writeUInt16BE(a.rdata.length, 8);
    return [name, fixed, a.rdata];
  };

  const aParts: Buffer[] = [];
  for (const a of answers) aParts.push(...encodeRecord(a));
  const nParts: Buffer[] = [];
  for (const n of opts.authority ?? []) nParts.push(...encodeRecord(n));

  return Buffer.concat([header, ...qParts, ...aParts, ...nParts]);
}

/** Encode a (possibly compressed-free) domain name as rdata for NS/CNAME/SOA. */
export function nameToRdata(name: string): Buffer {
  return encodeName(name);
}

export interface SoaFields {
  mname: string;
  rname: string;
  serial: number;
  refresh: number;
  retry: number;
  expire: number;
  minimum: number;
}

/**
 * SOA rdata (RFC 1035 §3.3.13). Compression inside rdata is legal but optional;
 * we emit uncompressed names, which every resolver accepts and which keeps this
 * codec simple enough to audit.
 */
export function soaToRdata(soa: SoaFields): Buffer {
  const head = Buffer.concat([encodeName(soa.mname), encodeName(soa.rname)]);
  const tail = Buffer.alloc(20);
  tail.writeUInt32BE(soa.serial >>> 0, 0);
  tail.writeUInt32BE(soa.refresh >>> 0, 4);
  tail.writeUInt32BE(soa.retry >>> 0, 8);
  tail.writeUInt32BE(soa.expire >>> 0, 12);
  tail.writeUInt32BE(soa.minimum >>> 0, 16);
  return Buffer.concat([head, tail]);
}

export function ipv4ToRdata(ip: string): Buffer {
  const parts = ip.split('.');
  if (parts.length !== 4) throw new Error(`Invalid IPv4: ${ip}`);
  const nums = parts.map((p) => {
    if (!/^\d{1,3}$/.test(p)) throw new Error(`Invalid IPv4: ${ip}`);
    const n = Number(p);
    if (n < 0 || n > 255) throw new Error(`Invalid IPv4: ${ip}`);
    return n;
  });
  return Buffer.from(nums);
}
