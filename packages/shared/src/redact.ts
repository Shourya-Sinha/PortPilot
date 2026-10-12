/**
 * Secret redaction. Anything that looks like a token/password/secret is
 * scrubbed before it reaches log files, SSE streams or API responses.
 */

const SECRET_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PATs
  /gho_[A-Za-z0-9]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /AKIA[0-9A-Z]{16}/g, // AWS
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(authorization|password|passwd|secret|token|api[_-]?key)\s*[=:]\s*("?)[^\s"'&]{6,}\2/gi,
  /https?:\/\/[^/\s:@]+:([^/\s:@]+)@/g, // credentials embedded in URLs
];

export const REDACTED = '***REDACTED***';

export function redactSecrets(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return input;
  let out = input;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (match, ...groups) => {
      // URL credentials: keep the username portion visible
      if (match.startsWith('http') && groups.length >= 1 && typeof groups[0] === 'string' && match.includes('@')) {
        return match.replace(`:${groups[0]}@`, `:${REDACTED}@`);
      }
      if (typeof groups[0] === 'string' && /^(authorization|password|passwd|secret|token|api[_-]?key)$/i.test(groups[0])) {
        return match.replace(groups.slice(1).find((g) => typeof g === 'string' && g.length > 0) ?? '', REDACTED);
      }
      return REDACTED;
    });
  }
  return out;
}

/** Mask an env var value for display: shows at most 2 leading + 2 trailing chars. */
export function maskValue(value: string): string {
  if (typeof value !== 'string') return '';
  if (value.length === 0) return '';
  if (value.length <= 4) return '*'.repeat(value.length);
  return `${value.slice(0, 2)}${'*'.repeat(Math.min(8, value.length - 4))}${value.slice(-2)}`;
}
