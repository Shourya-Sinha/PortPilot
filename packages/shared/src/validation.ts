/** Input validation for PortPilot. Everything that crosses the API boundary is validated here. */
import fs from 'node:fs';
import path from 'node:path';

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

const WEBSITE_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const PROJECT_NAME_RE = /^[A-Za-z0-9]([A-Za-z0-9 _-]{0,62}[A-Za-z0-9])?$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HOSTNAME_RE = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/;

const RESERVED_WEBSITE_NAMES = ['www', 'localhost', 'portpilot', 'dns', 'proxy', 'system'];

/**
 * Website names become hostnames (e.g. my-portfolio.localhost).
 * Lowercase letters, digits and hyphens; must start/end alphanumeric.
 */
export function validateWebsiteName(name: string): ValidationResult {
  if (typeof name !== 'string' || name.length === 0) return { ok: false, error: 'Website name is required.' };
  if (name.length > 63) return { ok: false, error: 'Website name must be 63 characters or fewer.' };
  if (!WEBSITE_NAME_RE.test(name)) {
    return {
      ok: false,
      error:
        'Website name may only contain lowercase letters, digits and hyphens, and must start and end with a letter or digit.',
    };
  }
  if (RESERVED_WEBSITE_NAMES.includes(name)) return { ok: false, error: `"${name}" is a reserved website name.` };
  return { ok: true };
}

export function validateProjectName(name: string): ValidationResult {
  if (typeof name !== 'string' || name.length === 0) return { ok: false, error: 'Project name is required.' };
  if (name.length > 64) return { ok: false, error: 'Project name must be 64 characters or fewer.' };
  if (!PROJECT_NAME_RE.test(name)) {
    return { ok: false, error: 'Project name may only contain letters, digits, spaces, hyphens and underscores.' };
  }
  return { ok: true };
}

/**
 * Repository URLs are treated as untrusted input. Only http(s) and ssh forms
 * are accepted, plus local directory paths that exist on disk (local-folder
 * import). file://, javascript:, data:, and UNC paths are rejected.
 */
export function validateRepoUrl(url: string): ValidationResult {
  if (typeof url !== 'string' || url.trim().length === 0) return { ok: false, error: 'Repository URL is required.' };
  const trimmed = url.trim();
  if (trimmed.length > 2048) return { ok: false, error: 'Repository URL is too long.' };
  if (/[\s'"`\\<>]/.test(trimmed)) return { ok: false, error: 'Repository URL contains illegal characters.' };

  // Local folder import: an existing directory path (deploy without GitHub).
  // Checked dynamically to avoid accepting arbitrary paths up front.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) && !trimmed.startsWith('git@')) {
    try {
      const resolved = path.resolve(trimmed);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return { ok: true };
    } catch {
      /* fall through */
    }
    return { ok: false, error: 'Repository URL must be https://, ssh://, git@host: or an existing local folder.' };
  }

  // scp-like syntax: git@github.com:owner/repo.git
  if (/^git@[a-zA-Z0-9.-]+:[a-zA-Z0-9._~/-]+(\.git)?$/.test(trimmed)) return { ok: true };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: 'Repository URL is not a valid URL.' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:' && parsed.protocol !== 'ssh:') {
    return { ok: false, error: `URL scheme "${parsed.protocol}" is not allowed. Use https://, http:// or git@host:.` };
  }
  if (!parsed.hostname || parsed.hostname.length === 0) return { ok: false, error: 'Repository URL has no host.' };
  if (parsed.username && parsed.password) {
    return { ok: false, error: 'Do not embed credentials in the repository URL. Use the GitHub token setting instead.' };
  }
  return { ok: true };
}

/**
 * Commands are executed through a shell after validation. We reject shell
 * metacharacters that enable command chaining, redirection, substitution or
 * expansion. This is a hardening layer, NOT a sandbox: build scripts are
 * arbitrary code and run with the same privileges as PortPilot.
 */
const DANGEROUS_COMMAND_PATTERNS: { re: RegExp; why: string }[] = [
  [/[;&|`]/, 'command chaining, pipes and backticks are not allowed'],
  [/\$\(/, 'command substitution is not allowed'],
  [/[<>]/, 'input/output redirection is not allowed'],
  [/\r|\n/, 'line breaks are not allowed'],
  [/^\s*$/, 'command must not be empty'],
  [/(\bor\b|\bwhile\b|\buntil\b)/i, 'shell control keywords are not allowed'],
  [/\bsudo\b/i, 'elevated execution (sudo) is not allowed'],
  [/\brm\s+(-[a-zA-Z]*\s+)*\/(\s|$)/, 'refusing to delete filesystem root paths'],
].map(([re, why]) => ({ re: re as RegExp, why: why as string }));

export function validateCommand(command: string, opts: { allowEmpty?: boolean } = {}): ValidationResult {
  if (command == null || command.trim().length === 0) {
    return opts.allowEmpty ? { ok: true } : { ok: false, error: 'Command must not be empty.' };
  }
  if (command.length > 512) return { ok: false, error: 'Command is too long (max 512 characters).' };
  for (const { re, why } of DANGEROUS_COMMAND_PATTERNS) {
    if (re.test(command)) return { ok: false, error: `Unsafe command: ${why}.` };
  }
  return { ok: true };
}

export function validateEnvKey(key: string): ValidationResult {
  if (typeof key !== 'string' || !ENV_KEY_RE.test(key)) {
    return { ok: false, error: 'Environment key must match [A-Za-z_][A-Za-z0-9_]* and be at most 128 characters.' };
  }
  return { ok: true };
}

export function validateHostname(hostname: string): ValidationResult {
  if (typeof hostname !== 'string' || hostname.length === 0 || hostname.length > 253) {
    return { ok: false, error: 'Hostname must be 1-253 characters.' };
  }
  if (!HOSTNAME_RE.test(hostname)) return { ok: false, error: 'Hostname contains invalid characters.' };
  return { ok: true };
}

export function validateBranch(branch: string): ValidationResult {
  if (typeof branch !== 'string' || branch.length === 0) return { ok: false, error: 'Branch is required.' };
  if (branch.length > 255) return { ok: false, error: 'Branch name is too long.' };
  // git check-ref-format --branch subset
  if (/[\s~^:?*[\\]/.test(branch) || branch.includes('..') || branch.startsWith('-') || branch.endsWith('/') || branch.endsWith('.lock')) {
    return { ok: false, error: 'Branch name is not a valid git ref.' };
  }
  return { ok: true };
}

/** Reject path traversal and absolute escapes for user-provided relative paths. */
export function validateRelativePath(p: string): ValidationResult {
  if (typeof p !== 'string') return { ok: false, error: 'Path is required.' };
  if (p.includes('\0')) return { ok: false, error: 'Path contains NUL.' };
  if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')) {
    return { ok: false, error: 'Path must be relative to the repository root.' };
  }
  const normalized = p.replace(/\\/g, '/');
  if (normalized.split('/').some((seg) => seg === '..')) {
    return { ok: false, error: 'Path may not contain ".." segments.' };
  }
  return { ok: true };
}

export function validatePort(port: number): ValidationResult {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'Port must be 1-65535.' };
  return { ok: true };
}
