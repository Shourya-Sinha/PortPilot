import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Canonical filesystem layout. Resolved once from environment/defaults so all
 * packages agree on where data lives. Kept inside the repo by default and
 * git-ignored; never delete user data silently.
 */
export interface PortPilotPaths {
  root: string;
  dataDir: string;
  workspacesDir: string;
  artifactsDir: string;
  logsDir: string;
  deploymentsLogDir: string;
  runtimeLogDir: string;
  dbFile: string;
  secretKeyFile: string;
  sessionTokenFile: string;
  pidFile: string;
}

function resolveRoot(): string {
  // packages/shared/dist/paths.js -> repo root is ../../..
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'packages'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

export function getPaths(): PortPilotPaths {
  const root = process.env.PORTPILOT_ROOT ?? resolveRoot();
  const dataDir = path.resolve(root, process.env.DATA_DIR ?? './data');
  const workspacesDir = path.resolve(root, process.env.WORKSPACES_DIR ?? './workspaces');
  const artifactsDir = path.resolve(root, process.env.ARTIFACTS_DIR ?? './artifacts');
  const logsDir = path.resolve(root, process.env.LOGS_DIR ?? './logs');
  return {
    root,
    dataDir,
    workspacesDir,
    artifactsDir,
    logsDir,
    deploymentsLogDir: path.join(logsDir, 'deployments'),
    runtimeLogDir: path.join(logsDir, 'runtime'),
    dbFile: path.join(dataDir, 'portpilot.db'),
    secretKeyFile: path.join(dataDir, 'secret.key'),
    sessionTokenFile: path.join(dataDir, '.session-token'),
    pidFile: path.join(dataDir, 'portpilot.pid'),
  };
}

export function ensureDirs(paths: PortPilotPaths = getPaths()): void {
  for (const dir of [
    paths.dataDir,
    paths.workspacesDir,
    paths.artifactsDir,
    paths.logsDir,
    paths.deploymentsLogDir,
    paths.runtimeLogDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * True when `candidate` is the same as `root` or lives inside it.
 *
 * A plain `startsWith(root)` check is wrong in two ways:
 *   - it accepts siblings that merely share a prefix (`/app/dist-evil` when the
 *     root is `/app/dist`), which is a path-traversal hole;
 *   - Windows paths are case-insensitive and may use short (8.3) names, so an
 *     exact-string comparison rejects valid paths.
 */
export function isPathInside(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  if (rel === '') return true;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  // On Windows, `path.relative` is already case-insensitive, so this also
  // covers different casing of the same directory.
  return true;
}
