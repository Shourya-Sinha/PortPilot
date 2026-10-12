import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import dgram from 'node:dgram';
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
