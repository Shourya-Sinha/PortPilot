import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  generateId,
  getPaths,
  nowIso,
  validateBranch,
  validateCommand,
  validateEnvKey,
  validateProjectName,
  validateRelativePath,
  validateRepoUrl,
  validateWebsiteName,
  type DeploymentMode,
  type DetectedConfig,
  type HostnameMode,
  type PackageManager,
} from '@portpilot/shared';
import { detectProject } from '@portpilot/build-engine';
import { runGit, validateGitRepoUrl, listRemoteBranches, generateWebhookSecret, getHeadCommit } from '@portpilot/github';
import { syncDnsHostname, removeDnsHostname } from './dns-sync.js';
import { startProjectFromDeployment } from './start-project.js';
import { isPidAlive } from '@portpilot/runtime-manager';
import type { AppContext } from './context.js';

interface ProjectBody {
  name?: string;
  websiteName?: string;
  repoUrl?: string;
  branch?: string;
  projectRoot?: string;
  framework?: string;
  deploymentMode?: DeploymentMode;
  packageManager?: PackageManager;
  installCommand?: string | null;
  buildCommand?: string | null;
  startCommand?: string | null;
  outputDir?: string | null;
  preferredPort?: number | null;
  healthCheckPath?: string | null;
  hostnameMode?: HostnameMode;
  publicHostname?: string | null;
  confirm?: boolean;
  config?: Record<string, unknown>;
}

function validateProjectBody(body: ProjectBody, opts: { partial?: boolean } = {}): void {
  if (!opts.partial) {
    const name = validateProjectName(String(body.name ?? ''));
    if (!name.ok) throw new ValidationError(name.error!);
    const web = validateWebsiteName(String(body.websiteName ?? '').toLowerCase());
    if (!web.ok) throw new ValidationError(web.error!);
    const url = validateRepoUrl(String(body.repoUrl ?? ''));
    if (!url.ok) throw new ValidationError(url.error!);
    const br = validateBranch(String(body.branch ?? ''));
    if (!br.ok) throw new ValidationError(br.error!);
  }
  for (const key of ['installCommand', 'buildCommand', 'startCommand'] as const) {
    const val = body[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      const v = validateCommand(val);
      if (!v.ok) throw new ValidationError(`${key}: ${v.error}`);
    }
  }
  if (typeof body.outputDir === 'string' && body.outputDir.trim().length > 0) {
    const v = validateRelativePath(body.outputDir.trim());
    if (!v.ok) throw new ValidationError(`outputDir: ${v.error}`);
  }
  if (typeof body.projectRoot === 'string' && body.projectRoot.trim().length > 0 && body.projectRoot !== '.') {
    const v = validateRelativePath(body.projectRoot.trim());
    if (!v.ok) throw new ValidationError(`projectRoot: ${v.error}`);
  }
  if (body.preferredPort != null && (typeof body.preferredPort !== 'number' || body.preferredPort < 1 || body.preferredPort > 65535)) {
    throw new ValidationError('preferredPort must be 1-65535');
  }
}

export function registerProjectRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, hostnames, queue, supervisor, logger } = ctx;

  // ---------- projects ----------
  app.get('/api/projects', async () => {
    return {
      projects: db.listProjects().map((p) => ({
        ...p,
        webhookSecret: p.webhookSecret ? '***' : null,
        runtime: db.getRuntime(p.id),
        hostname: `${p.websiteName}.localhost`,
      })),
    };
  });

  app.post('/api/projects', async (req, reply) => {
    const body = req.body as ProjectBody;
    validateProjectBody(body);
    const websiteName = String(body.websiteName).toLowerCase();
    const name = String(body.name);

    if (db.getProjectByWebsiteName(websiteName)) throw new ConflictError(`Website name "${websiteName}" is already registered.`);
    if (db.getProjectByName(name)) throw new ConflictError(`Project name "${name}" is already in use.`);

    // Hostname conflict pre-check (also covers deleted projects with leftover names).
    const hostname = `${websiteName}.localhost`;
    const clash = db.getHostnameByName(hostname);
    if (clash && clash.projectId) throw new ConflictError(`Hostname "${hostname}" is already mapped to another project.`);

    const project = db.createProject({
      name,
      websiteName,
      repoUrl: String(body.repoUrl),
      branch: String(body.branch),
      projectRoot: body.projectRoot ?? '.',
      framework: (body.framework as never) ?? 'unknown',
      deploymentMode: body.deploymentMode ?? 'node',
      packageManager: body.packageManager ?? 'npm',
      installCommand: body.installCommand ?? null,
      buildCommand: body.buildCommand ?? null,
      startCommand: body.startCommand ?? null,
      outputDir: body.outputDir ?? null,
      preferredPort: body.preferredPort ?? null,
      healthCheckPath: body.healthCheckPath ?? '/',
      hostnameMode: body.hostnameMode ?? 'local',
      publicHostname: body.publicHostname ?? null,
      configConfirmed: body.confirm === true,
      webhookSecret: generateWebhookSecret(),
    });

    const registered = hostnames.registerLocalHostname(project.id, websiteName);
    syncDnsHostname(ctx.dns, ctx.cfg, registered.hostname);
    const act = db.logActivity('project.created', `Project "${name}" created with website name "${websiteName}"`, project.id);
    ctx.logger.info(`Project ${project.id} created (${websiteName}.localhost)`);
    return reply.code(201).send({ project: { ...project, webhookSecret: '***' }, localUrl: `http://${hostname}${ctx.cfg.proxyPort === 80 ? '' : `:${ctx.cfg.proxyPort}`}` });
  });

  app.get('/api/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    const project = db.getProject(id);
    if (!project) throw new NotFoundError('Project not found');
    return {
      project: { ...project, webhookSecret: project.webhookSecret ? '***' : null },
      runtime: db.getRuntime(id),
      hostnames: db.listHostnames(id),
      deployments: db.listDeployments({ projectId: id, limit: 15 }),
      envVars: db.listEnvVars(id),
    };
  });

  app.patch('/api/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = req.body as ProjectBody;
    validateProjectBody(body, { partial: true });
    const existing = db.getProject(id);
    if (!existing) throw new NotFoundError('Project not found');
    if (body.websiteName && String(body.websiteName).toLowerCase() !== existing.websiteName) {
      const v = validateWebsiteName(String(body.websiteName).toLowerCase());
      if (!v.ok) throw new ValidationError(v.error!);
      const clash = db.getProjectByWebsiteName(String(body.websiteName).toLowerCase());
      if (clash && clash.id !== id) throw new ConflictError('Website name already registered.');
    }
    const updated = db.updateProject(id, {
      name: body.name !== undefined ? String(body.name) : undefined,
      websiteName: body.websiteName !== undefined ? String(body.websiteName).toLowerCase() : undefined,
      repoUrl: body.repoUrl !== undefined ? String(body.repoUrl) : undefined,
      branch: body.branch !== undefined ? String(body.branch) : undefined,
      projectRoot: body.projectRoot,
      framework: body.framework as never,
      deploymentMode: body.deploymentMode,
      packageManager: body.packageManager,
      installCommand: body.installCommand,
      buildCommand: body.buildCommand,
      startCommand: body.startCommand,
      outputDir: body.outputDir,
      preferredPort: body.preferredPort,
      healthCheckPath: body.healthCheckPath,
      hostnameMode: body.hostnameMode,
      publicHostname: body.publicHostname,
    });
    if (body.websiteName) {
      const before = db.getHostnameByName(`${existing.websiteName.toLowerCase()}.localhost`);
      const registered = hostnames.registerLocalHostname(id, String(body.websiteName).toLowerCase());
      if (before && before.hostname !== registered.hostname) removeDnsHostname(ctx.dns, ctx.cfg, before.hostname);
      syncDnsHostname(ctx.dns, ctx.cfg, registered.hostname);
    }
    return { project: updated ? { ...updated, webhookSecret: updated.webhookSecret ? '***' : null } : null };
  });

  app.delete('/api/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { confirm?: string };
    const project = db.getProject(id);
    if (!project) throw new NotFoundError('Project not found');
    // Explicit confirmation required for destructive operations.
    if (body.confirm !== project.websiteName && body.confirm !== project.name) {
      throw new ValidationError('Destructive operation: send { "confirm": "<website-name>" } to delete this project and its deployments.');
    }
    await supervisor.stop(id).catch(() => undefined);
    for (const h of db.listHostnames(id)) {
      removeDnsHostname(ctx.dns, ctx.cfg, h.hostname);
      db.deleteHostname(h.id);
    }
    db.deleteProject(id);
    db.logActivity('project.deleted', `Project "${project.name}" deleted`, id);
    return { ok: true };
  });

  // ---------- detection ----------
  app.post('/api/projects/:id/detect', async (req) => {
    const { id } = req.params as { id: string };
    const project = db.getProject(id);
    if (!project) throw new NotFoundError('Project not found');
    const paths = getPaths();
    const sourceDir = path.join(paths.workspacesDir, project.websiteName.replace(/[^A-Za-z0-9._-]/g, '_'), 'src');
    const token = db.resolveGithubToken(project.githubTokenRef);
    const co = await runGit(['clone', '--depth', '1', '--branch', project.branch, project.repoUrl, sourceDir], {
      token,
      timeoutMs: 180_000,
    });
    // If it already exists, just report detection on the current checkout.
    const projDir = path.resolve(sourceDir, project.projectRoot || '.');
    if (!fs.existsSync(projDir)) {
      return { ok: false, error: co.ok ? 'Project root not found in repository' : co.stderr.split('\n')[0] };
    }
    const detected = detectProject(projDir);
    return { ok: true, detected, alreadyCloned: !co.ok };
  });

  // ---------- deploy ----------
  app.post('/api/projects/:id/deploy', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as ProjectBody & { config?: Partial<ProjectBody> };
    const project = db.getProject(id);
    if (!project) throw new NotFoundError('Project not found');

    const paths = getPaths();
    const sourceDir = path.join(paths.workspacesDir, project.websiteName.replace(/[^A-Za-z0-9._-]/g, '_'), 'src');

    // First deployment must be confirmed. Return the detected config so the UI
    // can show it; never execute guessed commands without confirmation.
    if (!project.configConfirmed && body.confirm !== true) {
      const projDir = path.resolve(sourceDir, project.projectRoot || '.');
      let detected: DetectedConfig | null = null;
      if (fs.existsSync(projDir)) {
        detected = detectProject(projDir);
      } else {
        const token = db.resolveGithubToken(project.githubTokenRef);
        const co = await runGit(['clone', '--depth', '1', '--branch', project.branch, project.repoUrl, sourceDir], { token, timeoutMs: 180_000 });
        const pd = path.resolve(sourceDir, project.projectRoot || '.');
        if (fs.existsSync(pd)) detected = detectProject(pd);
        else if (!co.ok) throw new ValidationError(`Could not clone repository: ${co.stderr.split('\n')[0] ?? 'unknown error'}`);
      }
      return {
        code: 'confirmation_required',
        message: 'Please review the detected configuration and confirm before the first deployment.',
        detected,
        proposed: {
          framework: project.framework,
          deploymentMode: project.deploymentMode,
          packageManager: project.packageManager,
          installCommand: project.installCommand,
          buildCommand: project.buildCommand,
          startCommand: project.startCommand,
          outputDir: project.outputDir,
          projectRoot: project.projectRoot,
          healthCheckPath: project.healthCheckPath,
        },
      };
    }

    // Apply any config overrides that came with the confirmation.
    const cfgPatch = body.config ?? {};
    for (const key of ['installCommand', 'buildCommand', 'startCommand'] as const) {
      const val = cfgPatch[key];
      if (typeof val === 'string' && val.trim().length > 0) {
        const v = validateCommand(val);
        if (!v.ok) throw new ValidationError(`${key}: ${v.error}`);
      }
    }
    const updated = db.updateProject(id, {
      framework: (cfgPatch.framework as never) ?? undefined,
      deploymentMode: cfgPatch.deploymentMode ?? undefined,
      packageManager: cfgPatch.packageManager ?? undefined,
      installCommand: cfgPatch.installCommand ?? undefined,
      buildCommand: cfgPatch.buildCommand ?? undefined,
      startCommand: cfgPatch.startCommand ?? undefined,
      outputDir: cfgPatch.outputDir ?? undefined,
      projectRoot: cfgPatch.projectRoot ?? undefined,
      healthCheckPath: cfgPatch.healthCheckPath ?? undefined,
      configConfirmed: true,
    });
    const p = updated ?? project;

    const dep = db.createDeployment(id);
    queue.enqueue({
      deploymentId: dep.id,
      projectId: id,
      config: {
        framework: p.framework,
        deploymentMode: p.deploymentMode,
        packageManager: p.packageManager,
        installCommand: p.installCommand,
        buildCommand: p.buildCommand,
        startCommand: p.startCommand,
        outputDir: p.outputDir,
        projectRoot: p.projectRoot,
        healthCheckPath: p.healthCheckPath,
        preferredPort: p.preferredPort,
      },
    });
    db.logActivity('deployment.queued', `Deployment ${dep.id} queued for "${p.name}"`, id, dep.id);
    return { deployment: dep, localUrl: `http://${p.websiteName}.localhost${ctx.cfg.proxyPort === 80 ? '' : `:${ctx.cfg.proxyPort}`}` };
  });

  app.post('/api/projects/:id/redeploy', async (req) => {
    const { id } = req.params as { id: string };
    const project = db.getProject(id);
    if (!project) throw new NotFoundError('Project not found');
    // Manual Pull and Redeploy (works without inbound webhooks).
    const paths = getPaths();
    const sourceDir = path.join(paths.workspacesDir, project.websiteName.replace(/[^A-Za-z0-9._-]/g, '_'), 'src');
    const token = db.resolveGithubToken(project.githubTokenRef);
    if (fs.existsSync(path.join(sourceDir, '.git'))) {
      const pull = await runGit(['fetch', '--depth', '50', 'origin', project.branch], { cwd: sourceDir, token });
      if (!pull.ok) logger.warn(`fetch failed for ${project.name}: ${pull.stderr.split('\n')[0]}`);
      else await runGit(['checkout', '-B', project.branch, `origin/${project.branch}`], { cwd: sourceDir, token });
    }
    const dep = db.createDeployment(id);
    queue.enqueue({
      deploymentId: dep.id,
      projectId: id,
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
    db.logActivity('deployment.redeploy', `Pull & redeploy queued as ${dep.id}`, id, dep.id);
    return { deployment: dep };
  });

  app.post('/api/projects/:id/rollback', async (req) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { deploymentId?: string };
    if (!body.deploymentId) throw new ValidationError('deploymentId is required');
    const res = await queue.rollback(id, body.deploymentId);
    if (!res.ok) throw new ValidationError(res.error ?? 'Rollback failed');
    return res;
  });

  // ---------- runtime control ----------
  app.post('/api/projects/:id/start', async (req) => {
    const { id } = req.params as { id: string };
    const project = db.getProject(id);
    if (!project) throw new NotFoundError('Project not found');
    const res = await startProjectFromDeployment(db, supervisor, hostnames, id);
    if (!res.ok) throw new ValidationError(res.error ?? 'Could not start the application.');
    return { ok: true, port: res.port, pid: res.pid };
  });

  app.post('/api/projects/:id/stop', async (req) => {
    const { id } = req.params as { id: string };
    await supervisor.stop(id);
    db.setRuntime({ projectId: id, status: 'stopped', pid: null, lastError: null });
    return { ok: true };
  });

  app.post('/api/projects/:id/restart', async (req, reply) => {
    const { id } = req.params as { id: string };
    const stopRes = await app.inject({ method: 'POST', url: `/api/projects/${id}/stop`, headers: req.headers as never, payload: {} });
    if (stopRes.statusCode >= 400) {
      reply.code(stopRes.statusCode);
      return stopRes.json();
    }
    const startRes = await app.inject({ method: 'POST', url: `/api/projects/${id}/start`, headers: req.headers as never, payload: {} });
    reply.code(startRes.statusCode);
    return startRes.json();
  });

  app.get('/api/projects/:id/runtime', async (req) => {
    const { id } = req.params as { id: string };
    const rt = db.getRuntime(id);
    if (!rt) return { runtime: null };
    const alive = rt.pid != null && isPidAlive(rt.pid);
    return { runtime: { ...rt, alive } };
  });

  // ---------- env vars ----------
  app.get('/api/projects/:id/env', async (req) => {
    const { id } = req.params as { id: string };
    return { envVars: db.listEnvVars(id) };
  });

  app.post('/api/projects/:id/env', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { key?: string; value?: string };
    const v = validateEnvKey(String(body.key ?? ''));
    if (!v.ok) throw new ValidationError(v.error!);
    if (typeof body.value !== 'string') throw new ValidationError('value is required');
    if (!db.getProject(id)) throw new NotFoundError('Project not found');
    const env = db.setEnvVar(id, String(body.key), body.value);
    return reply.code(201).send({ envVar: env });
  });

  app.delete('/api/projects/:id/env/:envId', async (req) => {
    const { id, envId } = req.params as { id: string; envId: string };
    const ok = db.deleteEnvVar(id, envId);
    if (!ok) throw new NotFoundError('Env var not found');
    return { ok: true };
  });

  // ---------- deployments ----------
  app.get('/api/deployments', async (req) => {
    const q = req.query as { projectId?: string; limit?: string; status?: string };
    return {
      deployments: db.listDeployments({ projectId: q.projectId, limit: q.limit ? Number(q.limit) : 50, status: q.status }).map((d) => ({
        ...d,
        projectName: db.getProject(d.projectId)?.name ?? 'unknown',
        websiteName: db.getProject(d.projectId)?.websiteName ?? null,
      })),
    };
  });

  app.get('/api/deployments/:id', async (req) => {
    const { id } = req.params as { id: string };
    const d = db.getDeployment(id);
    if (!d) throw new NotFoundError('Deployment not found');
    return { deployment: d, project: db.getProject(d.projectId) };
  });

  app.get('/api/deployments/:id/logs', async (req) => {
    const { id } = req.params as { id: string };
    const paths = getPaths();
    const file = path.join(paths.deploymentsLogDir, `${id}.log`);
    if (!fs.existsSync(file)) return { lines: [] };
    const content = fs.readFileSync(file, 'utf8');
    return { file: path.basename(file), lines: content.split(/\r?\n/).filter((l) => l.length > 0) };
  });

  app.post('/api/deployments/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    const ok = queue.cancel(id);
    return { ok, cancelled: ok };
  });

  app.get('/api/deployments/:id/stream', async (req, reply) => {
    const { id } = req.params as { id: string };
    const dep = db.getDeployment(id);
    if (!dep) throw new NotFoundError('Deployment not found');
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    // Replay existing log first.
    const paths = getPaths();
    const file = path.join(paths.deploymentsLogDir, `${id}.log`);
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        if (line.trim()) reply.raw.write(`event: log\ndata: ${JSON.stringify({ text: line })}\n\n`);
      }
    }
    const { appEvents } = await import('@portpilot/shared');
    const onLog = (p: { deploymentId: string; text: string; ts: string; stream: string }) => {
      if (p.deploymentId !== id) return;
      reply.raw.write(`event: log\ndata: ${JSON.stringify(p)}\n\n`);
    };
    const onStatus = (p: { deploymentId: string }) => {
      if (p.deploymentId !== id) return;
      reply.raw.write(`event: status\ndata: ${JSON.stringify(p)}\n\n`);
    };
    appEvents.on('deployment:log', onLog as never);
    appEvents.on('deployment:status', onStatus as never);
    const ping = setInterval(() => {
      try {
        reply.raw.write(': ping\n\n');
      } catch {
        /* closed */
      }
    }, 20_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      appEvents.off('deployment:log', onLog as never);
      appEvents.off('deployment:status', onStatus as never);
    });
    return reply;
  });

  // ---------- github helpers ----------
  app.get('/api/github/branches', async (req) => {
    const q = req.query as { url?: string };
    const url = String(q.url ?? '');
    const v = validateGitRepoUrl(url);
    if (!v.ok) throw new ValidationError(v.error!);
    // Use the same resolver as deploys so branch listing works for private
    // repos once a token has been saved in the dashboard.
    const token = db.resolveGithubToken(null);
    const res = await listRemoteBranches(url, token);
    return res;
  });

  app.post('/api/github/token', async (req) => {
    const body = (req.body ?? {}) as { token?: string };
    const token = String(body.token ?? '').trim();
    if (!token || token.length < 8) throw new ValidationError('A GitHub token is required.');
    if (!/^gh[pousr]_[A-Za-z0-9]{20,}$|^github_pat_[A-Za-z0-9_]{20,}$/.test(token)) {
      throw new ValidationError('That does not look like a GitHub token. Use a fine-grained PAT (github_pat_...) or classic token (ghp_...).');
    }
    const ref = 'github_token';
    db.putSecret(ref, token);
    db.setSetting('github_token_ref', ref);
    logger.info('GitHub token stored (encrypted). It will never be printed in logs or the API.');
    return { ok: true, stored: true };
  });

  app.get('/api/github/token-status', async () => {
    const source = db.githubTokenSource();
    return { configured: source !== 'none', source };
  });

  app.delete('/api/github/token', async () => {
    const ref = db.getSetting('github_token_ref');
    if (ref) {
      db.deleteSecret(ref);
      db.setSetting('github_token_ref', '');
    }
    return { ok: true };
  });

  app.get('/api/projects/:id/commit', async (req) => {
    const { id } = req.params as { id: string };
    const project = db.getProject(id);
    if (!project) throw new NotFoundError('Project not found');
    const paths = getPaths();
    const sourceDir = path.join(paths.workspacesDir, project.websiteName.replace(/[^A-Za-z0-9._-]/g, '_'), 'src');
    const head = await getHeadCommit(sourceDir);
    return head;
  });
}

export { generateId };
