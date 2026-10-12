export * from './types.js';
export * from './validation.js';
export * from './redact.js';
export * from './logger.js';
export * from './paths.js';
export * from './errors.js';

/** Small utility: ISO timestamp used across the platform. */
export function nowIso(): string {
  return new Date().toISOString();
}

export function generateId(prefix: string): string {
  const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return `${prefix}_${rand}`;
}
