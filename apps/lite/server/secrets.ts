import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
export function encrypt(value: unknown, secret: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv);
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
}
export function decrypt(value: string | undefined, secret: string): any {
  if (!value) return {};
  const bytes = Buffer.from(value, 'base64'), cipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), bytes.subarray(0, 12));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8'));
}
