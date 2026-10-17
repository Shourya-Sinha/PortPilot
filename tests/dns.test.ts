import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import dgram from 'node:dgram';
import net from 'node:net';
import { DnsServer, lookupViaDns, parseQuery, buildResponse, ipv4ToRdata, TYPE_A, RCODE_NXDOMAIN } from '@portpilot/dns-server';

let server: DnsServer;
let port: number;

function buildQuery(name: string, id = 0x1234): Buffer {
  const labels = name.split('.').filter(Boolean);
  const parts: Buffer[] = [];
  for (const l of labels) {
    parts.push(Buffer.from([l.length]), Buffer.from(l, 'ascii'));
  }
  parts.push(Buffer.from([0]));
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2); // RD=1
  header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(TYPE_A, 0);
  tail.writeUInt16BE(1, 2);
  return Buffer.concat([header, ...parts, tail]);
}

function query(name: string, qport: number): Promise<{ msg: Buffer; rcode: number; answers: number }> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => {
      sock.close();
      reject(new Error('dns query timeout'));
    }, 4000);
    sock.on('message', (msg) => {
      clearTimeout(timer);
      sock.close();
      resolve({ msg, rcode: msg.readUInt16BE(2) & 0x0f, answers: msg.readUInt16BE(6) });
    });
    sock.send(buildQuery(name), qport, '127.0.0.1');
  });
}

beforeAll(async () => {
  server = new DnsServer({ host: '127.0.0.1', port: 0, zone: 'portpilot.test', ttl: 30 });
  // port 0 -> let OS assign; DnsServer stores requested port, so read from socket after listen.
  port = await server.listen();
  server.setRecord('app.portpilot.test', '127.0.0.1', 30);
  server.setRecord('web.portpilot.test', '127.0.0.2');
});

afterAll(async () => {
  await server.close();
});

describe('DNS wire codec', () => {
  it('parses a query and builds a response with an A answer', () => {
    const q = parseQuery(buildQuery('app.portpilot.test'));
    expect(q).not.toBeNull();
    expect(q!.questions[0].name).toBe('app.portpilot.test');
    const resp = buildResponse(q!, [{ name: 'app.portpilot.test', type: TYPE_A, ttl: 30, rdata: ipv4ToRdata('10.0.0.5') }], 0);
    expect(resp.readUInt16BE(2) & 0x8000).toBe(0x8000); // QR
    expect(resp.readUInt16BE(6)).toBe(1); // ANCOUNT
    // last 4 bytes are the IPv4 address
    expect([...resp.subarray(-4)]).toEqual([10, 0, 0, 5]);
  });

  it('encodes IPv4 rdata and rejects invalid addresses', () => {
    expect([...ipv4ToRdata('1.2.3.4')]).toEqual([1, 2, 3, 4]);
    expect(() => ipv4ToRdata('999.1.1.1')).toThrow();
  });
});

describe('DNS server (loopback, non-recursive)', () => {
  it('answers A queries inside the zone', async () => {
    const res = await query('app.portpilot.test', port);
    expect(res.rcode).toBe(0);
    expect(res.answers).toBe(1);
  });

  it('returns NXDOMAIN for unknown names inside the zone', async () => {
    const res = await query('missing.portpilot.test', port);
    expect(res.rcode).toBe(RCODE_NXDOMAIN);
  });

  it('REFUSES out-of-zone queries (no open resolver)', async () => {
    const res = await query('example.com', port);
    expect(res.rcode).toBe(5); // REFUSED
  });

  it('resolves via the Node resolver test utility', async () => {
    const res = await lookupViaDns('web.portpilot.test', '127.0.0.1', port);
    expect(res.ok).toBe(true);
    expect(res.address).toBe('127.0.0.2');
  });

  it('tracks query logs for diagnostics', () => {
    expect(server.queries.length).toBeGreaterThan(0);
    expect(server.queries[server.queries.length - 1].name).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Authoritative mode: the records a registrar delegation actually requires.
// ---------------------------------------------------------------------------
describe('DNS authoritative zone (delegable)', () => {
  let authServer: DnsServer;
  let authPort: number;
  const ZONE = 'anantainfratech.test';
  const NS = 'ns1.anantainfratech.test';
  const PUBLIC_IP = '203.0.113.10';

  function buildTypedQuery(name: string, type: number, id = 0x4242): Buffer {
    const labels = name.split('.').filter(Boolean);
    const parts: Buffer[] = [];
    for (const l of labels) parts.push(Buffer.from([l.length]), Buffer.from(l, 'ascii'));
    parts.push(Buffer.from([0]));
    const header = Buffer.alloc(12);
    header.writeUInt16BE(id, 0);
    header.writeUInt16BE(0x0100, 2);
    header.writeUInt16BE(1, 4);
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(type, 0);
    tail.writeUInt16BE(1, 2);
    return Buffer.concat([header, ...parts, tail]);
  }

  function udpAsk(name: string, type: number): Promise<{ msg: Buffer; rcode: number; answers: number; authority: number; aa: boolean }> {
    return new Promise((resolve, reject) => {
      const sock = dgram.createSocket('udp4');
      const timer = setTimeout(() => {
        sock.close();
        reject(new Error('timeout'));
      }, 4000);
      sock.on('message', (msg) => {
        clearTimeout(timer);
        sock.close();
        resolve({
          msg,
          rcode: msg.readUInt16BE(2) & 0x0f,
          answers: msg.readUInt16BE(6),
          authority: msg.readUInt16BE(8),
          aa: Boolean(msg.readUInt16BE(2) & 0x0400),
        });
      });
      sock.send(buildTypedQuery(name, type), authPort, '127.0.0.1');
    });
  }

  function tcpAsk(name: string, type: number): Promise<{ rcode: number; answers: number }> {
    return new Promise((resolve, reject) => {
      const query = buildTypedQuery(name, type);
      const prefix = Buffer.alloc(2);
      prefix.writeUInt16BE(query.length, 0);
      const sock = net.connect(authPort, '127.0.0.1', () => sock.write(Buffer.concat([prefix, query])));
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error('tcp timeout'));
      }, 4000);
      let buf = Buffer.alloc(0);
      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
          const len = buf.readUInt16BE(0);
          const msg = buf.subarray(2, 2 + len);
          clearTimeout(timer);
          sock.end();
          resolve({ rcode: msg.readUInt16BE(2) & 0x0f, answers: msg.readUInt16BE(6) });
        }
      });
      sock.on('error', reject);
    });
  }

  beforeAll(async () => {
    authServer = new DnsServer({
      host: '127.0.0.1',
      port: 0,
      zone: ZONE,
      ttl: 60,
      nsName: NS,
      tcp: true,
      allowAxfrFrom: [],
    });
    authPort = await authServer.listen();
    authServer.setWildcard(PUBLIC_IP, 60);
  });

  afterAll(async () => {
    await authServer.close();
  });

  it('reports itself as authoritative once SOA and NS exist', () => {
    expect(authServer.authoritative).toBe(true);
  });

  it('answers SOA at the zone apex', async () => {
    const res = await udpAsk(ZONE, 6);
    expect(res.rcode).toBe(0);
    expect(res.answers).toBe(1);
    expect(res.aa).toBe(true);
  });

  it('publishes NS records for the zone', async () => {
    const res = await udpAsk(ZONE, 2);
    expect(res.rcode).toBe(0);
    expect(res.answers).toBe(1);
  });

  it('answers the apex and every wildcard name with the public address', async () => {
    for (const name of [ZONE, `app.${ZONE}`, `anything.deep.${ZONE}`]) {
      const res = await udpAsk(name, TYPE_A);
      expect(res.rcode).toBe(0);
      expect(res.answers).toBe(1);
      expect([...res.msg.subarray(-4)]).toEqual([203, 0, 113, 10]);
    }
  });

  it('returns NXDOMAIN with the SOA in the authority section', async () => {
    // Remove the wildcard temporarily so a missing name really is NXDOMAIN.
    authServer.removeRecord(`*.${ZONE}`);
    const res = await udpAsk(`nope.${ZONE}`, TYPE_A);
    expect(res.rcode).toBe(RCODE_NXDOMAIN);
    expect(res.authority).toBe(1);
    authServer.setWildcard(PUBLIC_IP, 60);
  });

  it('answers over TCP as well as UDP', async () => {
    const res = await tcpAsk(`app.${ZONE}`, TYPE_A);
    expect(res.rcode).toBe(0);
    expect(res.answers).toBe(1);
  });

  it('refuses AXFR so the zone cannot be dumped by strangers', async () => {
    const res = await udpAsk(ZONE, 252); // AXFR
    expect(res.rcode).toBe(5); // REFUSED
  });

  it('still refuses out-of-zone recursion', async () => {
    const res = await udpAsk('example.com', TYPE_A);
    expect(res.rcode).toBe(5);
  });
});
