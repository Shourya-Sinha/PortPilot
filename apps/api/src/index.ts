import fs from 'node:fs';
import { appEvents, ensureDirs, getPaths, Logger, nowIso } from '@portpilot/shared';
import { PortPilotDb } from '@portpilot/database';
import { RuntimeSupervisor, isPidAlive } from '@portpilot/runtime-manager';
import { HostnameManager } from '@portpilot/hostname-manager';
import { ReverseProxy } from '@portpilot/reverse-proxy';
import { DnsServer } from '@portpilot/dns-server';
import { PublicAccessManager } from '@portpilot/public-access';
import { DeployQueue } from '@portpilot/worker';
import { GitPoller } from './poller.js';
import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import type { AppContext } from './context.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const paths = getPaths();
  ensureDirs(paths);
  const logger = new Logger({ name: 'api', logDir: paths.logsDir });

  logger.info('Starting PortPilot HomeDeploy Dashboard services...');
  const db = new PortPilotDb(paths.dbFile, paths.secretKeyFile);

  const supervisor = new RuntimeSupervisor();
  const hostnames = new HostnameManager(db, cfg.proxyPort);
  const queue = new DeployQueue(db, supervisor, hostnames, logger);
  const publicAccess = new PublicAccessManager();

  // Projects that were up before this process started. They are restarted after
  // the HTTP server is listening (see autostart below), so a PortPilot restart
  // does not silently take every deployed site offline.
  const autostartCandidates: string[] = [];

  // Restore runtime metadata after restart (mark dead PIDs as crashed).
  for (const rt of db.listRuntime()) {
    const restored = supervisor.restoreFromState(rt.projectId, {
      deploymentId: rt.deploymentId,
      pid: rt.pid,
      port: rt.port,
      cwd: rt.cwd,
      startedAt: rt.startedAt,
      status: rt.status,
    });
    db.setRuntime({ projectId: rt.projectId, deploymentId: rt.deploymentId, status: restored.status, pid: restored.pid, port: restored.port, cwd: restored.cwd, startedAt: restored.startedAt, lastError: restored.lastError });
    if (restored.status === 'crashed') {
      logger.warn(`Project ${rt.projectId}: was running before the restart but is no longer alive.`);
      autostartCandidates.push(rt.projectId);
    }
  }

  // DNS module (optional).
  let dns: DnsServer | null = null;
  if (cfg.dnsEnabled) {
    dns = new DnsServer({
      host: cfg.dnsHost,
      port: cfg.dnsPort,
      zone: cfg.dnsZone,
      ttl: cfg.dnsTtl,
      logger: logger.child('dns'),
      nsName: cfg.dnsNsName ?? undefined,
      tcp: cfg.dnsTcp,
    });
    // A public zone needs SOA/NS plus an address. `DNS_PUBLIC_IP` publishes the
    // apex and `*.<zone>`, which is what a registrar delegation points at.
    if (cfg.dnsPublicIp) dns.setWildcard(cfg.dnsPublicIp, cfg.dnsTtl);
    if (cfg.dnsNsName && !cfg.dnsPublicIp) {
      logger.warn('DNS_NS_NAME is set without DNS_PUBLIC_IP: SOA/NS will be published but the zone has no address records.');
    }
    if (dns.authoritative) {
      logger.info(`DNS zone ${cfg.dnsZone} is authoritative (NS ${cfg.dnsNsName})${cfg.dnsTcp ? ' with TCP' : ''}.`);
    }
    try {
      for (const h of db.listHostnames()) {
        dns.setRecord(h.hostname, '127.0.0.1', cfg.dnsTtl);
        dns.setRecord(`${h.hostname.replace(/\.localhost$/, '')}.${cfg.dnsZone}`, '127.0.0.1', cfg.dnsTtl);
      }
      await dns.listen();
      appEvents.emit('dns:status', { status: 'running', port: cfg.dnsPort });
    } catch (err) {
      logger.error(`DNS server failed to start: ${String(err)} (continuing without DNS — it is optional)`);
      dns = null;
      appEvents.emit('dns:status', { status: 'error', port: cfg.dnsPort, error: String(err) });
    }
  }

  // Reverse proxy (hostname routing).
  const proxy = new ReverseProxy({ port: cfg.proxyPort, host: cfg.proxyHost, db, logger: logger.child('proxy') });
  let proxyListening = false;
  try {
    await proxy.listen();
    proxyListening = true;
    appEvents.emit('proxy:status', { status: 'running', port: cfg.proxyPort });
  } catch (err) {
    logger.error(`Reverse proxy failed to start on port ${cfg.proxyPort}: ${String(err)}`);
    appEvents.emit('proxy:status', { status: 'error', port: cfg.proxyPort, error: String(err) });
  }

  const ctx: AppContext = {
    cfg,
    db,
    logger,
    supervisor,
    hostnames,
    queue,
    proxy,
    proxyListening,
    dns,
    publicAccess,
    startedAt: Date.now(),
    diagCache: null,
    cachedPublicStatus() {
      if (!this.diagCache) return 'unknown';
      return publicAccess.overallStatus(this.diagCache.data);
    },
  };

  const app = await buildApp(ctx);
  await app.listen({ host: cfg.host, port: cfg.port });

  fs.writeFileSync(paths.pidFile, String(process.pid));

  // ---- automatic redeploy poller (works without inbound webhooks) ----
  const poller = new GitPoller(ctx, cfg.pollIntervalMs ?? 300_000);
  poller.start();

  // ---- autostart previously running applications ----
  if ((cfg.autostart ?? true) && autostartCandidates.length > 0) {
    const { startProjectFromDeployment } = await import('./start-project.js');
    type StartedApp = import('./start-project.js').StartedApp;
    for (const projectId of autostartCandidates) {
      const project = db.getProject(projectId);
      if (!project) continue;
      const res: StartedApp = await startProjectFromDeployment(db, supervisor, hostnames, projectId).catch((err) => ({ ok: false, error: String(err) }));
      if (res.ok) {
        logger.info(`Autostarted ${project.name} on port ${res.port}`);
        db.logActivity('app.autostart', `Autostarted "${project.name}" on port ${res.port}`, projectId);
      } else {
        logger.warn(`Autostart failed for ${project.name}: ${res.error ?? 'unknown error'}`);
      }
    }
  }
  const tokenHint = cfg.authToken;
  const dashUrl = `http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${cfg.port}/?token=${tokenHint}`;
  logger.info('============================================================');
  logger.info(' PortPilot HomeDeploy Dashboard is running');
  logger.info(` Dashboard:  ${dashUrl}`);
  logger.info(` API:        http://${cfg.host}:${cfg.port}/api`);
  logger.info(` Proxy:      http://127.0.0.1:${cfg.proxyPort}  (hostname routing)`);
  logger.info(` DNS:        ${dns ? `running on ${cfg.dnsHost}:${cfg.dnsPort} (zone ${cfg.dnsZone})` : 'disabled (optional)'}`);
  logger.info(' Local hostnames: http://<website-name>.localhost (via the proxy port)');
  logger.info('============================================================');
  db.logActivity('system.start', `PortPilot started (api ${cfg.port}, proxy ${cfg.proxyPort}${dns ? `, dns ${cfg.dnsPort}` : ''})`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}; shutting down gracefully...`);
    try {
      db.logActivity('system.stop', `PortPilot stopping (${signal})`);
      poller.stop();
      for (const p of supervisor.list()) {
        if (p.status === 'running') await supervisor.stop(p.projectId).catch(() => undefined);
      }
      await proxy.close().catch(() => undefined);
      if (dns) await dns.close().catch(() => undefined);
      await app.close();
      db.close();
      logger.close();
    } catch (err) {
      console.error('Shutdown error:', err);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    logger.error(`uncaughtException: ${String(err.stack ?? err)}`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});

export { isPidAlive, nowIso };
