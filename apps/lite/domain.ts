import { createHash } from 'node:crypto';
export class ApiFailure extends Error {
  constructor(public statusCode: number, public error: string, message?: string) { super(message || error); }
}
export const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
export const now = () => new Date().toISOString();
export const normalize = (s: string) => s.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{Z}\s_]+/gu, '');
