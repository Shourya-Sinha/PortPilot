import path from 'node:path';
import { getPaths, nowIso } from '@portpilot/shared';
import type { PortPilotDb } from '@portpilot/database';
import type { RuntimeSupervisor } from '@portpilot/runtime-manager';
import type { HostnameManager } from '@portpilot/hostname-manager';
import { isSpaFramework } from '@portpilot/build-engine';

export interface StartedApp {
  ok: boolean;
  port?: number;
  pid?: number | null;
  error?: string;
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Start a project from its active successful deployment.
 *
 * Shared by the manual /start endpoint and by the boot-time autostart path, so
 * a restarted PortPilot brings previously running applications back up the same
 * way a user would start them by hand.
 */
export async function startProjectFromDeployment(
  db: PortPilotDb,
  supervisor: RuntimeSupervisor,
  hostnames: HostnameManager,
  projectId: string,
): Promise<StartedApp> {
  const project = db.getProject(projectId);
  if (!project) return { ok: false, error: 'Project not found' };

  const dep = project.activeDeploymentId
    ? db.getDeployment(project.activeDeploymentId)
    : db.listDeployments({ projectId }).find((d) => d.status === 'succeeded');
  if (!dep || dep.status !== 'succeeded' || !dep.artifactPath) {
    return { ok: false, error: 'No successful deployment to start. Deploy first.' };
  }

  const paths = getPaths();
  const mode = project.deploymentMode === 'static' ? 'static' : 'node';
  const runDir = mode === 'static' ? dep.artifactPath : (dep.workspacePath ?? dep.artifactPath);
  const logFile = path.join(paths.runtimeLogDir, `${sanitize(project.websiteName)}.log`);

  try {
    const proc = await supervisor.start({
      projectId,
      deploymentId: dep.id,
      mode,
      runDir,
      startCommand: project.startCommand,
      preferredPort: project.preferredPort ?? dep.port,
      env: db.getEnvPlain(projectId),
      healthCheckPath: project.healthCheckPath,
      spa: isSpaFramework(project.framework),
      logFile,
    });
    db.setRuntime({ projectId, deploymentId: dep.id, status: 'running', pid: proc.pid, port: proc.port, cwd: runDir, startedAt: nowIso() });
    hostnames.syncRoute(projectId, proc.port ?? 0);
    return { ok: true, port: proc.port ?? undefined, pid: proc.pid };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.setRuntime({ projectId, deploymentId: dep.id, status: 'crashed', pid: null, port: null, cwd: runDir, lastError: message });
    return { ok: false, error: message };
  }
}
