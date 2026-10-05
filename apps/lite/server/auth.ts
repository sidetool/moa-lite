import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import initSqlJs from 'sql.js';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { SqliteDatabase } from '../sqlite.js';
import type { DocumentStore } from './documents.js';
import { createAuthServer as upstreamAuth } from '../../../deploy/auth/server.mjs';
import { migrateAccounts as migrate } from '../../../deploy/auth/accounts.mjs';
const require = createRequire(import.meta.url);
let sqlPromise: ReturnType<typeof initSqlJs> | undefined;
export function sqlite() {
  return sqlPromise ??= readFile(require.resolve('sql.js/dist/sql-wasm.wasm')).then(bytes => initSqlJs({ wasmBinary: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer }));
}
export async function authDatabase(encoded?: string) {
  const db = new SqliteDatabase(await sqlite(), encoded ? Buffer.from(encoded, 'base64') : undefined);
  (migrate as any)(db, { users: [] }, Date.now);
  return db;
}
const sessionIndexes = new WeakMap<DocumentStore, { encoded: string; sessions: Map<string, any> }>();
export async function authenticate(store: DocumentStore, req: IncomingMessage) {
  const token = /(?:^|;\s*)(?:__Host-)?moa_session=([\w-]{43})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
  if (!token) return null;
  const state = await store.get('auth'); if (!state.value) return null;
  let index = sessionIndexes.get(store);
  if (index?.encoded !== state.value) {
    const db = await authDatabase(state.value);
    try {
      const rows = db.prepare(`SELECT a.id,a.username,a.role,s.token_hash,s.expires FROM accounts a JOIN sessions s ON s.account_id=a.id WHERE a.disabled=0`).all();
      index = { encoded: state.value, sessions: new Map(rows.map((row: any) => [String(row.token_hash), row])) };
      sessionIndexes.set(store, index);
    } finally { db.close(); }
  }
  const session = index!.sessions.get(createHash('sha256').update(token).digest('hex'));
  if (!session || session.expires <= Date.now()) return null;
  const { expires, ...actor } = session; return actor;
}
class BufferedResponse {
  statusCode = 200; headers: Record<string, any> = {}; body = Buffer.alloc(0); headersSent = false;
  writeHead(status: number, headers: Record<string, any>) { this.statusCode = status; this.headers = headers; this.headersSent = true; }
  end(body?: string | Buffer) { this.body = Buffer.from(body ?? ''); }
  destroy() { throw new Error('auth-response-failed'); }
}
/** Buffer the upstream response until its SQLite changes commit atomically in Redis. */
export async function handleAuth(store: DocumentStore, req: IncomingMessage, res: ServerResponse, body: Buffer, options: { secret: string; setupCode: string; origin: string; allowedOrigins: string[] }) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const saved = await store.get('auth'), db = await authDatabase(saved.value);
    try {
      db.exec('CREATE TABLE IF NOT EXISTS auth_state(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
      if (!db.prepare('SELECT 1 FROM accounts LIMIT 1').get()) db.prepare("INSERT OR REPLACE INTO auth_state VALUES('setup-code',?)").run(options.setupCode.toUpperCase());
      const capture = new BufferedResponse();
      const replay = Object.assign(Readable.from(body.length ? [body] : []), { url: req.url, method: req.method, headers: req.headers, socket: req.socket });
      const handler = (upstreamAuth as any)({ credentials: { users: [], csrfSecret: options.secret }, database: db, origin: options.origin, allowedOrigins: options.allowedOrigins, secure: options.origin.startsWith('https:'), serverless: true });
      await handler.handle(replay, capture);
      const encoded = Buffer.from(db.export()).toString('base64');
      if (encoded === saved.value || await store.compareSet('auth', saved.revision, encoded)) {
        res.writeHead(capture.statusCode, capture.headers); res.end(capture.body); return;
      }
    } finally { db.close(); }
  }
  throw new Error('storage-conflict');
}
