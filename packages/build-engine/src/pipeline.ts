import fs from 'node:fs';
import path from 'node:path';
import { cloneOrPull } from '@portpilot/github';
import type { DetectedConfig, DeploymentMode, LogLine, PackageManager, Project } from '@portpilot/shared';
import { nowIso, redactSecrets, validateCommand, validateRelativePath } from '@portpilot/shared';
import { copyDir, dirSize, writeManifest } from './artifact.js';
import { runCommand } from './runner.js';

export interface PipelineOptions {
  project: Project;
  /** Effective config (user-confirmed). */
  config: {
    framework: string;
    deploymentMode: DeploymentMode;
    packageManager: PackageManager;
    installCommand: string | null;
    buildCommand: string | null;
    startCommand: string | null;
    outputDir: string | null;
    projectRoot: string;
    healthCheckPath: string | null;
    preferredPort: number | null;
  };
  /** workspaces/<project>/src */
  sourceDir: string;
  /** artifacts/<project>/<deploymentId> */
  artifactDir: string;
  env: Record<string, string>;
  gitToken?: string | null;
  signal: AbortSignal;
  onLog: (line: LogLine) => void;
}

export interface PipelineResult {
  ok: boolean;
  cancelled: boolean;
  failedPhase: string;
  error: string | null;
  commitSha: string | null;
  commitMessage: string | null;
  artifactPath: string | null;
  runDir: string | null;
  mode: 'static' | 'node';
  durationMs: number;
}

function log(ctx: PipelineOptions, text: string, stream: LogLine['stream'] = 'system'): void {
  ctx.onLog({ ts: nowIso(), stream, text: redactSecrets(text) });
}

async function runPhase(
  ctx: PipelineOptions,
  phase: string,
  command: string | null,
  cwd: string,
  env: Record<string, string>,
): Promise<{ ok: boolean; error?: string; cancelled?: boolean; exitCode?: number | null }> {
  if (!command) {
    log(ctx, `[${phase}] (skipped - no command configured)`);
    return { ok: true };
  }
  const v = validateCommand(command);
  if (!v.ok) {
    log(ctx, `[${phase}] REJECTED: ${v.error}`, 'stderr');
    return { ok: false, error: v.error ?? 'invalid command' };
  }
  log(ctx, `[${phase}] $ ${command}`);
  const res = await runCommand(command, {
    cwd,
    env,
    signal: ctx.signal,
    timeoutMs: 20 * 60_000,
    onLine: (stream, text) => log(ctx, `[${phase}] ${text}`, stream),
  });
  if (res.error === 'cancelled') return { ok: false, cancelled: true, error: 'cancelled', exitCode: res.exitCode };
  if (!res.ok) {
    const err = res.error ?? `exit code ${res.exitCode ?? 'unknown'}`;
    log(ctx, `[${phase}] FAILED after ${Math.round(res.durationMs / 1000)}s (${err})`, 'stderr');
    return { ok: false, error: `Command failed in phase ${phase}: ${err}`, exitCode: res.exitCode };
  }
  log(ctx, `[${phase}] completed in ${Math.round(res.durationMs / 1000)}s`);
  return { ok: true, exitCode: 0 };
}

/**
 * Full build lifecycle:
 *   checkout -> detect -> install -> build -> artifact preparation
 * Port allocation / startup / health-check are handled by the runtime manager
 * and worker after this returns.
 */
export async function runBuildPipeline(ctx: PipelineOptions): Promise<PipelineResult> {
  const started = Date.now();
  const base: Omit<PipelineResult, 'durationMs'> = {
    ok: false,
    cancelled: false,
    failedPhase: 'checkout',
    error: null,
    commitSha: null,
    commitMessage: null,
    artifactPath: null,
    runDir: null,
    mode: ctx.config.deploymentMode === 'static' ? 'static' : 'node',
  };
  const fail = (phase: string, error: string, cancelled = false): PipelineResult => ({
    ...base,
    failedPhase: phase,
    error,
    cancelled,
    durationMs: Date.now() - started,
  });

  // ---- 1. checkout ----
  log(ctx, '==> Phase: repository checkout');
  if (ctx.signal.aborted) return fail('checkout', 'cancelled', true);
  const co = await cloneOrPull(ctx.project.repoUrl, ctx.project.branch, ctx.sourceDir, ctx.gitToken ?? null);
  if (!co.ok) {
    log(ctx, `Checkout failed: ${co.stderr}`, 'stderr');
    return fail('checkout', `Git checkout failed: ${co.stderr.split('\n')[0] ?? 'unknown error'}`);
  }
  log(ctx, `Checked out ${ctx.project.repoUrl} @ ${ctx.project.branch}`);
  if (co.commitSha) log(ctx, `HEAD ${co.commitSha.slice(0, 12)} ${co.commitMessage ?? ''}`);
  base.commitSha = co.commitSha ?? null;
  base.commitMessage = co.commitMessage ?? null;

  const projDir = path.resolve(ctx.sourceDir, ctx.config.projectRoot || '.');
  if (!fs.existsSync(projDir)) {
    return fail('detect', `Project root "${ctx.config.projectRoot}" does not exist in the repository.`);
  }

  // ---- 2. detect / verify config ----
  log(ctx, '==> Phase: framework / configuration');
  if (ctx.signal.aborted) return fail('detect', 'cancelled', true);
  log(ctx, `Framework: ${ctx.config.framework}, mode: ${ctx.config.deploymentMode}, package manager: ${ctx.config.packageManager}`);
  log(ctx, `install=${ctx.config.installCommand ?? '(none)'} build=${ctx.config.buildCommand ?? '(none)'} start=${ctx.config.startCommand ?? '(none)'}`);

  // Java toolchain check
  if (ctx.config.deploymentMode === 'java-maven' || ctx.config.deploymentMode === 'java-gradle') {
    const tool = ctx.config.deploymentMode === 'java-maven' ? 'mvn -v' : 'gradle -v';
    const check = await runCommand(tool, { cwd: projDir, signal: ctx.signal, timeoutMs: 30_000 });
    if (!check.ok) {
      return fail('detect', `${tool.split(' ')[0]} is not available on this PC. Install the required JDK and build tools, then retry.`);
    }
  }

  // ---- 3. install ----
  log(ctx, '==> Phase: dependency installation');
  if (ctx.signal.aborted) return fail('install', 'cancelled', true);
  const installEnv = { ...ctx.env };
  const inst = await runPhase(ctx, 'install', ctx.config.installCommand, projDir, installEnv);
  if (!inst.ok) {
    if (inst.cancelled) return fail('install', 'cancelled', true);
    // Retry npm ci -> npm install fallback when lockfile is missing/out of sync.
    if (ctx.config.installCommand === 'npm ci') {
      log(ctx, 'npm ci failed; retrying once with "npm install"...');
      const retry = await runPhase(ctx, 'install', 'npm install', projDir, installEnv);
      if (!retry.ok) return fail('install', retry.cancelled ? 'cancelled' : (retry.error ?? 'install failed'), retry.cancelled === true);
    } else {
      return fail('install', inst.error ?? 'install failed');
    }
  }

  // ---- 4. build ----
  log(ctx, '==> Phase: build');
  if (ctx.signal.aborted) return fail('build', 'cancelled', true);
  const bld = await runPhase(ctx, 'build', ctx.config.buildCommand, projDir, installEnv);
  if (!bld.ok) return fail('build', bld.cancelled ? 'cancelled' : (bld.error ?? 'build failed'), bld.cancelled === true);

  // ---- 5. artifact preparation ----
  log(ctx, '==> Phase: artifact preparation');
  if (ctx.signal.aborted) return fail('artifact', 'cancelled', true);
  try {
    fs.mkdirSync(ctx.artifactDir, { recursive: true });
    if (base.mode === 'static') {
      const outRel = ctx.config.outputDir && ctx.config.outputDir !== '.' ? ctx.config.outputDir : null;
      let outDir = projDir;
      if (outRel) {
        const rv = validateRelativePath(outRel);
        if (!rv.ok) return fail('artifact', `Invalid output directory: ${rv.error}`);
        outDir = path.resolve(projDir, outRel);
      }
      if (!fs.existsSync(outDir)) {
        return fail('artifact', `Output directory "${ctx.config.outputDir ?? '.'}" was not produced by the build.`);
      }
      const staticTarget = path.join(ctx.artifactDir, 'public');
      copyDir(outDir, staticTarget);
      const size = dirSize(staticTarget);
      writeManifest(ctx.artifactDir, {
        deploymentId: path.basename(ctx.artifactDir),
        projectId: ctx.project.id,
        createdAt: nowIso(),
        mode: 'static',
        staticDir: staticTarget,
        runDir: null,
        commitSha: base.commitSha,
        sizeBytes: size,
      });
      log(ctx, `Static artifact prepared (${(size / 1024).toFixed(1)} KiB) at ${staticTarget}`);
      base.artifactPath = staticTarget;
    } else {
      writeManifest(ctx.artifactDir, {
        deploymentId: path.basename(ctx.artifactDir),
        projectId: ctx.project.id,
        createdAt: nowIso(),
        mode: 'node',
        staticDir: null,
        runDir: projDir,
        commitSha: base.commitSha,
        sizeBytes: dirSize(projDir),
      });
      // Node apps run from the source workspace (node_modules lives there);
      // a small run marker is written so rollback can find the commit.
      fs.writeFileSync(path.join(ctx.artifactDir, 'run.json'), JSON.stringify({ runDir: projDir, commitSha: base.commitSha }, null, 2));
      log(ctx, `Runtime directory recorded: ${projDir}`);
      base.artifactPath = ctx.artifactDir;
      base.runDir = projDir;
    }
  } catch (err) {
    return fail('artifact', `Artifact preparation failed: ${String(err)}`);
  }

  log(ctx, '==> Build lifecycle complete: port allocation, startup and health check follow.');
  return { ...base, ok: true, failedPhase: '', error: null, durationMs: Date.now() - started };
}

export type { DetectedConfig };
