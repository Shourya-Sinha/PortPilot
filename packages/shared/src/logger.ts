import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerOptions {
  name: string;
  logDir?: string;
  toConsole?: boolean;
  level?: LogLevel;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Structured logger writing redacted lines to console and rotating log files.
 * Log filenames are sanitized so untrusted names can't traverse paths.
 */
export class Logger {
  private readonly name: string;
  private readonly logDir: string | null;
  private readonly toConsole: boolean;
  private readonly level: LogLevel;
  private stream: fs.WriteStream | null = null;
  private streamPath: string | null = null;

  constructor(opts: LoggerOptions) {
    this.name = opts.name;
    this.logDir = opts.logDir ?? null;
    this.toConsole = opts.toConsole ?? true;
    this.level = opts.level ?? 'info';
  }

  private write(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const text = redactSecrets(meta ? `${msg} ${safeJson(meta)}` : msg);
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] [${this.name}] ${text}`;
    if (this.toConsole) {
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    }
    if (this.logDir) {
      try {
        if (!this.stream) {
          fs.mkdirSync(this.logDir, { recursive: true });
          const file = `${sanitize(this.name)}-${new Date().toISOString().slice(0, 10)}.log`;
          this.streamPath = path.join(this.logDir, file);
          this.stream = fs.createWriteStream(this.streamPath, { flags: 'a' });
        }
        this.stream.write(`${line}\n`);
      } catch {
        // Never let logging crash the platform.
      }
    }
  }

  debug(msg: string, meta?: Record<string, unknown>): void {
    this.write('debug', msg, meta);
  }
  info(msg: string, meta?: Record<string, unknown>): void {
    this.write('info', msg, meta);
  }
  warn(msg: string, meta?: Record<string, unknown>): void {
    this.write('warn', msg, meta);
  }
  error(msg: string, meta?: Record<string, unknown>): void {
    this.write('error', msg, meta);
  }
  child(suffix: string): Logger {
    return new Logger({ name: `${this.name}:${suffix}`, logDir: this.logDir ?? undefined, toConsole: this.toConsole, level: this.level });
  }
  close(): void {
    this.stream?.end();
    this.stream = null;
  }
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
}

function safeJson(obj: Record<string, unknown>): string {
  try {
    return redactSecrets(JSON.stringify(obj));
  } catch {
    return '[unserializable]';
  }
}

export function createLogger(name: string, logDir?: string): Logger {
  return new Logger({ name, logDir: logDir ?? process.env.PORTPILOT_LOGS_DIR });
}

/**
 * Global app-wide event bus used to fan out log lines and status changes to
 * SSE subscribers in the API.
 */
export interface AppEvents {
  'deployment:log': { deploymentId: string; projectId: string; ts: string; stream: 'stdout' | 'stderr' | 'system'; text: string };
  'deployment:status': { deploymentId: string; projectId: string; status: string; phase: string; error?: string | null };
  'runtime:status': { projectId: string; status: string; pid: number | null; port: number | null };
  'activity': { id: string; type: string; message: string; projectId: string | null; deploymentId: string | null; createdAt: string };
  'dns:status': { status: string; port: number | null; error?: string | null };
  'proxy:status': { status: string; port: number | null; error?: string | null };
}

class TypedBus extends EventEmitter {
  override emit<K extends keyof AppEvents>(event: K, payload: AppEvents[K]): boolean {
    return super.emit(event, payload);
  }
  override on<K extends keyof AppEvents>(event: K, listener: (payload: AppEvents[K]) => void): this {
    return super.on(event, listener);
  }
  override off<K extends keyof AppEvents>(event: K, listener: (payload: AppEvents[K]) => void): this {
    return super.off(event, listener);
  }
}

export const appEvents = new TypedBus();
appEvents.setMaxListeners(200);
