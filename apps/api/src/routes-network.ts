import type { FastifyInstance } from 'fastify';
import { ConflictError, NotFoundError, ValidationError, nowIso, validateHostname, type NetworkDiagnostics } from '@portpilot/shared';
import { verifyGithubSignature, parsePushEvent } from '@portpilot/github';
import { lookupViaDns } from '@portpilot/dns-server';
import { runNetworkDiagnostics } from '@portpilot/network-diagnostics';
import { verifyPublicDomain } from '@portpilot/public-access';
import { isPortFree } from '@portpilot/runtime-manager';
import type { AppContext } from './context.js';
import { syncDnsHostname, removeDnsHostname } from './dns-sync.js';

const DIAG_CACHE_MS = 60_000;

export function registerNetworkRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, hostnames, dns, publicAccess, queue, cfg } = ctx;
  const logger = ctx.logger;

  // ---------- hostnames ----------
  app.get('/api/hostnames', async (req) => {
    const q = req.query as { projectId?: string };
    return {
      hostnames: hostnames.list(q.projectId).map((h) => ({
        ...h,
        projectName: h.projectId ? (db.getProject(h.projectId)?.name ?? null) : null,
        localUrl: `http://${h.hostname}${cfg.proxyPort === 80 ? '' : `:${cfg.proxyPort}`}`,
        actualLocalUrl: h.targetPort ? `http://127.0.0.1:${h.targetPort}` : null,
      })),
    };
  });

  app.post('/api/hostnames', async (req, reply) => {
    const body = (req.body ?? {}) as { projectId?: string; hostname?: string; mode?: string; publicHostname?: string | null };
    const v = validateHostname(String(body.hostname ?? ''));
    if (!v.ok) throw new ValidationError(v.error!);
    const existing = db.getHostnameByName(String(body.hostname).toLowerCase());
    if (existing) throw new ConflictError(`Hostname "${body.hostname}" already exists.`);
    const rec = db.createHostname({
      projectId: body.projectId ?? null,
      hostname: String(body.hostname).toLowerCase(),
      mode: (body.mode as never) ?? 'local',
      publicHostname: body.publicHostname ?? null,
    });
    syncDnsHostname(ctx.dns, cfg, rec.hostname);
    return reply.code(201).send({ hostname: rec });
  });

  app.patch('/api/hostnames/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { hostname?: string; mode?: string; publicHostname?: string | null };
    if (body.hostname) {
      const v = validateHostname(String(body.hostname));
      if (!v.ok) throw new ValidationError(v.error!);
    }
    const before = db.getHostname(id);
    const rec = hostnames.updateHostname(id, {
      hostname: body.hostname ? String(body.hostname).toLowerCase() : undefined,
      mode: body.mode as never,
      publicHostname: body.publicHostname,
    });
    if (before && before.hostname !== rec.hostname) removeDnsHostname(ctx.dns, cfg, before.hostname);
    syncDnsHostname(ctx.dns, cfg, rec.hostname);
    return { hostname: rec };
  });

  app.delete('/api/hostnames/:id', async (req) => {
    const { id } = req.params as { id: string };
    const rec = db.getHostname(id);
    hostnames.removeHostname(id);
    if (rec) removeDnsHostname(ctx.dns, cfg, rec.hostname);
    return { ok: true };
  });

  app.post('/api/hostnames/:id/check', async (req) => {
    const { id } = req.params as { id: string };
    const rec = await hostnames.checkHostname(id);
    return {
      hostname: rec,
      note: 'Local resolvability of *.localhost is provided by the OS/browser (RFC 6761). Public resolvability is only reported when a real external DNS lookup succeeds.',
    };
  });

  // ---------- DNS ----------
  app.get('/api/dns/status', async () => {
    return {
      enabled: Boolean(dns),
      running: dns?.running ?? false,
      port: dns?.port ?? cfg.dnsPort,
      host: cfg.dnsHost,
      zone: cfg.dnsZone,
      ttl: cfg.dnsTtl,
      records: dns?.listRecords() ?? [],
      recentQueries: (dns?.queries ?? []).slice(-50).reverse(),
      disclaimer: [
        'A local DNS zone works only for clients configured to use this resolver.',
        'Other devices need their DNS settings pointed here manually.',
        'Public DNS delegation requires control of a real domain or delegated namespace.',
        'Names like home.arpa are intended for private networks, not public domains.',
        'DNS records do not provide network connectivity by themselves.',
        'Port 53 requires administrator privileges; the default 5353 does not.',
      ],
    };
  });

  app.post('/api/dns/start', async (req, reply) => {
    if (!dns) return reply.code(400).send({ error: 'DNS module is disabled. Set DNS_ENABLED=true in .env to enable it.' });
    if (dns.running) return { ok: true, alreadyRunning: true, port: dns.port };
    // Populate records from registered hostnames -> loopback.
    for (const h of db.listHostnames()) {
      const name = h.hostname.replace(/\.localhost$/, `.${cfg.dnsZone}`);
      dns.setRecord(name, '127.0.0.1', cfg.dnsTtl);
      dns.setRecord(h.hostname, '127.0.0.1', cfg.dnsTtl);
    }
    try {
      const port = await dns.listen();
      return { ok: true, port, zone: dns.zone };
    } catch (err) {
      const msg = String(err);
      if (msg.includes('EACCES') || msg.includes('access')) {
        return reply.code(500).send({ error: 'Cannot bind DNS port (access denied). Port 53 requires administrator privileges. Use DNS_PORT=5353 (default) or run elevated with explicit consent.' });
      }
      if (msg.includes('EADDRINUSE')) return reply.code(500).send({ error: `DNS port ${cfg.dnsPort} is already in use. Change DNS_PORT in .env.` });
      return reply.code(500).send({ error: msg });
    }
  });

  app.post('/api/dns/stop', async () => {
    if (dns?.running) await dns.close();
    return { ok: true };
  });

  app.post('/api/dns/records', async (req, reply) => {
    if (!dns) throw new ValidationError('DNS module is disabled.');
    const body = (req.body ?? {}) as { name?: string; address?: string; ttl?: number };
    const v = validateHostname(String(body.name ?? ''));
    if (!v.ok) throw new ValidationError(v.error!);
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(String(body.address ?? ''))) throw new ValidationError('address must be an IPv4 address.');
    if (!dns.inZone(String(body.name))) throw new ValidationError(`Name must be inside the configured zone (${dns.zone}).`);
    dns.setRecord(String(body.name).toLowerCase(), String(body.address), body.ttl);
    return reply.code(201).send({ record: { name: String(body.name).toLowerCase(), address: body.address, ttl: body.ttl ?? cfg.dnsTtl } });
  });

  app.delete('/api/dns/records/:name', async (req) => {
    const { name } = req.params as { name: string };
    dns?.removeRecord(decodeURIComponent(name));
    return { ok: true };
  });

  app.post('/api/dns/lookup', async (req) => {
    const body = (req.body ?? {}) as { name?: string };
    const name = String(body.name ?? '');
    if (!name) throw new ValidationError('name is required');
    if (dns?.running) {
      const res = await lookupViaDns(name, cfg.dnsHost, dns.port);
      return { ...res, via: `PortPilot DNS (${cfg.dnsHost}:${dns.port})` };
    }
    return { ok: false, address: null, error: 'DNS server is not running.', via: 'none' };
  });

  // ---------- network diagnostics ----------
  app.get('/api/network/diagnostics', async () => {
    if (ctx.diagCache && Date.now() - ctx.diagCache.at < DIAG_CACHE_MS) {
      return { diagnostics: ctx.diagCache.data, cached: true };
    }
    const publicHostnameConfigured = db.listHostnames().some((h) => h.mode === 'public' && h.publicHostname);
    const diagnostics: NetworkDiagnostics = await runNetworkDiagnostics({
      publicIpCheckUrl: cfg.publicIpCheckUrl,
      knownPorts: [
        { port: cfg.port, label: 'PortPilot API' },
        { port: cfg.proxyPort, label: 'PortPilot reverse proxy' },
        { port: cfg.dnsPort, label: 'PortPilot DNS' },
      ],
      portCheck: async (p) => !(await isPortFree(p, '0.0.0.0')),
      publicHostnameConfigured,
    });
    ctx.diagCache = { at: Date.now(), data: diagnostics };
    return { diagnostics, cached: false };
  });

  // ---------- public access ----------
  app.get('/api/public-access/status', async () => {
    let diag = ctx.diagCache?.data ?? null;
    if (!diag) {
      diag = await runNetworkDiagnostics({ publicIpCheckUrl: cfg.publicIpCheckUrl, publicHostnameConfigured: db.listHostnames().some((h) => h.mode === 'public') });
      ctx.diagCache = { at: Date.now(), data: diag };
    }
    return {
      overall: publicAccess.overallStatus(diag),
      strategies: publicAccess.status(diag),
      honesty: [
        'A local hostname such as my-site.localhost is registered ONLY on this PC.',
        'It is not a globally registered domain and is not reachable from the internet.',
        'Public URLs are shown only after a valid hostname and network configuration have been verified externally.',
      ],
    };
  });

  /**
   * Verify a purchased public domain end-to-end (name -> target -> port -> app).
   * This is the check that answers "if I buy a domain, will it actually work?".
   */
  app.post('/api/public-access/verify', async (req) => {
    const body = (req.body ?? {}) as { domain?: string; projectId?: string };
    const domain = String(body.domain ?? '').trim();
    if (!domain) throw new ValidationError('A domain is required.');

    let diag = ctx.diagCache?.data ?? null;
    if (!diag) {
      diag = await runNetworkDiagnostics({ publicIpCheckUrl: cfg.publicIpCheckUrl, publicHostnameConfigured: true });
      ctx.diagCache = { at: Date.now(), data: diag };
    }

    const result = await verifyPublicDomain(domain, {
      expectedPublicIp: diag.publicIp,
      localProxyPort: cfg.proxyPort,
    });

    // Persist external reachability on the matching hostname, if one exists,
    // so the UI stops showing 'not_checked' forever.
    const record = db.getHostnameByName(domain) ?? db.listHostnames().find((h) => h.publicHostname === domain);
    if (record) {
      db.updateHostname(record.id, {
        mode: 'public',
        publicHostname: domain,
        resolutionStatus: result.resolves ? 'resolvable_public' : 'unresolvable',
        reachabilityStatus: result.servedByPortPilot ? 'reachable_external' : 'unreachable_external',
      });
    }

    if (body.projectId) {
      const project = db.getProject(body.projectId);
      if (project) db.updateProject(project.id, { publicHostname: domain, hostnameMode: 'public' });
    }

    db.logActivity('public.verified', `Verified public domain ${domain}: ${result.verdict}`);
    return result;
  });

  app.post('/api/public-access/relay/configure', async (req) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const adapter = publicAccess.get('relay');
    if (!adapter?.configure) throw new NotFoundError('Relay adapter not found');
    return await adapter.configure(body);
  });

  // ---------- webhooks ----------
  app.post('/api/webhooks/github/:projectId', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const project = db.getProject(projectId);
    if (!project || !project.webhookSecret) return reply.code(404).send({ error: 'Unknown webhook target' });

    const raw = JSON.stringify(req.body ?? {});
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    if (!verifyGithubSignature(raw, signature, project.webhookSecret)) {
      logger.warn(`Webhook signature verification failed for project ${projectId}`);
      return reply.code(401).send({ error: 'Invalid signature' });
    }
    const event = req.headers['x-github-event'] as string | undefined;
    if (event === 'ping') return { ok: true, pong: true };
    if (event !== 'push') return { ok: true, ignored: event ?? 'unknown' };

    const parsed = parsePushEvent(req.body);
    if (!parsed.branch || parsed.branch !== project.branch) {
      return { ok: true, ignored: `branch ${parsed.branch ?? 'unknown'} does not match ${project.branch}` };
    }
    if (!project.configConfirmed) {
      return reply.code(409).send({ error: 'Project has not been confirmed for deployment yet. Deploy once from the dashboard first.' });
    }
    const dep = db.createDeployment(projectId);
    queue.enqueue({
      deploymentId: dep.id,
      projectId,
      config: {
        framework: project.framework,
        deploymentMode: project.deploymentMode,
        packageManager: project.packageManager,
        installCommand: project.installCommand,
        buildCommand: project.buildCommand,
        startCommand: project.startCommand,
        outputDir: project.outputDir,
        projectRoot: project.projectRoot,
        healthCheckPath: project.healthCheckPath,
        preferredPort: project.preferredPort,
      },
    });
    db.logActivity('webhook.push', `Webhook push on ${parsed.branch} queued deployment ${dep.id}`, projectId, dep.id);
    return { ok: true, deploymentId: dep.id };
  });

  // Note about inbound webhooks when GitHub cannot reach this PC.
  app.get('/api/webhooks/info', async () => ({
    note: [
      'GitHub can only deliver webhooks to a URL it can reach.',
      'A PC behind CGNAT or a home NAT is usually NOT reachable from the internet, so GitHub webhooks cannot be delivered directly.',
      'Options: (1) use "Pull & Redeploy" manually in the dashboard; (2) run a small outbound poller; (3) if you have a reachable relay endpoint, forward the webhook there and call this API.',
      'PortPilot never requires a paid service for local deployments.',
    ],
    webhookUrlPattern: `${cfg.isLoopback ? 'http://<this-pc-lan-ip>' : `http://${cfg.host}`}:${cfg.port}/api/webhooks/github/<projectId>`,
  }));

  app.get('/api/public-access/last-check', async () => ({ checkedAt: ctx.diagCache?.at ? new Date(ctx.diagCache.at).toISOString() : null, diagnostics: ctx.diagCache?.data ?? null, at: nowIso() }));
}
