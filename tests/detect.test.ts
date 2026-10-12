import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectProject } from '@portpilot/build-engine';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('framework detection', () => {
  it('detects a static site (index.html, no package.json)', () => {
    const cfg = detectProject(path.join(root, 'samples/static-site'));
    expect(cfg.framework).toBe('static');
    expect(cfg.deploymentMode).toBe('static');
    expect(cfg.installCommand).toBeNull();
    expect(cfg.startCommand).toBeNull();
    expect(cfg.confidence).toBe('high');
  });

  it('detects a plain Node.js app', () => {
    const cfg = detectProject(path.join(root, 'samples/node-app'));
    expect(cfg.framework).toBe('node');
    expect(cfg.deploymentMode).toBe('node');
    expect(cfg.startCommand).toContain('start');
    expect(cfg.installCommand).toBeTruthy();
  });

  it('detects Vite + React from package.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-detect-'));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'web',
        scripts: { build: 'vite build', dev: 'vite' },
        dependencies: { react: '^18.0.0', 'react-dom': '^18.0.0' },
        devDependencies: { vite: '^5.0.0' },
      }),
    );
    fs.writeFileSync(path.join(dir, 'vite.config.js'), 'export default {}');
    const cfg = detectProject(dir);
    expect(cfg.framework).toBe('react');
    expect(cfg.deploymentMode).toBe('static');
    expect(cfg.outputDir).toBe('dist');
    expect(cfg.buildCommand).toBeTruthy();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('detects Next.js server mode', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-detect-'));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'nextapp',
        scripts: { build: 'next build', start: 'next start' },
        dependencies: { next: '^14.0.0', react: '^18.0.0' },
      }),
    );
    fs.writeFileSync(path.join(dir, 'next.config.js'), 'module.exports = {}');
    const cfg = detectProject(dir);
    expect(cfg.framework).toBe('next');
    expect(cfg.deploymentMode).toBe('node');
    expect(cfg.startCommand).toContain('start');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('detects Express and Fastify', () => {
    for (const [dep, expected] of [['express', 'express'], ['fastify', 'fastify']] as const) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-detect-'));
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'srv', scripts: { start: 'node index.js' }, dependencies: { [dep]: '^4.0.0' } }),
      );
      const cfg = detectProject(dir);
      expect(cfg.framework).toBe(expected);
      expect(cfg.deploymentMode).toBe('node');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects Java Maven', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-detect-'));
    fs.writeFileSync(path.join(dir, 'pom.xml'), '<project></project>');
    const cfg = detectProject(dir);
    expect(cfg.framework).toBe('java-maven');
    expect(cfg.buildCommand).toContain('mvn');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports low confidence for unknown projects', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-detect-'));
    const cfg = detectProject(dir);
    expect(cfg.confidence).toBe('low');
    expect(cfg.notes.length).toBeGreaterThan(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
