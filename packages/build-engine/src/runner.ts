import { spawn, type ChildProcess } from 'node:child_process';
import { redactSecrets, validateCommand, nowIso } from '@portpilot/shared';

export interface RunCommandOptions {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  onLine?: (stream: 'stdout' | 'stderr', text: string) => void;
}

export interface RunCommandResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
}

const IS_WIN = process.platform === 'win32';

/** Kill a process and all of its children (Windows taskkill /T, POSIX process group). */
export function killTree(pid: number): void {
  try {
    if (IS_WIN) {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        process.kill(pid, 'SIGTERM');
      }
      setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* already gone */
          }
        }
      }, 3000).unref();
    }
  } catch {
    /* already exited */
  }
}

/**
 * Executes a user-configured command. The command string is validated first
 * (no chaining/redirection/substitution) and then run through the platform
 * shell. This is NOT a sandbox: treat repository build scripts as untrusted
 * code with the same privileges as PortPilot itself.
 */
export async function runCommand(command: string, opts: RunCommandOptions): Promise<RunCommandResult> {
  const v = validateCommand(command);
  if (!v.ok) {
    return { ok: false, exitCode: null, stdout: '', stderr: '', durationMs: 0, error: v.error ?? 'Invalid command' };
  }
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const started = Date.now();

  return await new Promise<RunCommandResult>((resolve) => {
    let child: ChildProcess;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...opts.env,
      // Encourage child tools to be quiet/CI-friendly and to fail on missing scripts.
      CI: process.env.CI ?? '1',
      FORCE_COLOR: '0',
      GIT_TERMINAL_PROMPT: '0',
    };
    if (IS_WIN) {
      child = spawn('cmd.exe', ['/d', '/s', '/c', command], {
        cwd: opts.cwd,
        env,
        windowsHide: true,
        timeout: timeoutMs,
      });
    } else {
      child = spawn('/bin/sh', ['-c', command], {
        cwd: opts.cwd,
        env,
        timeout: timeoutMs,
        detached: true,
      });
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let aborted = false;

    const finish = (exitCode: number | null, error?: string) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        ok: exitCode === 0 && !aborted,
        exitCode,
        stdout: redactSecrets(stdout),
        stderr: redactSecrets(stderr),
        durationMs: Date.now() - started,
        error: aborted ? 'cancelled' : error,
      });
    };

    const onAbort = () => {
      aborted = true;
      if (child.pid) killTree(child.pid);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const makeLineReader = (stream: 'stdout' | 'stderr', sink: (chunk: string) => void) => {
      let buf = '';
      return (chunk: Buffer) => {
        sink(chunk.toString('utf8'));
        buf += chunk.toString('utf8');
        let idx: number;
        while ((idx = buf.search(/\r?\n/)) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + (buf[idx] === '\r' ? 2 : 1));
          if (line.trim().length > 0) opts.onLine?.(stream, redactSecrets(line));
        }
      };
    };

    child.stdout?.on('data', makeLineReader('stdout', (c) => (stdout += c)));
    child.stderr?.on('data', makeLineReader('stderr', (c) => (stderr += c)));

    child.on('error', (err) => {
      opts.onLine?.('stderr', redactSecrets(String(err.message)));
      finish(null, String(err.message));
    });

    child.on('close', (code, signal) => {
      const rest = (stdout + '\n' + stderr).split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (rest.length) {
        // Flush any trailing lines without newline.
        const tail = (code === 0 ? stdout : stderr).split(/\r?\n/).filter((l) => l.trim().length > 0);
        void tail;
      }
      if (signal) finish(null, `terminated by ${signal}`);
      else finish(code);
    });
  });
}

/** Simple structured log entry used by the pipeline. */
export function systemLog(text: string): { ts: string; stream: 'system'; text: string } {
  return { ts: nowIso(), stream: 'system', text: redactSecrets(text) };
}
