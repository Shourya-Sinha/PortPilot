import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { listRemoteBranches, cloneOrPull } from '../packages/github/dist/index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Live proof that a token really reaches git.
 *
 * GitHub answers "Repository not found" identically for a missing repo and for
 * bad credentials, so an integration test against GitHub cannot distinguish
 * "we sent the token" from "we sent nothing". This test uses a local HTTP
 * remote that demands Basic auth and records what git actually sends, which is
 * the only way to observe the credential transport directly.
 */

let server: http.Server;
let port = 0;
let seen: { url: string; authorization: string | null }[] = [];
let tmp: string;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portpilot-token-'));
  server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', authorization: (req.headers.authorization as string | undefined) ?? null });
    // Always challenge: git retries with credentials supplied by GIT_ASKPASS.
    res.writeHead(401, { 'www-authenticate': 'Basic realm="portpilot-test"', 'content-type': 'text/plain' }).end('auth required');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;

  // Keep the host's global git config (credential helpers, proxies) out of the
  // picture so the test observes only PortPilot's own behaviour.
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
});

afterAll(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function basicHeaderFor(token: string): string {
  // GIT_ASKPASS echoes the token for both username and password prompts.
  const variants = [`x-access-token:${token}`, `git:${token}`, `${token}:${token}`, `${token}:`];
  return variants.map((v) => `Basic ${Buffer.from(v).toString('base64')}`).join('|');
}

describe('Git credential transport', () => {
  it('sends the configured token to the remote', async () => {
    seen = [];
    const token = 'github_pat_LIVE_TRANSPORT_PROOF';
    await listRemoteBranches(`http://127.0.0.1:${port}/repo.git`, token);

    const withAuth = seen.filter((s) => s.authorization !== null);
    expect(withAuth.length).toBeGreaterThan(0);
    const header = withAuth[0].authorization!;
    const decoded = Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
    expect(decoded).toContain(token);
  });

  it('sends no credential at all when no token is configured', async () => {
    seen = [];
    await listRemoteBranches(`http://127.0.0.1:${port}/repo.git`, null);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.authorization === null)).toBe(true);
  });

  it('never puts the token in git output or in the process error text', async () => {
    seen = [];
    const token = 'github_pat_SHOULD_NEVER_LEAK';
    const res = await cloneOrPull(`http://127.0.0.1:${port}/repo.git`, 'main', path.join(tmp, 'clone'), token);
    expect(res.ok).toBe(false);
    expect(res.stdout).not.toContain(token);
    expect(res.stderr).not.toContain(token);
  });
});

// ---------------------------------------------------------------------------
// Cross-platform delivery + self-test (this is what makes Windows verifiable)
// ---------------------------------------------------------------------------
import { askpassScript, credentialHelperScript, createCredentialFiles, cleanupCredentialFiles, verifyGitCredentialTransport, runGitRaw } from '../packages/github/dist/index.js';

describe('Credential delivery is cross-platform and self-verifying', () => {
  it('generates a valid askpass script for every platform', () => {
    expect(askpassScript('win32')).toContain('@echo off');
    expect(askpassScript('win32')).toContain('%PORTPILOT_GIT_TOKEN%');
    expect(askpassScript('win32')).toContain('\r\n');
    expect(askpassScript('linux')).toContain('#!/bin/sh');
    expect(askpassScript('linux')).toContain('$PORTPILOT_GIT_TOKEN');
    expect(askpassScript('darwin')).toContain('#!/bin/sh');
  });

  it('generates a credential helper that only reads the token from the environment', () => {
    const script = credentialHelperScript();
    expect(script).toContain('process.env.PORTPILOT_GIT_TOKEN');
    expect(script).toContain('username=x-access-token');
    expect(script).toContain('password=');
  });

  it('helper strips any ambient git config helpers and passes no token in argv', () => {
    const creds = createCredentialFiles('secret-token-value', 'helper');
    try {
      expect(creds.config[1]).toBe('credential.helper=');
      expect(creds.config.join(' ')).not.toContain('secret-token-value');
      expect(creds.env.PORTPILOT_GIT_TOKEN).toBe('secret-token-value');
    } finally {
      cleanupCredentialFiles(creds);
    }
  });

  it('proves the token reaches the remote with the helper strategy', async () => {
    const res = await verifyGitCredentialTransport('portpilot-helper-proof', 'helper');
    expect(res.ok).toBe(true);
    expect(res.strategy).toBe('helper');
    expect(res.tokenSeen).toBe(true);
  });

  it('proves the token reaches the remote with the askpass strategy', async () => {
    const res = await verifyGitCredentialTransport('portpilot-askpass-proof', 'askpass');
    expect(res.ok).toBe(true);
    expect(res.strategy).toBe('askpass');
  });

  it('sends nothing when no credential mechanism is configured (negative control)', async () => {
    const seen: (string | null)[] = [];
    const probe = http.createServer((req, res) => {
      seen.push((req.headers.authorization as string | undefined) ?? null);
      res.writeHead(401, { 'www-authenticate': 'Basic realm="t"' }).end();
    });
    const port = await new Promise<number>((resolve) => probe.listen(0, '127.0.0.1', () => {
      const a = probe.address();
      resolve(typeof a === 'object' && a ? a.port : 0);
    }));
    try {
      await runGitRaw(['ls-remote', `http://127.0.0.1:${port}/none.git`], { ...process.env, GIT_TERMINAL_PROMPT: '0' }, { timeoutMs: 5000 });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((h) => h === null)).toBe(true);
    } finally {
      await new Promise<void>((r) => probe.close(() => r()));
    }
  });
});
