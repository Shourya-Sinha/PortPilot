import { runGit } from '@portpilot/github';
import type { AppContext } from './context.js';

/**
 * Git poller: the fallback for automatic redeploys.
 *
 * GitHub webhooks need a URL GitHub can reach. A home PC behind NAT/CGNAT
 * usually cannot receive them, so "auto-redeploy on push" would otherwise not
 * work at all. This poller asks GitHub (outbound only, no open ports) whether
 * the branch head changed, and queues a deployment when it did.
 *
 * It is intentionally conservative:
 *   - only projects that have been deployed successfully at least once
 *   - never while a deployment for that project is queued or running
 *   - never for a commit that is already the active deployment
 */
export class GitPoller {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly ctx: AppContext,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.intervalMs <= 0 || this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    // Do not keep the process alive just for polling.
    this.timer.unref?.();
    this.ctx.logger.info(`Git poller started (every ${Math.round(this.intervalMs / 1000)}s). Auto-redeploys on new commits without inbound webhooks.`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed for tests and for a manual "check now" action. */
  async tick(): Promise<{ checked: number; redeployed: string[] }> {
    if (this.ticking) return { checked: 0, redeployed: [] };
    this.ticking = true;
    const redeployed: string[] = [];
    let checked = 0;
    try {
      const { db, queue, logger } = this.ctx;
      for (const project of db.listProjects()) {
        if (!project.configConfirmed) continue;
        const active = project.activeDeploymentId ? db.getDeployment(project.activeDeploymentId) : null;
        if (!active || active.status !== 'succeeded') continue;

        // Skip projects that are already deploying.
        const recent = db.listDeployments({ projectId: project.id, limit: 5 });
        if (recent.some((d) => d.status === 'queued' || d.status === 'running')) continue;

        checked += 1;
        const token = db.resolveGithubToken(project.githubTokenRef);
        const res = await runGit(['ls-remote', project.repoUrl, `refs/heads/${project.branch}`], { token, timeoutMs: 30_000 });
        if (!res.ok) {
          logger.warn(`Poller: could not read ${project.repoUrl} (${project.branch}): ${res.stderr.split('\n')[0]}`);
          continue;
        }
        const sha = res.stdout.trim().split(/\s+/)[0] ?? '';
        if (!/^[0-9a-f]{40}$/.test(sha)) continue;
        if (sha === active.commitSha) continue;

        // New commit on the tracked branch: queue a deployment using the
        // project's confirmed configuration.
        const dep = db.createDeployment(project.id);
        queue.enqueue({
          deploymentId: dep.id,
          projectId: project.id,
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
        redeployed.push(project.id);
        logger.info(`Poller: ${project.name} has new commit ${sha.slice(0, 8)} (was ${active.commitSha?.slice(0, 8) ?? 'unknown'}) — redeploy queued as ${dep.id}`);
        db.logActivity('deployment.poller', `New commit ${sha.slice(0, 8)} detected; deployment ${dep.id} queued`, project.id, dep.id);
      }
    } catch (err) {
      this.ctx.logger.warn(`Poller tick failed: ${String(err)}`);
    } finally {
      this.ticking = false;
    }
    return { checked, redeployed };
  }
}
