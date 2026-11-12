/**
 * In-memory SQLite for the validation harness, over Node's built-in `node:sqlite`.
 *
 * This is the same driver as `@pace/database`'s test fixture (`test-fixtures/node-sqlite-driver`),
 * which is excluded from that package's build so `node:sqlite` never reaches the mobile bundle.
 * The harness is Node-only tooling, so it carries its own copy; a regression test checks that both
 * run the real migrations identically.
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { SqlDriver, SqlValue } from '@pace/database';

export class MemorySqliteDriver implements SqlDriver {
  private readonly db = new DatabaseSync(':memory:');
  private lock: Promise<void> = Promise.resolve();
  private inTransaction = false;

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
