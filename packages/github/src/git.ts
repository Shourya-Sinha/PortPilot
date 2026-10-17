import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactSecrets, validateRepoUrl, type ValidationResult } from '@portpilot/shared';

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitOptions {
  cwd?: string;
  token?: string | null;
  timeoutMs?: number;
}

const IS_WIN = process.platform === 'win32';

/**
 * Runs the Git CLI with argument arrays (never a concatenated shell string).
 * When a token is supplied it is passed to git through GIT_ASKPASS so it never
 * appears in argv, in the remote URL, or in logs.
 */
export async function runGit(args: string[], opts: GitOptions = {}): Promise<GitResult> {
  const timeout = opts.timeoutMs ?? 120_000;
  const env: NodeJS.ProcessEnv = { ...process.env };
  let askpassFile: string | null = null;

  if (opts.token) {
    askpassFile = path.join(os.tmpdir(), `portpilot-askpass-${process.pid}-${Date.now()}${IS_WIN ? '.cmd' : '.sh'}`);
    const script = IS_WIN
      ? `@echo off\r\necho %PORTPILOT_GIT_TOKEN%\r\n`
      : `#!/bin/sh\necho "$PORTPILOT_GIT_TOKEN"\n`;
    fs.writeFileSync(askpassFile, script, { mode: 0o700 });
    env.GIT_ASKPASS = askpassFile;
    env.PORTPILOT_GIT_TOKEN = opts.token;
    env.GIT_TERMINAL_PROMPT = '0';
  } else {
    env.GIT_TERMINAL_PROMPT = '0';
  }

  try {
    return await new Promise<GitResult>((resolve) => {
      execFile(
        'git',
        ['-c', 'core.longpaths=true', ...args],
        {
          cwd: opts.cwd,
          env,
          timeout,
          maxBuffer: 32 * 1024 * 1024,
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          const code = err && typeof (err as NodeJS.ErrnoException & { code?: number | string }).code === 'number' ? Number((err as { code: number }).code) : err ? 1 : 0;
          resolve({
            ok: !err,
            stdout: redactSecrets(String(stdout ?? '')),
            stderr: redactSecrets(String(stderr ?? '')),
            exitCode: code,
          });
        },
      );
    });
  } finally {
    if (askpassFile) {
      try {
        fs.unlinkSync(askpassFile);
      } catch {
        /* ignore */
      }
    }
  }
}

export function validateGitRepoUrl(url: string): ValidationResult {
  return validateRepoUrl(url);
}

export interface RemoteBranch {
  name: string;
  sha: string;
}

/** Lists remote branches via `git ls-remote --heads` (works without a token for public repos). */
export async function listRemoteBranches(repoUrl: string, token?: string | null): Promise<{ ok: boolean; branches: RemoteBranch[]; error?: string }> {
  const v = validateRepoUrl(repoUrl);
  if (!v.ok) return { ok: false, branches: [], error: v.error };
  const res = await runGit(['ls-remote', '--heads', repoUrl], { token, timeoutMs: 30_000 });
  if (!res.ok) return { ok: false, branches: [], error: res.stderr.split('\n').slice(0, 3).join(' ').trim() || 'git ls-remote failed' };
  const branches: RemoteBranch[] = [];
  for (const line of res.stdout.split('\n')) {
    const m = line.match(/^([0-9a-f]{40})\s+refs\/heads\/(.+)$/);
    if (m) branches.push({ sha: m[1], name: m[2] });
  }
  return { ok: true, branches };
}

/** Clone (or update) a repository into targetDir. Shallow clone for speed. */
export async function cloneOrPull(repoUrl: string, branch: string, targetDir: string, token?: string | null): Promise<GitResult & { commitSha?: string; commitMessage?: string }> {
  const v = validateRepoUrl(repoUrl);
  if (!v.ok) return { ok: false, stdout: '', stderr: v.error ?? 'invalid url', exitCode: 2 };
  const gitDir = path.join(targetDir, '.git');
  if (fs.existsSync(gitDir)) {
    const fetch = await runGit(['fetch', '--depth', '50', 'origin', branch], { cwd: targetDir, token });
    if (!fetch.ok) return fetch;
    const co = await runGit(['checkout', '-B', branch, `origin/${branch}`], { cwd: targetDir, token });
    if (!co.ok) return co;
    const reset = await runGit(['reset', '--hard', `origin/${branch}`], { cwd: targetDir, token });
    if (!reset.ok) return attachHead(reset, targetDir);
    // Keep submodules in sync when the repository uses them. Failure here is
    // reported but does not fail the build: many repos inherit a .gitmodules
    // whose submodules are optional in a production build.
    await runGit(['submodule', 'update', '--init', '--recursive'], { cwd: targetDir, token, timeoutMs: 120_000 });
    return attachHead(reset, targetDir);
  }
  fs.mkdirSync(targetDir, { recursive: true });
  // --recurse-submodules pulls submodule content; Git LFS objects are fetched
  // automatically by git when git-lfs is installed for the user.
  const clone = await runGit(
    ['clone', '--depth', '50', '--branch', branch, '--single-branch', '--recurse-submodules', repoUrl, targetDir],
    { token, timeoutMs: 300_000 },
  );
  return attachHead(clone, targetDir);
}

async function attachHead(res: GitResult, cwd: string): Promise<GitResult & { commitSha?: string; commitMessage?: string }> {
  if (!res.ok) return res;
  const sha = await runGit(['rev-parse', 'HEAD'], { cwd });
  const msg = await runGit(['log', '-1', '--pretty=%s'], { cwd });
  return {
    ...res,
    commitSha: sha.ok ? sha.stdout.trim() : undefined,
    commitMessage: msg.ok ? msg.stdout.trim() : undefined,
  };
}

export async function getHeadCommit(cwd: string): Promise<{ sha: string | null; message: string | null }> {
  const sha = await runGit(['rev-parse', 'HEAD'], { cwd });
  const msg = await runGit(['log', '-1', '--pretty=%s'], { cwd });
  return {
    sha: sha.ok ? sha.stdout.trim() : null,
    message: msg.ok ? msg.stdout.trim() : null,
  };
}

export async function isGitAvailable(): Promise<{ ok: boolean; version: string | null }> {
  const res = await runGit(['--version'], { timeoutMs: 10_000 });
  return { ok: res.ok, version: res.ok ? res.stdout.trim() : null };
}
