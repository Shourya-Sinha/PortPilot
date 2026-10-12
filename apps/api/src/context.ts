import type { NetworkDiagnostics } from '@portpilot/shared';
import type { PortPilotDb } from '@portpilot/database';
import type { Logger } from '@portpilot/shared';
import type { RuntimeSupervisor } from '@portpilot/runtime-manager';
import type { HostnameManager } from '@portpilot/hostname-manager';
import type { ReverseProxy } from '@portpilot/reverse-proxy';
import type { DnsServer } from '@portpilot/dns-server';
import type { DeployQueue } from '@portpilot/worker';
import type { PublicAccessManager } from '@portpilot/public-access';
import type { AppConfig } from './config.js';

export interface AppContext {
  cfg: AppConfig;
  db: PortPilotDb;
  logger: Logger;
  supervisor: RuntimeSupervisor;
  hostnames: HostnameManager;
  queue: DeployQueue;
  proxy: ReverseProxy;
  proxyListening: boolean;
  dns: DnsServer | null;
  publicAccess: PublicAccessManager;
  startedAt: number;
  diagCache: { at: number; data: NetworkDiagnostics } | null;
  cachedPublicStatus(): 'local_only' | 'direct_possible' | 'relay_required' | 'unknown';
}
