import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';
import {
  type HostnameRecord,
  type HostnameResolutionStatus,
  type HostnameReachabilityStatus,
  type HostnameMode,
  ConflictError,
  NotFoundError,
  validateHostname,
  validateWebsiteName,
  ValidationError,
} from '@portpilot/shared';
import type { PortPilotDb } from '@portpilot/database';

/**
 * Hostname & Naming Engine.
 *
 * Website names are registered in SQLite and mapped to local hostnames of the
 * form `<name>.localhost`. On Windows 10/11, Linux (systemd-resolved) and
 * modern browsers, `*.localhost` resolves to loopback WITHOUT a DNS server or
 * administrator rights (RFC 6761). This is a LOCAL registration only — it is
 * never a globally registered domain.
 */
export class HostnameManager {
  constructor(private readonly db: PortPilotDb, private readonly proxyPort: number) {}

  /** Validate and normalize a website name. */
  validateName(websiteName: string): string {
    const v = validateWebsiteName(websiteName);
    if (!v.ok) throw new ValidationError(v.error ?? 'Invalid website name');
    return websiteName.toLowerCase();
  }

  localHostnameFor(websiteName: string): string {
    return `${this.validateName(websiteName)}.localhost`;
  }

  /** Register (or update) the local hostname for a project. Detects conflicts. */
  registerLocalHostname(projectId: string, websiteName: string): HostnameRecord {
    const hostname = this.localHostnameFor(websiteName);
    const existing = this.db.getHostnameByName(hostname);
    if (existing && existing.projectId && existing.projectId !== projectId) {
      throw new ConflictError(`Hostname "${hostname}" is already used by another project.`);
    }
    const project = this.db.getProject(projectId);
    if (!project) throw new NotFoundError('Project not found');
    if (existing) {
      return this.db.updateHostname(existing.id, {
        projectId,
        mode: 'local',
        targetPort: project.preferredPort,
        publicHostname: project.publicHostname,
      })!;
    }
    return this.db.createHostname({
      projectId,
      hostname,
      mode: 'local',
      targetPort: project.preferredPort,
      publicHostname: project.publicHostname,
    });
  }

  /** Update the target port after deployment (keeps reverse-proxy routes current). */
  syncRoute(projectId: string, port: number): HostnameRecord | null {
    const project = this.db.getProject(projectId);
    if (!project) return null;
    const hostname = this.localHostnameFor(project.websiteName);
    const rec = this.db.getHostnameByName(hostname);
    if (!rec) {
      return this.db.createHostname({ projectId, hostname, mode: 'local', targetPort: port, publicHostname: project.publicHostname });
    }
    return this.db.updateHostname(rec.id, { targetPort: port, projectId });
  }

  updateHostname(id: string, patch: { hostname?: string; mode?: HostnameMode; publicHostname?: string | null }): HostnameRecord {
    const existing = this.db.getHostname(id);
    if (!existing) throw new NotFoundError('Hostname not found');
    if (patch.hostname && patch.hostname !== existing.hostname) {
      const v = validateHostname(patch.hostname);
      if (!v.ok) throw new ValidationError(v.error ?? 'Invalid hostname');
      const clash = this.db.getHostnameByName(patch.hostname);
      if (clash && clash.id !== id) throw new ConflictError(`Hostname "${patch.hostname}" is already in use.`);
    }
    return this.db.updateHostname(id, patch)!;
  }

  removeHostname(id: string): void {
    const ok = this.db.deleteHostname(id);
    if (!ok) throw new NotFoundError('Hostname not found');
  }

  list(projectId?: string): HostnameRecord[] {
    return this.db.listHostnames(projectId);
  }

  /**
   * Checks resolution + reachability status for a hostname.
   * Public resolvability is verified with a real DNS lookup against public
   * resolvers; public reachability requires a real external HTTP check which
   * this module cannot fabricate — it is only marked 'reachable_external' when
   * explicitly verified by the public-access module.
   */
  async checkHostname(id: string): Promise<HostnameRecord> {
    const rec = this.db.getHostname(id);
    if (!rec) throw new NotFoundError('Hostname not found');

    let resolution: HostnameResolutionStatus = 'unknown';
    try {
      await lookupHost(rec.hostname);
      resolution = 'resolvable_local';
    } catch {
      resolution = rec.hostname.endsWith('.localhost') ? 'resolvable_local' : 'unresolvable';
    }
    // Note: .localhost is treated as locally resolvable by the OS/browser per RFC 6761.

    let publicResolution: HostnameResolutionStatus = resolution;
    if (rec.mode === 'public' && rec.publicHostname) {
      try {
        await lookupHost(rec.publicHostname);
        publicResolution = 'resolvable_public';
      } catch {
        publicResolution = 'unresolvable';
      }
    }

    let reach: HostnameReachabilityStatus = 'not_checked';
    if (rec.targetPort != null || this.proxyPort) {
      const viaProxy = await httpCheck('127.0.0.1', this.proxyPort, rec.hostname);
      reach = viaProxy ? 'reachable_local' : 'unreachable_local';
    }

    return this.db.updateHostname(id, {
      resolutionStatus: rec.mode === 'public' ? publicResolution : resolution,
      reachabilityStatus: reach,
    })!;
  }
}

function lookupHost(hostname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, (err, address) => (err ? reject(err) : resolve(address)));
  });
}

function httpCheck(host: string, port: number, sniHost: string, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({ host, port, path: '/', method: 'GET', headers: { Host: sniHost }, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 500);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

export function isValidLocalHostname(hostname: string): boolean {
  return hostname.endsWith('.localhost') && net.isIP(hostname) === 0;
}
