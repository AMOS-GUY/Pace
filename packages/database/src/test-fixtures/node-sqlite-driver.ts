/**
 * SqlDriver over Node's built-in `node:sqlite` — used by tests and tooling to exercise the
 * exact same SQL that runs on device (expo-sqlite). Not bundled into the mobile app.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { SqlDriver, SqlValue } from '../driver';

export class NodeSqliteDriver implements SqlDriver {
  private readonly db: DatabaseSync;
  private lock: Promise<void> = Promise.resolve();
  private inTransaction = false;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }
  async run(sql: string, params: readonly SqlValue[] = []): Promise<{ changes: number }> {
    const r = this.db.prepare(sql).run(...(params as SQLInputValue[]));
    return { changes: Number(r.changes) };
  }
  async all<T>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
  }
  async get<T>(sql: string, params: readonly SqlValue[] = []): Promise<T | null> {
    return (this.db.prepare(sql).get(...(params as SQLInputValue[])) as T | undefined) ?? null;
  }
  async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    if (this.inTransaction) throw new Error('Nested transactions are not supported');
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise((r) => (release = r));
    await previous;
    this.inTransaction = true;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn(this);
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.inTransaction = false;
      release();
    }
  }
  close(): void {
    this.db.close();
  }
}
