import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';
import { SecretBox } from './crypto.js';
import {
  type ActivityEvent,
  type Deployment,
  type DeploymentPhase,
  type DeploymentStatus,
  type EnvVar,
  type HostnameMode,
  type HostnameReachabilityStatus,
  type HostnameRecord,
  type HostnameResolutionStatus,
  type Project,
  type RuntimeInfo,
  type RuntimeStatus,
  generateId,
  maskValue,
  nowIso,
} from '@portpilot/shared';

// node:sqlite is a Node.js builtin (22.5+). It is loaded via createRequire so
// that bundlers/test runners which don't know the module name still work.
// The ExperimentalWarning is filtered: it is expected and noisy in logs.
const originalEmitWarning = process.emitWarning.bind(process);
(process as { emitWarning: typeof process.emitWarning }).emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : String((warning as Error).message ?? warning);
  if (text.includes('SQLite is an experimental feature')) return;
  return (originalEmitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync: DatabaseSyncCtor } = nodeRequire('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };
type DatabaseSync = DatabaseSyncType;

type Row = Record<string, unknown>;

function str(v: unknown): string {
  return v == null ? '' : String(v);
}
function nstr(v: unknown): string | null {
  return v == null ? null : String(v);
}
function num(v: unknown): number | null {
  return v == null ? null : Number(v);
}
function bool(v: unknown): boolean {
  return Number(v) === 1;
}

function rowToProject(r: Row): Project {
  return {
    id: str(r.id),
    name: str(r.name),
    websiteName: str(r.website_name),
    repoUrl: str(r.repo_url),
    branch: str(r.branch),
    projectRoot: str(r.project_root),
    framework: str(r.framework) as Project['framework'],
    deploymentMode: str(r.deployment_mode) as Project['deploymentMode'],
    packageManager: str(r.package_manager) as Project['packageManager'],
    installCommand: nstr(r.install_command),
    buildCommand: nstr(r.build_command),
    startCommand: nstr(r.start_command),
    outputDir: nstr(r.output_dir),
    preferredPort: num(r.preferred_port),
    healthCheckPath: nstr(r.health_check_path),
    hostnameMode: str(r.hostname_mode) as HostnameMode,
    publicHostname: nstr(r.public_hostname),
    configConfirmed: bool(r.config_confirmed),
    webhookSecret: nstr(r.webhook_secret),
    githubTokenRef: nstr(r.github_token_ref),
    lastCommitSha: nstr(r.last_commit_sha),
    activeDeploymentId: nstr(r.active_deployment_id),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

function rowToDeployment(r: Row): Deployment {
  return {
    id: str(r.id),
    projectId: str(r.project_id),
    status: str(r.status) as DeploymentStatus,
    phase: str(r.phase) as DeploymentPhase,
    commitSha: nstr(r.commit_sha),
    commitMessage: nstr(r.commit_message),
    port: num(r.port),
    pid: num(r.pid),
    artifactPath: nstr(r.artifact_path),
    workspacePath: nstr(r.workspace_path),
    error: nstr(r.error),
    exitCode: num(r.exit_code),
    isRollbackOf: nstr(r.is_rollback_of),
    createdAt: str(r.created_at),
    startedAt: nstr(r.started_at),
    finishedAt: nstr(r.finished_at),
    durationMs: num(r.duration_ms),
  };
}

function rowToHostname(r: Row): HostnameRecord {
  return {
    id: str(r.id),
    projectId: nstr(r.project_id),
    hostname: str(r.hostname),
    mode: str(r.mode) as HostnameMode,
    targetPort: num(r.target_port),
    publicHostname: nstr(r.public_hostname),
    httpsEnabled: bool(r.https_enabled),
    resolutionStatus: str(r.resolution_status) as HostnameResolutionStatus,
    reachabilityStatus: str(r.reachability_status) as HostnameReachabilityStatus,
    lastChecked: nstr(r.last_checked),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
  };
}

export interface CreateProjectInput {
  name: string;
  websiteName: string;
  repoUrl: string;
  branch: string;
  projectRoot?: string;
  framework?: Project['framework'];
  deploymentMode?: Project['deploymentMode'];
  packageManager?: Project['packageManager'];
  installCommand?: string | null;
  buildCommand?: string | null;
  startCommand?: string | null;
  outputDir?: string | null;
  preferredPort?: number | null;
  healthCheckPath?: string | null;
  hostnameMode?: HostnameMode;
  publicHostname?: string | null;
  configConfirmed?: boolean;
  webhookSecret?: string | null;
  githubTokenRef?: string | null;
}

/**
 * PortPilot database facade. Uses node:sqlite (built into Node.js 22+), so no
 * native compilation is required on Windows.
 */
export class PortPilotDb {
  readonly db: DatabaseSync;
  readonly secrets: SecretBox;

  constructor(dbFile: string, secretKeyFile: string) {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    this.db = new DatabaseSyncCtor(dbFile);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA_SQL);
    const row = this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as Row | undefined;
    const current = num(row?.v) ?? 0;
    if (current < SCHEMA_VERSION) {
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(SCHEMA_VERSION, nowIso());
    }
    this.secrets = new SecretBox(secretKeyFile);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  // ---------- projects ----------
  createProject(input: CreateProjectInput): Project {
    const id = generateId('prj');
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO projects (id, name, website_name, repo_url, branch, project_root, framework, deployment_mode,
          package_manager, install_command, build_command, start_command, output_dir, preferred_port, health_check_path,
          hostname_mode, public_hostname, config_confirmed, webhook_secret, github_token_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.websiteName,
        input.repoUrl,
        input.branch,
        input.projectRoot ?? '.',
        input.framework ?? 'unknown',
        input.deploymentMode ?? 'node',
        input.packageManager ?? 'npm',
        input.installCommand ?? null,
        input.buildCommand ?? null,
        input.startCommand ?? null,
        input.outputDir ?? null,
        input.preferredPort ?? null,
        input.healthCheckPath ?? '/',
        input.hostnameMode ?? 'local',
        input.publicHostname ?? null,
        input.configConfirmed ? 1 : 0,
        input.webhookSecret ?? null,
        input.githubTokenRef ?? null,
        ts,
        ts,
      );
    return this.getProject(id)!;
  }

  getProject(id: string): Project | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToProject(r) : null;
  }

  getProjectByWebsiteName(websiteName: string): Project | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE website_name = ?').get(websiteName) as Row | undefined;
    return r ? rowToProject(r) : null;
  }

  getProjectByName(name: string): Project | null {
    const r = this.db.prepare('SELECT * FROM projects WHERE name = ?').get(name) as Row | undefined;
    return r ? rowToProject(r) : null;
  }

  listProjects(): Project[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as Row[]).map(rowToProject);
  }

  updateProject(id: string, patch: Partial<CreateProjectInput> & { activeDeploymentId?: string | null; lastCommitSha?: string | null; configConfirmed?: boolean }): Project | null {
    const existing = this.getProject(id);
    if (!existing) return null;
    const map: Record<string, unknown> = {
      name: patch.name,
      website_name: patch.websiteName,
      repo_url: patch.repoUrl,
      branch: patch.branch,
      project_root: patch.projectRoot,
      framework: patch.framework,
      deployment_mode: patch.deploymentMode,
      package_manager: patch.packageManager,
      install_command: patch.installCommand,
      build_command: patch.buildCommand,
      start_command: patch.startCommand,
      output_dir: patch.outputDir,
      preferred_port: patch.preferredPort,
      health_check_path: patch.healthCheckPath,
      hostname_mode: patch.hostnameMode,
      public_hostname: patch.publicHostname,
      config_confirmed: patch.configConfirmed === undefined ? undefined : patch.configConfirmed ? 1 : 0,
      webhook_secret: patch.webhookSecret,
      github_token_ref: patch.githubTokenRef,
      last_commit_sha: patch.lastCommitSha,
      active_deployment_id: patch.activeDeploymentId,
    };
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(map)) {
      if (v !== undefined) {
        sets.push(`${k} = ?`);
        vals.push(v);
      }
    }
    if (sets.length === 0) return existing;
    sets.push('updated_at = ?');
    vals.push(nowIso());
    vals.push(id);
    this.db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as never[]));
    return this.getProject(id);
  }

  deleteProject(id: string): boolean {
    const res = this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    return Number(res.changes) > 0;
  }

  // ---------- deployments ----------
  createDeployment(projectId: string, opts: { isRollbackOf?: string | null } = {}): Deployment {
    const id = generateId('dep');
    this.db
      .prepare(
        `INSERT INTO deployments (id, project_id, status, phase, is_rollback_of, created_at) VALUES (?, ?, 'queued', 'queued', ?, ?)`,
      )
      .run(id, projectId, opts.isRollbackOf ?? null, nowIso());
    return this.getDeployment(id)!;
  }

  getDeployment(id: string): Deployment | null {
    const r = this.db.prepare('SELECT * FROM deployments WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToDeployment(r) : null;
  }

  listDeployments(opts: { projectId?: string; limit?: number; status?: string } = {}): Deployment[] {
    const limit = opts.limit ?? 50;
    let sql = 'SELECT * FROM deployments';
    const where: string[] = [];
    const vals: unknown[] = [];
    if (opts.projectId) {
      where.push('project_id = ?');
      vals.push(opts.projectId);
    }
    if (opts.status) {
      where.push('status = ?');
      vals.push(opts.status);
    }
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ' ORDER BY created_at DESC LIMIT ?';
    vals.push(limit);
    return (this.db.prepare(sql).all(...(vals as never[])) as Row[]).map(rowToDeployment);
  }

  updateDeployment(id: string, patch: Partial<Deployment>): Deployment | null {
    const map: Record<string, unknown> = {
      status: patch.status,
      phase: patch.phase,
      commit_sha: patch.commitSha,
      commit_message: patch.commitMessage,
      port: patch.port,
      pid: patch.pid,
      artifact_path: patch.artifactPath,
      workspace_path: patch.workspacePath,
      error: patch.error,
      exit_code: patch.exitCode,
      is_rollback_of: patch.isRollbackOf,
      started_at: patch.startedAt,
      finished_at: patch.finishedAt,
      duration_ms: patch.durationMs,
    };
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(map)) {
      if (v !== undefined) {
        sets.push(`${k} = ?`);
        vals.push(v);
      }
    }
    if (sets.length === 0) return this.getDeployment(id);
    vals.push(id);
    this.db.prepare(`UPDATE deployments SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as never[]));
    return this.getDeployment(id);
  }

  countDeploymentsByStatus(status: DeploymentStatus): number {
    const r = this.db.prepare('SELECT COUNT(*) AS c FROM deployments WHERE status = ?').get(status) as Row;
    return Number(r.c);
  }

  lastSuccessfulDeployment(projectId: string, excludeId?: string): Deployment | null {
    const sql = excludeId
      ? 'SELECT * FROM deployments WHERE project_id = ? AND status = ? AND id != ? ORDER BY finished_at DESC LIMIT 1'
      : 'SELECT * FROM deployments WHERE project_id = ? AND status = ? ORDER BY finished_at DESC LIMIT 1';
    const args = excludeId ? [projectId, 'succeeded', excludeId] : [projectId, 'succeeded'];
    const r = this.db.prepare(sql).get(...(args as never[])) as Row | undefined;
    return r ? rowToDeployment(r) : null;
  }

  // ---------- hostnames ----------
  createHostname(input: { projectId: string | null; hostname: string; mode?: HostnameMode; targetPort?: number | null; publicHostname?: string | null }): HostnameRecord {
    const id = generateId('hst');
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO hostnames (id, project_id, hostname, mode, target_port, public_hostname, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.projectId, input.hostname, input.mode ?? 'local', input.targetPort ?? null, input.publicHostname ?? null, ts, ts);
    return this.getHostname(id)!;
  }

  getHostname(id: string): HostnameRecord | null {
    const r = this.db.prepare('SELECT * FROM hostnames WHERE id = ?').get(id) as Row | undefined;
    return r ? rowToHostname(r) : null;
  }

  getHostnameByName(hostname: string): HostnameRecord | null {
    const r = this.db.prepare('SELECT * FROM hostnames WHERE hostname = ?').get(hostname) as Row | undefined;
    return r ? rowToHostname(r) : null;
  }

  listHostnames(projectId?: string): HostnameRecord[] {
    const rows = (
      projectId
        ? (this.db.prepare('SELECT * FROM hostnames WHERE project_id = ? ORDER BY hostname').all(projectId) as Row[])
        : (this.db.prepare('SELECT * FROM hostnames ORDER BY hostname').all() as Row[])
    );
    return rows.map(rowToHostname);
  }

  updateHostname(id: string, patch: { hostname?: string; mode?: HostnameMode; targetPort?: number | null; publicHostname?: string | null; httpsEnabled?: boolean; resolutionStatus?: HostnameResolutionStatus; reachabilityStatus?: HostnameReachabilityStatus; projectId?: string | null }): HostnameRecord | null {
    const map: Record<string, unknown> = {
      hostname: patch.hostname,
      mode: patch.mode,
      target_port: patch.targetPort,
      public_hostname: patch.publicHostname,
      https_enabled: patch.httpsEnabled === undefined ? undefined : patch.httpsEnabled ? 1 : 0,
      resolution_status: patch.resolutionStatus,
      reachability_status: patch.reachabilityStatus,
      project_id: patch.projectId,
      last_checked: patch.resolutionStatus !== undefined || patch.reachabilityStatus !== undefined ? nowIso() : undefined,
    };
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(map)) {
      if (v !== undefined) {
        sets.push(`${k} = ?`);
        vals.push(v);
      }
    }
    if (sets.length === 0) return this.getHostname(id);
    sets.push('updated_at = ?');
    vals.push(nowIso());
    vals.push(id);
    this.db.prepare(`UPDATE hostnames SET ${sets.join(', ')} WHERE id = ?`).run(...(vals as never[]));
    return this.getHostname(id);
  }

  deleteHostname(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM hostnames WHERE id = ?').run(id).changes) > 0;
  }

  // ---------- env vars (values stored encrypted, returned masked) ----------
  setEnvVar(projectId: string, key: string, value: string): EnvVar {
    const cipher = this.secrets.encrypt(value);
    const ts = nowIso();
    const existing = this.db.prepare('SELECT id FROM env_vars WHERE project_id = ? AND key = ?').get(projectId, key) as Row | undefined;
    if (existing) {
      this.db.prepare('UPDATE env_vars SET value_cipher = ?, updated_at = ? WHERE id = ?').run(cipher, ts, str(existing.id));
      return this.getEnvVar(str(existing.id))!;
    }
    const id = generateId('env');
    this.db
      .prepare('INSERT INTO env_vars (id, project_id, key, value_cipher, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, projectId, key, cipher, ts, ts);
    return this.getEnvVar(id)!;
  }

  getEnvVar(id: string): EnvVar | null {
    const r = this.db.prepare('SELECT * FROM env_vars WHERE id = ?').get(id) as Row | undefined;
    if (!r) return null;
    return {
      id: str(r.id),
      projectId: str(r.project_id),
      key: str(r.key),
      maskedValue: maskValue(this.secrets.decrypt(str(r.value_cipher))),
      createdAt: str(r.created_at),
      updatedAt: str(r.updated_at),
    };
  }

  listEnvVars(projectId: string): EnvVar[] {
    const rows = this.db.prepare('SELECT id FROM env_vars WHERE project_id = ? ORDER BY key').all(projectId) as Row[];
    return rows.map((r) => this.getEnvVar(str(r.id))!).filter(Boolean);
  }

  /** Plaintext env values for writing .env files into deployment workspaces. */
  getEnvPlain(projectId: string): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value_cipher FROM env_vars WHERE project_id = ?').all(projectId) as Row[];
    const out: Record<string, string> = {};
    for (const r of rows) out[str(r.key)] = this.secrets.decrypt(str(r.value_cipher));
    return out;
  }

  deleteEnvVar(projectId: string, id: string): boolean {
    return Number(this.db.prepare('DELETE FROM env_vars WHERE id = ? AND project_id = ?').run(id, projectId).changes) > 0;
  }

  // ---------- secrets (github token refs) ----------
  putSecret(ref: string, plaintext: string): void {
    const cipher = this.secrets.encrypt(plaintext);
    this.db
      .prepare('INSERT INTO secrets (ref, ciphertext, created_at) VALUES (?, ?, ?) ON CONFLICT(ref) DO UPDATE SET ciphertext = excluded.ciphertext')
      .run(ref, cipher, nowIso());
  }

  getSecret(ref: string): string | null {
    const r = this.db.prepare('SELECT ciphertext FROM secrets WHERE ref = ?').get(ref) as Row | undefined;
    return r ? this.secrets.decrypt(str(r.ciphertext)) : null;
  }

  deleteSecret(ref: string): void {
    this.db.prepare('DELETE FROM secrets WHERE ref = ?').run(ref);
  }

  // ---------- runtime state ----------
  setRuntime(info: { projectId: string; deploymentId?: string | null; status: RuntimeStatus; pid?: number | null; port?: number | null; cwd?: string | null; startedAt?: string | null; lastError?: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO runtime_state (project_id, deployment_id, status, pid, port, cwd, started_at, last_error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET deployment_id = excluded.deployment_id, status = excluded.status,
           pid = excluded.pid, port = excluded.port, cwd = excluded.cwd, started_at = excluded.started_at,
           last_error = excluded.last_error, updated_at = excluded.updated_at`,
      )
      .run(
        info.projectId,
        info.deploymentId ?? null,
        info.status,
        info.pid ?? null,
        info.port ?? null,
        info.cwd ?? null,
        info.startedAt ?? null,
        info.lastError ?? null,
        nowIso(),
      );
  }

  getRuntime(projectId: string): RuntimeInfo | null {
    const r = this.db.prepare('SELECT * FROM runtime_state WHERE project_id = ?').get(projectId) as Row | undefined;
    if (!r) return null;
    return {
      projectId: str(r.project_id),
      deploymentId: nstr(r.deployment_id),
      status: str(r.status) as RuntimeStatus,
      pid: num(r.pid),
      port: num(r.port),
      cwd: nstr(r.cwd),
      startedAt: nstr(r.started_at),
      lastError: nstr(r.last_error),
    };
  }

  listRuntime(): RuntimeInfo[] {
    const rows = this.db.prepare('SELECT * FROM runtime_state').all() as Row[];
    return rows
      .map((r) => this.getRuntime(str(r.project_id)))
      .filter((x): x is RuntimeInfo => x !== null);
  }

  // ---------- settings ----------
  getSetting(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
    return r ? str(r.value) : null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, value, nowIso());
  }

  listSettings(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Row[];
    const out: Record<string, string> = {};
    for (const r of rows) out[str(r.key)] = str(r.value);
    return out;
  }

  // ---------- activity ----------
  logActivity(type: string, message: string, projectId?: string | null, deploymentId?: string | null): ActivityEvent {
    const id = generateId('act');
    const ts = nowIso();
    this.db
      .prepare('INSERT INTO activity (id, type, message, project_id, deployment_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, type, message, projectId ?? null, deploymentId ?? null, ts);
    return { id, type, message, projectId: projectId ?? null, deploymentId: deploymentId ?? null, createdAt: ts };
  }

  listActivity(limit = 20): ActivityEvent[] {
    const rows = this.db.prepare('SELECT * FROM activity ORDER BY created_at DESC LIMIT ?').all(limit) as Row[];
    return rows.map((r) => ({
      id: str(r.id),
      type: str(r.type),
      message: str(r.message),
      projectId: nstr(r.project_id),
      deploymentId: nstr(r.deployment_id),
      createdAt: str(r.created_at),
    }));
  }
}
