import net from 'node:net';

/** Returns true when the TCP port can be bound on 127.0.0.1. */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

/**
 * Allocates an available local port. Prefers the project's preferred port,
 * then walks a range. Every check binds on loopback only.
 */
export async function allocatePort(preferred: number | null, range: { start: number; end: number } = { start: 4300, end: 4999 }): Promise<number | null> {
  if (preferred != null && (await isPortFree(preferred))) return preferred;
  // Deterministic-ish scan from a random offset avoids thundering herd.
  const offset = Math.floor(Math.random() * (range.end - range.start));
  for (let i = 0; i <= range.end - range.start; i++) {
    const port = range.start + ((offset + i) % (range.end - range.start + 1));
    if (await isPortFree(port)) return port;
  }
  return null;
}

export interface ListeningPort {
  port: number;
  label: string;
}

/**
 * Best-effort enumeration of occupied ports relevant to PortPilot by probing
 * the ports we know about (management API, proxy, DNS, and app range). We do
 * NOT parse OS tables (requires extra privileges/tools on Windows).
 */
export async function probeUsedPorts(labels: { port: number; label: string }[]): Promise<ListeningPort[]> {
  const used: ListeningPort[] = [];
  for (const entry of labels) {
    if (!(await isPortFree(entry.port, '0.0.0.0')) || !(await isPortFree(entry.port, '127.0.0.1'))) {
      used.push(entry);
    }
  }
  return used;
}
