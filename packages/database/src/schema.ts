/** SQLite schema. Applied idempotently; schema_migrations tracks versions. */

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  website_name TEXT NOT NULL UNIQUE,
  repo_url TEXT NOT NULL,
  branch TEXT NOT NULL DEFAULT 'main',
  project_root TEXT NOT NULL DEFAULT '.',
  framework TEXT NOT NULL DEFAULT 'unknown',
  deployment_mode TEXT NOT NULL DEFAULT 'node',
  package_manager TEXT NOT NULL DEFAULT 'npm',
  install_command TEXT,
  build_command TEXT,
  start_command TEXT,
  output_dir TEXT,
  preferred_port INTEGER,
  health_check_path TEXT,
  hostname_mode TEXT NOT NULL DEFAULT 'local',
  public_hostname TEXT,
  config_confirmed INTEGER NOT NULL DEFAULT 0,
  webhook_secret TEXT,
  github_token_ref TEXT,
  last_commit_sha TEXT,
  active_deployment_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',
  phase TEXT NOT NULL DEFAULT 'queued',
  commit_sha TEXT,
  commit_message TEXT,
  port INTEGER,
  pid INTEGER,
  artifact_path TEXT,
  workspace_path TEXT,
  error TEXT,
  exit_code INTEGER,
  is_rollback_of TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_deployments_project ON deployments(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);

CREATE TABLE IF NOT EXISTS hostnames (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  hostname TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL DEFAULT 'local',
  target_port INTEGER,
  public_hostname TEXT,
  https_enabled INTEGER NOT NULL DEFAULT 0,
  resolution_status TEXT NOT NULL DEFAULT 'configured',
  reachability_status TEXT NOT NULL DEFAULT 'not_checked',
  last_checked TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hostnames_project ON hostnames(project_id);

CREATE TABLE IF NOT EXISTS env_vars (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_cipher TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, key)
);

CREATE TABLE IF NOT EXISTS secrets (
  ref TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_state (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  deployment_id TEXT,
  status TEXT NOT NULL DEFAULT 'stopped',
  pid INTEGER,
  port INTEGER,
  cwd TEXT,
  started_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  project_id TEXT,
  deployment_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity(created_at DESC);
`;
