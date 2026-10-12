import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { killTree, runCommand } from '@portpilot/build-engine';
import { nowIso, redactSecrets, validateCommand, type LogLine, type RuntimeStatus } from '@portpilot/shared';
import { allocatePort } from './ports.js';
import { createStaticServer, listenServer } from './static-server.js';

export interface ManagedProcess {
  projectId: string;
  deploymentId: string;
  kind: 'node' | 'static';
  pid: number | null;
  port: number | null;
  cwd: string | null;
  status: RuntimeStatus;
  startedAt: string | null;
  child: ChildProcess | null;
  staticServer: http.Server | null;
  lastError: string | null;
}

export interface StartAppOptions {
  projectId: string;
  deploymentId: string;
  mode: 'static' | 'node';
  /** Static: directory to serve. Node: working directory of the start command. */
  runDir: string;
  startCommand?: string | null;
  preferredPort?: number | null;
  env?: Record<string, string>;
  healthCheckPath?: string | null;
  logFile: string;
  onLog?: (line: LogLine) => void;
}

const IS_WIN = process.platform === 'win32';

/**
 * Supervises deployed applications: allocates ports, launches processes or
 * static servers bound to 127.0.0.1, writes runtime logs, performs health
 * checks and supports graceful shutdown. Prevents duplicate launches per
 * project.
 */
export class RuntimeSupervisor {
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly startLocks = new Map<string, Promise<unknown>>();

  get(projectId: string): ManagedProcess | undefined {
    return this.processes.get(projectId);
  }

  list(): ManagedProcess[] {
    return [...this.processes.values()];
  }

  /** Restore in-memory state after a platform restart; checks whether the PID is still alive. */
  restoreFromState(projectId: string, state: { deploymentId: string | null; pid: number | null; port: number | null; cwd: string | null; startedAt: string | null }): ManagedProcess {
    let status: RuntimeStatus = 'stopped';
    if (state.pid != null && isPidAlive(state.pid)) status = 'running';
    else if (state.pid != null) status = 'crashed';
    const proc: ManagedProcess = {
      projectId,
      deploymentId: state.deploymentId ?? '',
      kind: 'node',
      pid: state.pid,
      port: state.port,
      cwd: state.cwd,
      status,
      startedAt: state.startedAt,
      child: null,
      staticServer: null,
      lastError: status === 'crashed' ? 'Process was not running when PortPilot restarted.' : null,
    };
    this.processes.set(projectId, proc);
    return proc;
  }

  async start(opts: StartAppOptions): Promise<ManagedProcess> {
    const existing = this.processes.get(opts.projectId);
    if (existing && (existing.status === 'running' || existing.status === 'starting')) {
      throw new Error(`Project ${opts.projectId} is already running (pid ${existing.pid ?? 'n/a'}). Stop it first to avoid duplicate processes.`);
    }
    const inflight = this.startLocks.get(opts.projectId);
    if (inflight) {
      await inflight.then(() => undefined, () => undefined);
    }
    const promise = this.doStart(opts);
    this.startLocks.set(
      opts.projectId,
      promise.then(() => undefined, () => undefined),
    );
    try {
      return await promise;
    } finally {
      this.startLocks.delete(opts.projectId);
    }
  }

  private async doStart(opts: StartAppOptions): Promise<ManagedProcess> {
    fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
    const logStream = fs.createWriteStream(opts.logFile, { flags: 'a' });
    const emit = (stream: LogLine['stream'], text: string) => {
      const line: LogLine = { ts: nowIso(), stream, text: redactSecrets(text) };
      if (logStream.writable && !logStream.destroyed) {
        try {
          logStream.write(`${line.ts} [${line.stream}] ${line.text}\n`);
        } catch {
          /* stream closed */
        }
      }
      opts.onLog?.(line);
    };

    const port = await allocatePort(opts.preferredPort ?? null);
    if (!port) {
      logStream.end();
      throw new Error('No free local port could be allocated in range 4300-4999.');
    }

    const record: ManagedProcess = {
      projectId: opts.projectId,
      deploymentId: opts.deploymentId,
      kind: opts.mode === 'static' ? 'static' : 'node',
      pid: null,
      port,
      cwd: opts.runDir,
      status: 'starting',
      startedAt: nowIso(),
      child: null,
      staticServer: null,
      lastError: null,
    };
    this.processes.set(opts.projectId, record);
    emit('system', `Port ${port} allocated on 127.0.0.1`);

    try {
      if (opts.mode === 'static') {
        const server = createStaticServer(opts.runDir, { spa: true });
        await listenServer(server, port, '127.0.0.1');
        record.staticServer = server;
        record.status = 'running';
        emit('system', `Static file server started for ${opts.runDir}`);
      } else {
        const cmd = opts.startCommand?.trim();
        if (!cmd) throw new Error('No start command configured for this application.');
        const v = validateCommand(cmd);
        if (!v.ok) throw new Error(`Start command rejected: ${v.error}`);
        emit('system', `$ ${cmd}`);
        const child = spawn(IS_WIN ? 'cmd.exe' : '/bin/sh', IS_WIN ? ['/d', '/s', '/c', cmd] : ['-c', cmd], {
          cwd: opts.runDir,
          env: {
            ...process.env,
            ...opts.env,
            PORT: String(port),
            HOSTNAME: '127.0.0.1',
            FORCE_COLOR: '0',
          },
          windowsHide: true,
          detached: !IS_WIN,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        record.child = child;
        record.pid = child.pid ?? null;
        child.stdout?.on('data', (b: Buffer) => emit('stdout', b.toString('utf8')));
        child.stderr?.on('data', (b: Buffer) => emit('stderr', b.toString('utf8')));
        child.on('error', (err) => {
          record.status = 'crashed';
          record.lastError = String(err.message);
          emit('stderr', `Process error: ${err.message}`);
        });
        child.on('exit', (code, signal) => {
          if (record.status !== 'stopped') {
            record.status = code === 0 || signal ? 'stopped' : 'crashed';
            record.lastError = code !== 0 && code != null ? `Exited with code ${code}` : signal ? `Terminated by ${signal}` : null;
          }
          emit('system', `Process exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`);
          logStream.end();
        });
        record.status = 'running';
        emit('system', `Application started (pid ${record.pid})`);
      }
    } catch (err) {
      record.status = 'crashed';
      record.lastError = String(err);
      emit('stderr', `Startup failed: ${String(err)}`);
      logStream.end();
      throw err;
    }
    return record;
  }

  async stop(projectId: string, opts: { force?: boolean } = {}): Promise<void> {
    const rec = this.processes.get(projectId);
    if (!rec) return;
    rec.status = 'stopped';
    if (rec.staticServer) {
      await new Promise<void>((resolve) => rec.staticServer?.close(() => resolve()));
      rec.staticServer = null;
    }
    if (rec.child?.pid) {
      killTree(rec.child.pid);
      if (!opts.force) {
        await new Promise((r) => setTimeout(r, 400));
      }
      rec.child = null;
    } else if (rec.pid && isPidAlive(rec.pid)) {
      // Restored process (no handle): kill by pid.
      killTree(rec.pid);
    }
    rec.pid = null;
    rec.status = 'stopped';
  }

  async healthCheck(port: number, healthPath = '/', timeoutMs = 4000): Promise<{ ok: boolean; statusCode: number | null; error?: string }> {
    return await new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: healthPath || '/', method: 'GET', timeout: timeoutMs },
        (res) => {
          const ok = res.statusCode != null && res.statusCode < 500;
          res.resume();
          resolve({ ok, statusCode: res.statusCode ?? null });
        },
      );
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, statusCode: null, error: 'health check timed out' });
      });
      req.on('error', (err) => resolve({ ok: false, statusCode: null, error: String(err.message) }));
      req.end();
    });
  }

  async waitForHealth(port: number, healthPath: string | null, attempts = 15, delayMs = 1000): Promise<{ ok: boolean; statusCode: number | null; error?: string }> {
    let last: { ok: boolean; statusCode: number | null; error?: string } = { ok: false, statusCode: null, error: 'not attempted' };
    for (let i = 0; i < attempts; i++) {
      last = await this.healthCheck(port, healthPath ?? '/');
      if (last.ok) return last;
      await new Promise((r) => setTimeout(r, delayMs));
    }
    return last;
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Verify java/maven availability; used before java builds. */
export async function toolAvailable(command: string): Promise<boolean> {
  const v = validateCommand(command);
  if (!v.ok) return false;
  const res = await runCommand(command, { cwd: process.cwd(), timeoutMs: 20_000 });
  return res.ok;
}
