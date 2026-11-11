import type { SqlDriver, SqlValue } from '@pace/database';
import type { SQLiteDatabase } from 'expo-sqlite';

type Executor = Pick<SQLiteDatabase, 'execAsync' | 'runAsync' | 'getAllAsync' | 'getFirstAsync'>;
type Root = Executor & Pick<SQLiteDatabase, 'withTransactionAsync'>;

/**
 * expo-sqlite implementation of the shared SqlDriver contract.
 *
 * Why not `withExclusiveTransactionAsync`: expo-sqlite runs it on a *new* connection. Per-
 * connection pragmas set by `configureConnection` (foreign_keys, synchronous=FULL) would not
 * apply inside transactions, and concurrent writes on the main connection fail with
 * "database is locked". Instead every statement — inside or outside a transaction — runs on the
 * one configured connection, serialised by an in-process lock, so a transaction can never be
 * interleaved with other statements and always runs with the configured pragmas.
 */
class SerializedDriver implements SqlDriver {
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: Root) {}

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  exec(sql: string): Promise<void> {
    return this.exclusive(() => this.db.execAsync(sql));
  }
  run(sql: string, params: readonly SqlValue[] = []): Promise<{ changes: number }> {
    return this.exclusive(async () => ({
      changes: (await this.db.runAsync(sql, params as SqlValue[])).changes,
    }));
  }
  all<T>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    return this.exclusive(() => this.db.getAllAsync<T>(sql, params as SqlValue[]));
  }
  get<T>(sql: string, params: readonly SqlValue[] = []): Promise<T | null> {
    return this.exclusive(
      async () => (await this.db.getFirstAsync<T>(sql, params as SqlValue[])) ?? null,
    );
  }
  transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      let result: T | undefined;
      await this.db.withTransactionAsync(async () => {
        result = await fn(new TransactionDriver(this.db));
      });
      return result as T;
    });
  }
}

/** Statements inside a transaction: same connection, already holding the lock. */
class TransactionDriver implements SqlDriver {
  constructor(private readonly db: Executor) {}
  async exec(sql: string): Promise<void> {
    await this.db.execAsync(sql);
  }
  async run(sql: string, params: readonly SqlValue[] = []): Promise<{ changes: number }> {
    return { changes: (await this.db.runAsync(sql, params as SqlValue[])).changes };
  }
  all<T>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    return this.db.getAllAsync<T>(sql, params as SqlValue[]);
  }
  async get<T>(sql: string, params: readonly SqlValue[] = []): Promise<T | null> {
    return (await this.db.getFirstAsync<T>(sql, params as SqlValue[])) ?? null;
  }
  transaction<T>(): Promise<T> {
    return Promise.reject(new Error('Nested transactions are not supported'));
  }
}

export function createExpoSqliteDriver(db: SQLiteDatabase): SqlDriver {
  return new SerializedDriver(db);
}
