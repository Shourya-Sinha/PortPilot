import fs from 'node:fs';
import path from 'node:path';
import type { DetectedConfig, Framework, PackageManager } from '@portpilot/shared';

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageJson(dir: string): PackageJson | null {
  const p = path.join(dir, 'package.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

function hasFile(dir: string, name: string): boolean {
  return fs.existsSync(path.join(dir, name));
}

function findPrefix(dir: string, prefix: string): string | null {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith(prefix)) return entry;
  }
  return null;
}

function detectPackageManager(dir: string): PackageManager {
  if (hasFile(dir, 'pnpm-lock.yaml')) return 'pnpm';
  if (hasFile(dir, 'yarn.lock')) return 'yarn';
  if (hasFile(dir, 'package-lock.json') || hasFile(dir, 'package.json')) return 'npm';
  return 'none';
}

function defaultInstall(pm: PackageManager): string | null {
  switch (pm) {
    case 'npm':
      return 'npm ci';
    case 'pnpm':
      return 'pnpm install --frozen-lockfile';
    case 'yarn':
      return 'yarn install --frozen-lockfile';
    default:
      return null;
  }
}

function installFallback(pm: PackageManager): string | null {
  switch (pm) {
    case 'npm':
      return 'npm install';
    case 'pnpm':
      return 'pnpm install';
    case 'yarn':
      return 'yarn install';
    default:
      return null;
  }
}

/**
 * Detects the project framework and proposes commands from repository files.
 * The result is ALWAYS shown to the user for confirmation before first deploy;
 * nothing here is executed automatically.
 */
export function detectProject(projectRootDir: string): DetectedConfig {
  const notes: string[] = [];
  const pkg = readPackageJson(projectRootDir);
  const allDeps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const scripts = pkg?.scripts ?? {};
  const pm = detectPackageManager(projectRootDir);

  let framework: Framework = 'unknown';
  let deploymentMode: DetectedConfig['deploymentMode'] = 'node';
  let outputDir: string | null = null;
  let startCommand: string | null = null;
  let buildCommand: string | null = null;
  let confidence: DetectedConfig['confidence'] = 'medium';

  const hasPom = hasFile(projectRootDir, 'pom.xml');
  const hasGradle = hasFile(projectRootDir, 'build.gradle') || hasFile(projectRootDir, 'build.gradle.kts');

  if (hasPom || hasGradle) {
    framework = hasPom ? 'java-maven' : 'java-gradle';
    deploymentMode = hasPom ? 'java-maven' : 'java-gradle';
    buildCommand = hasPom ? 'mvn -B package -DskipTests' : 'gradle build -x test';
    startCommand = null;
    confidence = 'medium';
    notes.push('Java project detected. The required JDK and build tools must be installed on this PC. PortPilot will verify them before building.');
    const hasJar = false;
    void hasJar;
  } else if (pkg) {
    const nextConfig = findPrefix(projectRootDir, 'next.config.');
    if (allDeps['next'] || nextConfig) {
      framework = 'next';
      if (typeof scripts.build === 'string' && scripts.build.includes('next build')) buildCommand = `${pm} run build`;
      else buildCommand = pm === 'npm' ? 'npm run build' : `${pm} run build`;
      if (typeof scripts.start === 'string' && scripts.start.includes('next start')) {
        startCommand = pm === 'npm' ? 'npm start' : `${pm} run start`;
        deploymentMode = 'node';
        notes.push('Next.js server mode detected (next start). The app runs as a Node.js process.');
      } else if (typeof scripts.export === 'string' || (typeof scripts.build === 'string' && scripts.build.includes('next export'))) {
        deploymentMode = 'static';
        outputDir = 'out';
        notes.push('Next.js static export detected. Output directory: out/');
      } else {
        startCommand = pm === 'npm' ? 'npm start' : `${pm} run start`;
        deploymentMode = 'node';
      }
      confidence = 'high';
    } else if (allDeps['vite'] || findPrefix(projectRootDir, 'vite.config.')) {
      framework = allDeps['react'] ? 'react' : 'vite';
      if (framework === 'react') notes.push('React + Vite detected.');
      deploymentMode = 'static';
      buildCommand = pm === 'npm' ? 'npm run build' : `${pm} run build`;
      outputDir = 'dist';
      confidence = 'high';
    } else if (allDeps['react-scripts']) {
      framework = 'react';
      deploymentMode = 'static';
      buildCommand = pm === 'npm' ? 'npm run build' : `${pm} run build`;
      outputDir = 'build';
      confidence = 'high';
      notes.push('Create React App detected. Output directory: build/');
    } else if (allDeps['fastify']) {
      framework = 'fastify';
      deploymentMode = 'node';
      confidence = 'high';
    } else if (allDeps['express']) {
      framework = 'express';
      deploymentMode = 'node';
      confidence = 'high';
    } else {
      framework = 'node';
      deploymentMode = 'node';
      confidence = 'medium';
      notes.push('Generic Node.js project. Please confirm the start command.');
    }

    if (deploymentMode === 'node' && !startCommand) {
      if (typeof scripts.start === 'string') startCommand = pm === 'npm' ? 'npm start' : `${pm} run start`;
      else if (typeof scripts.serve === 'string') startCommand = pm === 'npm' ? 'npm run serve' : `${pm} run serve`;
      else if (hasFile(projectRootDir, 'server.js')) startCommand = 'node server.js';
      else if (hasFile(projectRootDir, 'index.js')) startCommand = 'node index.js';
      else if (hasFile(projectRootDir, 'src/index.js')) startCommand = 'node src/index.js';
      else if (hasFile(projectRootDir, 'src/index.ts')) {
        startCommand = 'npx tsx src/index.ts';
        notes.push('TypeScript entrypoint detected; proposed start command uses tsx.');
      } else {
        notes.push('No start script found. Add a start command manually.');
        confidence = 'low';
      }
    }
  } else if (hasFile(projectRootDir, 'index.html')) {
    framework = 'static';
    deploymentMode = 'static';
    outputDir = '.';
    confidence = 'high';
    notes.push('Static website detected (index.html, no package.json).');
  } else {
    framework = 'unknown';
    confidence = 'low';
    notes.push('Could not detect the project type. Choose the framework and commands manually.');
  }

  let installCommand = defaultInstall(pm);
  if (installCommand === 'npm ci' && !hasFile(projectRootDir, 'package-lock.json')) {
    installCommand = installFallback(pm);
    notes.push('No package-lock.json found; proposed "npm install" instead of "npm ci".');
  }

  // Only propose a build command when a build script exists.
  if (deploymentMode === 'node' && !buildCommand && typeof scripts.build === 'string') {
    buildCommand = pm === 'npm' ? 'npm run build' : `${pm} run build`;
  }
  if (framework === 'static' && !pkg) {
    buildCommand = null;
    installCommand = null;
    startCommand = null;
  }

  return {
    framework,
    deploymentMode,
    packageManager: pm,
    installCommand,
    buildCommand,
    startCommand,
    outputDir,
    healthCheckPath: '/',
    confidence,
    notes,
  };
}

/**
 * Frameworks that use client-side routing and therefore need a static server
 * that falls back to index.html for unknown paths. Plain static sites and
 * server-rendered frameworks do not.
 */
export function isSpaFramework(framework: string | null | undefined): boolean {
  return framework === 'react' || framework === 'vite';
}
