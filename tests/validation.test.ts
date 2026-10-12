import { describe, expect, it } from 'vitest';
import {
  validateWebsiteName,
  validateProjectName,
  validateRepoUrl,
  validateCommand,
  validateEnvKey,
  validateHostname,
  validateBranch,
  validateRelativePath,
  redactSecrets,
  maskValue,
} from '@portpilot/shared';

describe('website name validation', () => {
  it('accepts valid names', () => {
    for (const n of ['my-portfolio', 'api', 'a', 'app-1', 'x'.repeat(63)]) {
      expect(validateWebsiteName(n).ok, n).toBe(true);
    }
  });
  it('rejects invalid names', () => {
    for (const n of ['', 'My-App', '-lead', 'trail-', 'has space', 'dot.name', 'under_score', 'x'.repeat(64), 'www', 'localhost']) {
      expect(validateWebsiteName(n).ok, n).toBe(false);
    }
  });
});

describe('project name validation', () => {
  it('accepts names with spaces and dashes', () => {
    expect(validateProjectName('My Portfolio').ok).toBe(true);
    expect(validateProjectName('api-server_2').ok).toBe(true);
  });
  it('rejects empty and hostile names', () => {
    expect(validateProjectName('').ok).toBe(false);
    expect(validateProjectName('a; rm -rf /').ok).toBe(false);
    expect(validateProjectName('../etc').ok).toBe(false);
  });
});

describe('repository URL validation', () => {
  it('accepts https and ssh github URLs', () => {
    expect(validateRepoUrl('https://github.com/user/repo.git').ok).toBe(true);
    expect(validateRepoUrl('https://github.com/user/repo').ok).toBe(true);
    expect(validateRepoUrl('git@github.com:user/repo.git').ok).toBe(true);
    expect(validateRepoUrl('ssh://git@github.com/user/repo.git').ok).toBe(true);
  });
  it('rejects dangerous schemes and credential embedding', () => {
    expect(validateRepoUrl('file:///etc/passwd').ok).toBe(false);
    expect(validateRepoUrl('javascript:alert(1)').ok).toBe(false);
    expect(validateRepoUrl('data:text/html,x').ok).toBe(false);
    expect(validateRepoUrl('https://user:pass@github.com/x/y.git').ok).toBe(false);
    expect(validateRepoUrl('https://github.com/x/y.git; rm -rf /').ok).toBe(false);
  });
});

describe('command validation', () => {
  it('accepts normal build commands', () => {
    for (const c of ['npm ci', 'npm run build', 'node server.js', 'pnpm install --frozen-lockfile', 'mvn -B package -DskipTests']) {
      expect(validateCommand(c).ok, c).toBe(true);
    }
  });
  it('rejects shell injection attempts', () => {
    for (const c of ['npm ci; rm -rf /', 'npm run build && curl evil', 'echo `whoami`', 'echo $(id)', 'cat x | sh', 'echo hi > /etc/passwd', 'sudo npm i', 'npm\nstart']) {
      expect(validateCommand(c).ok, c).toBe(false);
    }
  });
});

describe('env key / hostname / branch / path validation', () => {
  it('env keys', () => {
    expect(validateEnvKey('API_KEY').ok).toBe(true);
    expect(validateEnvKey('1BAD').ok).toBe(false);
    expect(validateEnvKey('BAD-KEY').ok).toBe(false);
  });
  it('hostnames', () => {
    expect(validateHostname('app.localhost').ok).toBe(true);
    expect(validateHostname('a.b.c.home.arpa').ok).toBe(true);
    expect(validateHostname('-bad.com').ok).toBe(false);
  });
  it('branches', () => {
    expect(validateBranch('main').ok).toBe(true);
    expect(validateBranch('feature/login').ok).toBe(true);
    expect(validateBranch('bad branch').ok).toBe(false);
    expect(validateBranch('x..y').ok).toBe(false);
    expect(validateBranch('-oops').ok).toBe(false);
  });
  it('relative paths', () => {
    expect(validateRelativePath('packages/web').ok).toBe(true);
    expect(validateRelativePath('../../etc').ok).toBe(false);
    expect(validateRelativePath('/etc/passwd').ok).toBe(false);
    expect(validateRelativePath('C:\\Windows').ok).toBe(false);
  });
});

describe('redaction', () => {
  it('redacts github tokens', () => {
    const out = redactSecrets('token is ghp_abcdefghijklmnopqrstuvwxyz123456 ok');
    expect(out).not.toContain('ghp_abcdefgh');
    expect(out).toContain('***REDACTED***');
  });
  it('redacts URL credentials', () => {
    const out = redactSecrets('clone https://user:supersecret@github.com/x/y.git');
    expect(out).not.toContain('supersecret');
    expect(out).toContain('user');
  });
  it('redacts key=value secrets', () => {
    const out = redactSecrets('TOKEN=abcdef123456');
    expect(out).not.toContain('abcdef123456');
  });
  it('masks env values', () => {
    expect(maskValue('supersecret')).toBe('su*******et');
    expect(maskValue('abc')).toBe('***');
    expect(maskValue('')).toBe('');
  });
});
