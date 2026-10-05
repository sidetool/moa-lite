import type { Database, SqlJsStatic } from 'sql.js';

/** The upstream Store/accounts SQL contract, backed by SQLite WASM in either host. */
export class SqliteDatabase {
  readonly raw: Database;
  onWrite?: () => void;
  constructor(sql: SqlJsStatic, bytes?: Uint8Array) { this.raw = new sql.Database(bytes); }
  exec(sql: string) { this.raw.run(sql); }
  prepare(sql: string) {
    const query = (params: any[], one: boolean) => {
      const statement = this.raw.prepare(sql);
      try {
        statement.bind(params.map(value => value === undefined ? null : value));
        const rows: any[] = [];
        while (statement.step()) { rows.push(statement.getAsObject()); if (one) break; }
        return one ? rows[0] : rows;
      } finally { statement.free(); }
    };
    return {
      all: (...params: any[]) => query(params, false),
      get: (...params: any[]) => query(params, true),
      run: (...params: any[]) => {
        const statement = this.raw.prepare(sql);
        try { statement.bind(params.map(value => value === undefined ? null : value)); statement.step(); }
        finally { statement.free(); }
        const changes = this.raw.getRowsModified();
        if (changes) this.onWrite?.();
        const lastInsertRowid = this.raw.exec('SELECT last_insert_rowid()')[0]?.values[0]?.[0] ?? 0;
        return { changes, lastInsertRowid };
      },
    };
  }
  export() { return this.raw.export(); }
  close() { this.raw.close(); }
}
