import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';

/**
 * Cross-platform git credential delivery.
 *
 * Two mechanisms can hand a token to git without ever putting it in a command
 * line, a remote URL, or a log:
 *
 *   1. `credential.helper` — a tiny Node program that reads the token from the
 *      environment and prints `username`/`password`. Git runs it through its
 *      own shell, so it behaves identically on Windows, macOS and Linux and
 *      never requires an executable bit or a `.cmd` shim.
 *   2. `GIT_ASKPASS` — the traditional approach. On Windows it needs a `.cmd`
 *      wrapper whose `echo %VAR%` is fragile with special characters, and some
 *      git builds invoke it in ways that do not accept a `.cmd`.
 *
 * This module prefers the helper and falls back to askpass, and it can *prove*
 * which one works on the current machine via `verifyGitCredentialTransport()`.
 * That turns "supports Windows, probably" into a check the user can run.
 */

export type CredentialStrategy = 'helper' | 'askpass';

export interface RunAsks {
  cwd?: string;
  timeoutMs?: number;
}

const IS_WIN = process.platform === 'win32';

/** Contents of the GIT_ASKPASS script for a given platform (pure, testable). */
export function askpassScript(platform: NodeJS.Platform, varName = 'PORTPILOT_GIT_TOKEN'): string {
  return platform === 'win32'
    ? `@echo off\r\nsetlocal\r\necho %${varName}%\r\n`
    : `#!/bin/sh\necho "$${varName}"\n`;
}

/** Contents of the credential-helper program (pure, testable). */
export function credentialHelperScript(varName = 'PORTPILOT_GIT_TOKEN'): string {
  // CommonJS so it runs regardless of the nearest package.json "type".
  return [
    '// PortPilot git credential helper. Token comes from the environment only.',
    'const token = process.env.' + varName + ' || "";',
    'if (token) {',
    '  process.stdout.write("username=x-access-token\\n");',
    '  process.stdout.write("password=" + token + "\\n");',
    '}',
    '',
  ].join('\n');
}

export interface CredentialFiles {
  strategy: CredentialStrategy;
  /** Temp files created; delete after the git call. */
  files: string[];
  /** Environment additions for the git process. */
  env: Record<string, string>;
  /** Extra `-c` arguments to pass to git. */
  config: string[];
}

function tempFile(prefix: string, ext: string, body: string, mode: number): string {
  const file = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  fs.writeFileSync(file, body, { mode });
  return file;
}

/** Quote a path for git's shell (`-c key=!command` is executed by sh). */
function shellQuote(p: string): string {
  return IS_WIN ? `"${p.replace(/"/g, '\\"')}"` : `'${p.replace(/'/g, `'\\''`)}'`;
}

export function createCredentialFiles(token: string, strategy: CredentialStrategy): CredentialFiles {
  const varName = 'PORTPILOT_GIT_TOKEN';
  if (strategy === 'helper') {
    const helper = tempFile('portpilot-cred', '.cjs', credentialHelperScript(varName), 0o600);
    // An empty helper first clears any system/global helper so only ours runs.
    return {
      strategy,
      files: [helper],
      env: { [varName]: token, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      config: ['-c', 'credential.helper=', '-c', `credential.helper=!${shellQuote(process.execPath)} ${shellQuote(helper)}`],
    };
  }
  const askpass = tempFile('portpilot-askpass', IS_WIN ? '.cmd' : '.sh', askpassScript(process.platform, varName), 0o700);
  return {
    strategy,
    files: [askpass],
    env: { [varName]: token, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0' },
    config: [],
  };
}

export function cleanupCredentialFiles(files: CredentialFiles): void {
  for (const f of files.files) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* already gone */
    }
  }
}

export function runGitRaw(args: string[], env: NodeJS.ProcessEnv, opts: RunAsks = {}): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd: opts.cwd, env, timeout: opts.timeoutMs ?? 20_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException & { code?: number | string }).code === 'number' ? Number((err as { code: number }).code) : err ? 1 : 0;
        resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code });
      },
    );
  });
}

/**
 * Prove, on this machine and right now, that a token reaches the remote.
 *
 * A throwaway HTTP server answers 401 (so git retries with credentials) and
 * records the Authorization header. This works identically on Windows, macOS
 * and Linux, and it is the only way to tell "token sent" from "no token sent":
 * GitHub deliberately returns the same error for both.
 */
export async function verifyGitCredentialTransport(
  token = `portpilot-selftest-${Date.now()}`,
  strategy: CredentialStrategy | 'auto' = 'auto',
): Promise<{ ok: boolean; strategy: CredentialStrategy | null; detail: string; tokenSeen: boolean }> {
  const seen: (string | null)[] = [];
  const server = http.createServer((req, res) => {
    seen.push((req.headers.authorization as string | undefined) ?? null);
    res.writeHead(401, { 'www-authenticate': 'Basic realm="portpilot-selftest"' }).end();
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });

  const strategies: CredentialStrategy[] = strategy === 'auto' ? ['helper', 'askpass'] : [strategy];
  try {
    for (const s of strategies) {
      seen.length = 0;
      const creds = createCredentialFiles(token, s);
      try {
        await runGitRaw([...creds.config, 'ls-remote', `http://127.0.0.1:${port}/probe.git`], { ...process.env, ...creds.env }, { timeoutMs: 15_000 });
      } finally {
        cleanupCredentialFiles(creds);
      }
      const tokenSeen = seen.some((h) => {
        if (!h) return false;
        const decoded = Buffer.from(h.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
        return decoded.includes(token);
      });
      if (tokenSeen) {
        return { ok: true, strategy: s, detail: `${s} delivered the token to the remote`, tokenSeen };
      }
    }
    return {
      ok: false,
      strategy: null,
      detail: 'no credential reached the remote; git may be ignoring the helper/askpass on this platform',
      tokenSeen: false,
    };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** True when git exists and runs. */
export async function gitAvailable(): Promise<{ ok: boolean; version: string | null }> {
  const res = await runGitRaw(['--version'], { ...process.env }, { timeoutMs: 10_000 });
  return { ok: res.ok, version: res.ok ? res.stdout.trim() : null };
}
