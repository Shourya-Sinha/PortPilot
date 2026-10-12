import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * AES-256-GCM encryption for stored secrets (GitHub tokens, env var values).
 * The key lives in data/secret.key (created 0600 on POSIX) and never in Git.
 */

export class SecretBox {
  private readonly key: Buffer;

  constructor(keyFile: string) {
    this.key = SecretBox.loadOrCreateKey(keyFile);
  }

  private static loadOrCreateKey(keyFile: string): Buffer {
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    if (fs.existsSync(keyFile)) {
      const raw = fs.readFileSync(keyFile, 'utf8').trim();
      const key = Buffer.from(raw, 'hex');
      if (key.length !== 32) throw new Error(`Secret key at ${keyFile} is invalid (expected 32 bytes hex).`);
      return key;
    }
    const key = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
    try {
      fs.chmodSync(keyFile, 0o600);
    } catch {
      // Windows: chmod is a no-op; the file inherits the user profile ACLs.
    }
    return key;
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
  }

  decrypt(payload: string): string {
    const parts = payload.split('.');
    if (parts.length !== 3) throw new Error('Malformed ciphertext.');
    const iv = Buffer.from(parts[0], 'base64');
    const tag = Buffer.from(parts[1], 'base64');
    const data = Buffer.from(parts[2], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }
}
