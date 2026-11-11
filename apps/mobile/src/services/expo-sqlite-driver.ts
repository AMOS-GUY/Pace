import type { SqlDriver, SqlValue } from '@pace/database';
import type { SQLiteDatabase } from 'expo-sqlite';

type Executor = Pick<SQLiteDatabase, 'execAsync' | 'runAsync' | 'getAllAsync' | 'getFirstAsync'>;

class ExecutorDriver implements SqlDriver {
  constructor(
    protected readonly exec_: Executor,
    private readonly root: SQLiteDatabase | null,
  ) {}
  async exec(sql: string): Promise<void> {
    await this.exec_.execAsync(sql);
  }
  async run(sql: string, params: readonly SqlValue[] = []): Promise<{ changes: number }> {
    const r = await this.exec_.runAsync(sql, params as SqlValue[]);
    return { changes: r.changes };
  }
  async all<T>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    return this.exec_.getAllAsync<T>(sql, params as SqlValue[]);
  }
  async get<T>(sql: string, params: readonly SqlValue[] = []): Promise<T | null> {
    return (await this.exec_.getFirstAsync<T>(sql, params as SqlValue[])) ?? null;
  }
  async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    if (!this.root) throw new Error('Nested transactions are not supported');
    let result: T | undefined;
    // Exclusive transactions run on their own connection scope, so concurrent queries from
    // elsewhere in the app cannot be interleaved into this transaction.
    await this.root.withExclusiveTransactionAsync(async (txn) => {
      result = await fn(new ExecutorDriver(txn, null));
    });
    return result as T;
  }
}

/** expo-sqlite implementation of the shared SqlDriver contract. */
export function createExpoSqliteDriver(db: SQLiteDatabase): SqlDriver {
  return new ExecutorDriver(db, db);
}
