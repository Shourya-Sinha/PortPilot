import crypto from 'node:crypto';

/**
 * GitHub webhook signature validation (HMAC SHA-256, X-Hub-Signature-256).
 * Rejects unsigned or mismatched payloads. Uses timing-safe comparison.
 */
export function verifyGithubSignature(rawBody: Buffer | string, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !secret) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function generateWebhookSecret(): string {
  return crypto.randomBytes(24).toString('hex');
}

export interface GithubPushEvent {
  ref: string;
  before: string;
  after: string;
  repository?: { full_name?: string; clone_url?: string; html_url?: string };
  head_commit?: { id?: string; message?: string };
  pusher?: { name?: string };
}

export function parsePushEvent(payload: unknown): { branch: string | null; commitSha: string | null; commitMessage: string | null } {
  const p = payload as GithubPushEvent | null;
  if (!p || typeof p !== 'object') return { branch: null, commitSha: null, commitMessage: null };
  const ref = typeof p.ref === 'string' ? p.ref : '';
  const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
  return {
    branch,
    commitSha: typeof p.after === 'string' ? p.after : null,
    commitMessage: typeof p.head_commit?.message === 'string' ? p.head_commit.message : null,
  };
}
