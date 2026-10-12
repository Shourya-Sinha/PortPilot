import fs from 'node:fs';
import path from 'node:path';

/** Recursively copy a directory (node_modules and .git excluded by default). */
export function copyDir(src: string, dest: string, opts: { exclude?: Set<string> } = {}): void {
  const exclude = opts.exclude ?? new Set(['node_modules', '.git', '.cache', '.turbo', '.next/cache']);
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const rel = entry.name;
    if (exclude.has(rel)) continue;
    const s = path.join(src, rel);
    const d = path.join(dest, rel);
    if (entry.isDirectory()) {
      copyDir(s, d, { exclude });
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

export function dirSize(dir: string): number {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSize(p);
    else if (entry.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

export function rmrf(target: string): void {
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
}

export interface ArtifactManifest {
  deploymentId: string;
  projectId: string;
  createdAt: string;
  mode: 'static' | 'node';
  /** For static mode: directory containing the built site. */
  staticDir: string | null;
  /** For node mode: directory to run the start command in. */
  runDir: string | null;
  commitSha: string | null;
  sizeBytes: number;
}

export function writeManifest(artifactDir: string, manifest: ArtifactManifest): void {
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'artifact.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

export function readManifest(artifactDir: string): ArtifactManifest | null {
  const p = path.join(artifactDir, 'artifact.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as ArtifactManifest;
  } catch {
    return null;
  }
}
