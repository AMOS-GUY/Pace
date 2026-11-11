import { configureConnection, migrate, SettingsRepository } from '@pace/database';
import type { SQLiteDatabase } from 'expo-sqlite';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createExpoSqliteDriver } from './expo-sqlite-driver';

/**
 * Minimal stand-in exposing the expo-sqlite async API over node:sqlite, so the adapter's
 * parameter passing and transaction semantics are tested against a real SQLite engine.
 */
function fakeExpoDb(): SQLiteDatabase {
  const db = new DatabaseSync(':memory:');
  const exec = {
    execAsync: async (sql: string) => void db.exec(sql),
    runAsync: async (sql: string, params: SQLInputValue[]) => {
      const r = db.prepare(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
    },
    getAllAsync: async (sql: string, params: SQLInputValue[]) => db.prepare(sql).all(...params),
    getFirstAsync: async (sql: string, params: SQLInputValue[]) =>
      db.prepare(sql).get(...params) ?? null,
  };
  return {
    ...exec,
    withExclusiveTransactionAsync: async (fn: (txn: typeof exec) => Promise<void>) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        await fn(exec);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  } as unknown as SQLiteDatabase;
}

describe('expo-sqlite driver adapter', () => {
  it('runs migrations and repositories', async () => {
    const driver = createExpoSqliteDriver(fakeExpoDb());
    await configureConnection(driver);
    expect((await migrate(driver)).applied).toEqual([1]);
    const settings = new SettingsRepository({ db: driver, now: () => 1, newId: () => 'x' });
    await settings.set('units', 'metric');
    expect(await settings.get('units')).toBe('metric');
  });

  it('commits and rolls back transactions', async () => {
    const driver = createExpoSqliteDriver(fakeExpoDb());
    await driver.exec('CREATE TABLE t (v INTEGER)');
    await driver.transaction(async (tx) => {
      await tx.run('INSERT INTO t VALUES (?)', [1]);
    });
    await expect(
      driver.transaction(async (tx) => {
        await tx.run('INSERT INTO t VALUES (?)', [2]);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await driver.all<{ v: number }>('SELECT v FROM t')).toEqual([{ v: 1 }]);
    await expect(
      driver.transaction(async (tx) => tx.transaction(async () => undefined)),
    ).rejects.toThrow('Nested');
  });
});
