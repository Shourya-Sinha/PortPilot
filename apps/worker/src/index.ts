import fs from 'node:fs';
import path from 'node:path';
import {
  appEvents,
  getPaths,
  nowIso,
  redactSecrets,
  type DeploymentPhase,
  type DeploymentStatus,
  type LogLine,
  type Logger,
  type Project,
} from '@portpilot/shared';
import type { PortPilotDb } from '@portpilot/database';
import { runBuildPipeline } from '@portpilot/build-engine';
import { RuntimeSupervisor, isPidAlive } from '@portpilot/runtime-manager';
import type { HostnameManager } from '@portpilot/hostname-manager';

export interface DeployRequest {
  deploymentId: string;
  projectId: string;
  /** User-confirmed config (first deployment) or project defaults. */
  config: {
    framework: string;
    deploymentMode: 'static' | 'node' | 'java-maven' | 'java-gradle';
    packageManager: 'npm' | 'pnpm' | 'yarn' | 'none';
    installCommand: string | null;
    buildCommand: string | null;
    startCommand: string | null;
    outputDir: string | null;
    projectRoot: string;
    healthCheckPath: string | null;
    preferredPort: number | null;
  };
}

/**
 * Deployment worker: a FIFO queue with one active build at a time.
 * Runs the full lifecycle:
 *   checkout -> detect -> install -> build -> artifact -> port allocation
 *   -> startup -> health check -> success/failure
 * and preserves the previous successful deployment when a build fails.
 */
export class DeployQueue {
  private queue: DeployRequest[] = [];
  private active: { deploymentId: string; controller: AbortController } | null = null;
  private processing = false;
  private readonly running = new Set<string>();

  constructor(
    private readonly db: PortPilotDb,
    private readonly supervisor: RuntimeSupervisor,
    private readonly hostnames: HostnameManager,
    private readonly logger: Logger,
    private readonly concurrency = 1,
  ) {}

  enqueue(req: DeployRequest): void {
    if (this.running.has(req.deploymentId)) return;
    this.queue.push(req);
    this.db.updateDeployment(req.deploymentId, { status: 'queued', phase: 'queued' });
    this.emitStatus(req.deploymentId, req.projectId, 'queued', 'queued');
    void this.pump();
  }

  cancel(deploymentId: string): boolean {
    const idx = this.queue.findIndex((d) => d.deploymentId === deploymentId);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
      this.finish(deploymentId, this.db.getDeployment(deploymentId)?.projectId ?? '', 'cancelled', 'cancelled', 'Cancelled before start', null);
      return true;
    }
    if (this.active?.deploymentId === deploymentId) {
      this.active.controller.abort();
      return true;
    }
    return false;
  }

  isBusy(): boolean {
    return this.processing || this.queue.length > 0;
  }

  private async pump(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this.queue.length > 0 && this.running.size < this.concurrency) {
        const req = this.queue.shift()!;
        this.running.add(req.deploymentId);
        const controller = new AbortController();
        this.active = { deploymentId: req.deploymentId, controller };
        try {
          await this.process(req, controller.signal);
        } catch (err) {
          this.logger.error(`deployment ${req.deploymentId} crashed: ${String(err)}`);
        } finally {
          this.running.delete(req.deploymentId);
          this.active = null;
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private logLine(deploymentId: string, projectId: string, line: LogLine): void {
    const paths = getPaths();
    const file = path.join(paths.deploymentsLogDir, `${deploymentId}.log`);
    fs.mkdirSync(paths.deploymentsLogDir, { recursive: true });
    fs.appendFileSync(file, `${line.ts} [${line.stream}] ${line.text}\n`);
    appEvents.emit('deployment:log', { deploymentId, projectId, ts: line.ts, stream: line.stream, text: redactSecrets(line.text) });
  }

  private emitStatus(deploymentId: string, projectId: string, status: DeploymentStatus | string, phase: DeploymentPhase | string, error?: string | null): void {
    appEvents.emit('deployment:status', { deploymentId, projectId, status, phase, error: error ?? null });
  }

  private finish(deploymentId: string, projectId: string, status: DeploymentStatus, phase: DeploymentPhase, error: string | null, exitCode: number | null): void {
    const dep = this.db.getDeployment(deploymentId);
    const finishedAt = nowIso();
    const durationMs = dep?.startedAt ? Date.now() - Date.parse(dep.startedAt) : null;
    this.db.updateDeployment(deploymentId, { status, phase, error, exitCode, finishedAt, durationMs });
    this.emitStatus(deploymentId, projectId, status, phase, error);
    const msg = status === 'succeeded' ? `Deployment ${deploymentId} succeeded` : `Deployment ${deploymentId} ${status}${error ? `: ${error}` : ''}`;
    const act = this.db.logActivity(`deployment.${status}`, msg, projectId, deploymentId);
    appEvents.emit('activity', act);
    this.logger.info(msg);
  }

  private async process(req: DeployRequest, signal: AbortSignal): Promise<void> {
    const project = this.db.getProject(req.projectId);
    if (!project) {
      this.finish(req.deploymentId, req.projectId, 'failed', 'failed', 'Project not found', null);
      return;
    }
    const paths = getPaths();
    this.db.updateDeployment(req.deploymentId, { status: 'running', phase: 'checkout', startedAt: nowIso() });
    this.emitStatus(req.deploymentId, project.id, 'running', 'checkout');

    const sourceDir = path.join(paths.workspacesDir, sanitize(project.websiteName), 'src');
    const artifactDir = path.join(paths.artifactsDir, sanitize(project.websiteName), req.deploymentId);
    const gitToken = project.githubTokenRef ? this.db.getSecret(project.githubTokenRef) : process.env.PORTPILOT_GITHUB_TOKEN ?? null;
    const envVars = this.db.getEnvPlain(project.id);

    let phase: DeploymentPhase = 'checkout';
    const setPhase = (p: DeploymentPhase) => {
      phase = p;
      this.db.updateDeployment(req.deploymentId, { phase: p });
      this.emitStatus(req.deploymentId, project.id, 'running', p);
    };

    const onLog = (line: LogLine) => this.logLine(req.deploymentId, project.id, line);
    onLog({ ts: nowIso(), stream: 'system', text: `Deployment ${req.deploymentId} started for project "${project.name}" (${project.websiteName}.localhost)` });

    const result = await runBuildPipeline({
      project,
      config: req.config,
      sourceDir,
      artifactDir,
      env: envVars,
      gitToken,
      signal,
      onLog: (line) => {
        // Track phase transitions from pipeline logs.
        const m = line.text.match(/^==> Phase: (\S+)/);
        if (m) {
          const map: Record<string, DeploymentPhase> = {
            checkout: 'checkout',
            framework: 'detect',
            dependency: 'install',
            build: 'build',
            artifact: 'artifact',
          };
          const key = Object.keys(map).find((k) => m[1].startsWith(k));
          if (key) setPhase(map[key]);
        }
        onLog(line);
      },
    });

    this.db.updateDeployment(req.deploymentId, {
      commitSha: result.commitSha,
      commitMessage: result.commitMessage,
      workspacePath: sourceDir,
      artifactPath: result.artifactPath,
    });

    if (!result.ok) {
      const status: DeploymentStatus = result.cancelled ? 'cancelled' : 'failed';
      // Preserve the phase where the failure happened (checkout/install/build/...).
      const failedPhase = (result.failedPhase && result.failedPhase !== 'done' ? result.failedPhase : 'failed') as DeploymentPhase;
      this.finish(req.deploymentId, project.id, status, result.cancelled ? 'cancelled' : failedPhase, result.error, null);
      onLog({
        ts: nowIso(),
        stream: 'system',
        text: result.cancelled
          ? 'Deployment cancelled. The previous successful deployment is untouched.'
          : `Deployment FAILED at phase "${result.failedPhase}": ${result.error ?? 'unknown error'}. The previous successful deployment (if any) is preserved and still running.`,
      });
      return;
    }

    // ---- port allocation + startup + health check ----
    try {
      setPhase('port_allocation');
      // Stop the previous instance first to free its port and avoid duplicates.
      const runtime = this.db.getRuntime(project.id);
      if (runtime && (runtime.status === 'running' || isPidAlive(runtime.pid ?? -1))) {
        onLog({ ts: nowIso(), stream: 'system', text: 'Stopping previous application instance before starting the new one...' });
        await this.supervisor.stop(project.id);
      }

      setPhase('startup');
      const mode = result.mode;
      const runDir = mode === 'static' ? (result.artifactPath ?? sourceDir) : (result.runDir ?? sourceDir);
      const logFile = path.join(paths.runtimeLogDir, `${sanitize(project.websiteName)}.log`);
      const startCmd = req.config.startCommand;
      const proc = await this.supervisor.start({
        projectId: project.id,
        deploymentId: req.deploymentId,
        mode,
        runDir,
        startCommand: startCmd,
        preferredPort: req.config.preferredPort ?? project.preferredPort,
        env: envVars,
        healthCheckPath: req.config.healthCheckPath,
        logFile,
        onLog: (line) => this.logLine(req.deploymentId, project.id, line),
      });

      this.db.updateDeployment(req.deploymentId, { port: proc.port, pid: proc.pid });
      this.db.setRuntime({
        projectId: project.id,
        deploymentId: req.deploymentId,
        status: 'running',
        pid: proc.pid,
        port: proc.port,
        cwd: runDir,
        startedAt: nowIso(),
        lastError: null,
      });
      appEvents.emit('runtime:status', { projectId: project.id, status: 'running', pid: proc.pid, port: proc.port });

      setPhase('health_check');
      const health = await this.supervisor.waitForHealth(proc.port ?? 0, req.config.healthCheckPath ?? '/', 12, 1000);
      if (!health.ok) {
        onLog({ ts: nowIso(), stream: 'stderr', text: `Health check failed on port ${proc.port}: ${health.error ?? `status ${health.statusCode}`}` });
        await this.supervisor.stop(project.id);
        this.db.setRuntime({ projectId: project.id, deploymentId: req.deploymentId, status: 'unhealthy', pid: null, port: proc.port, cwd: runDir, lastError: health.error ?? 'health check failed' });
        this.finish(req.deploymentId, project.id, 'failed', 'health_check', `Health check failed: ${health.error ?? health.statusCode}`, null);
        return;
      }

      onLog({ ts: nowIso(), stream: 'system', text: `Health check OK (HTTP ${health.statusCode}) on 127.0.0.1:${proc.port}` });
      setPhase('done');

      // Sync hostname route so the reverse proxy points at the new port.
      const route = this.hostnames.syncRoute(project.id, proc.port ?? 0);
      if (route) {
        onLog({ ts: nowIso(), stream: 'system', text: `Local URL ready: http://${project.websiteName}.localhost (proxied to 127.0.0.1:${proc.port})` });
      }
      this.db.updateProject(project.id, { activeDeploymentId: req.deploymentId, lastCommitSha: result.commitSha, preferredPort: proc.port });
      this.finish(req.deploymentId, project.id, 'succeeded', 'done', null, 0);
    } catch (err) {
      const msg = redactSecrets(String(err));
      onLog({ ts: nowIso(), stream: 'stderr', text: `Startup failed: ${msg}` });
      this.db.setRuntime({ projectId: project.id, deploymentId: req.deploymentId, status: 'crashed', lastError: msg });
      this.finish(req.deploymentId, project.id, 'failed', 'startup', msg, null);
    }
  }

  /** Rollback: re-deploy a previous successful deployment's commit for the project. */
  async rollback(projectId: string, toDeploymentId: string): Promise<{ ok: boolean; error?: string; deploymentId?: string }> {
    const project = this.db.getProject(projectId);
    const target = this.db.getDeployment(toDeploymentId);
    if (!project) return { ok: false, error: 'Project not found' };
    if (!target || target.projectId !== projectId) return { ok: false, error: 'Target deployment not found' };
    if (target.status !== 'succeeded') return { ok: false, error: 'Can only roll back to a successful deployment' };
    const dep = this.db.createDeployment(projectId, { isRollbackOf: toDeploymentId });
    const config = {
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
    };
    this.enqueue({ deploymentId: dep.id, projectId, config });
    this.db.logActivity('deployment.rollback', `Rollback to deployment ${toDeploymentId} started as ${dep.id}`, projectId, dep.id);
    return { ok: true, deploymentId: dep.id };
  }
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
}

export type { Project };
