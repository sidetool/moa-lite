import { sha256 } from '@noble/hashes/sha2.js';
import { Buffer } from 'buffer';
export const randomUUID = () => crypto.randomUUID();
export function createHash(algorithm: string) {
  if (algorithm !== 'sha256') throw new Error('unsupported_hash');
  const hash = sha256.create();
  return { update(value: string | Uint8Array) { hash.update(typeof value === 'string' ? new TextEncoder().encode(value) : value); return this; },
    digest(encoding?: string) { const bytes = Buffer.from(hash.digest()); return encoding === 'hex' ? bytes.toString('hex') : bytes; } };
}
