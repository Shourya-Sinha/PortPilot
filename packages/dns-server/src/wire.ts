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

export function buildResponse(
  query: DnsMessage,
  answers: { name: string; type: number; ttl: number; rdata: Buffer }[],
  rcode: number,
): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.id, 0);
  // QR=1, Opcode=0, AA=1, TC=0, RD copied from query, RA=0, Z=0, RCODE
  const rd = (query.flags >> 8) & 0x01;
  const flags = 0x8400 | (rd << 8) | (rcode & 0x0f);
  header.writeUInt16BE(flags, 2);
  header.writeUInt16BE(query.questions.length, 4);
  header.writeUInt16BE(answers.length, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);

  const qParts: Buffer[] = [];
  for (const q of query.questions) {
    const name = encodeName(q.name);
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(q.type, 0);
    tail.writeUInt16BE(q.class, 2);
    qParts.push(name, tail);
  }

  const aParts: Buffer[] = [];
  for (const a of answers) {
    // Use compression pointer to the question name (offset 12).
    const namePtr = Buffer.from([0xc0, 0x0c]);
    const fixed = Buffer.alloc(10);
    fixed.writeUInt16BE(a.type, 0);
    fixed.writeUInt16BE(CLASS_IN, 2);
    fixed.writeUInt32BE(a.ttl, 4);
    fixed.writeUInt16BE(a.rdata.length, 8);
    aParts.push(namePtr, fixed, a.rdata);
  }

  return Buffer.concat([header, ...qParts, ...aParts]);
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
