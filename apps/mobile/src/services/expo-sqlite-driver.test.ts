import { MIGRATIONS, SettingsRepository, configureConnection, migrate } from '@pace/database';
import type { SQLiteDatabase } from 'expo-sqlite';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createExpoSqliteDriver } from './expo-sqlite-driver';

/**
 * Stand-in exposing the expo-sqlite async API over one node:sqlite connection. Every call yields
 * to the event loop first, like the real bridge, so interleaving bugs can surface.
 * `withTransactionAsync` mirrors expo-sqlite: BEGIN/COMMIT on the same connection.
 */
function fakeExpoDb(): { db: SQLiteDatabase; log: string[] } {
  const raw = new DatabaseSync(':memory:');
  const log: string[] = [];
  const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
  const api = {
    execAsync: async (sql: string) => {
      await tick();
      log.push(sql.split(' ')[0]!);
      raw.exec(sql);
    },
    runAsync: async (sql: string, params: SQLInputValue[]) => {
      await tick();
      log.push(sql.split(' ')[0]!);
      const r = raw.prepare(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
    },
    getAllAsync: async (sql: string, params: SQLInputValue[]) => {
      await tick();
      return raw.prepare(sql).all(...params);
    },
    getFirstAsync: async (sql: string, params: SQLInputValue[]) => {
      await tick();
      return raw.prepare(sql).get(...params) ?? null;
    },
  };
  const db = {
    ...api,
    withTransactionAsync: async (task: () => Promise<void>) => {
      await api.execAsync('BEGIN');
      try {
        await task();
        await api.execAsync('COMMIT');
      } catch (e) {
        await api.execAsync('ROLLBACK');
        throw e;
      }
    },
  } as unknown as SQLiteDatabase;
  return { db, log };
}

describe('expo-sqlite driver adapter', () => {
  it('runs migrations and repositories', async () => {
    const driver = createExpoSqliteDriver(fakeExpoDb().db);
    await configureConnection(driver);
    expect((await migrate(driver)).applied).toEqual(MIGRATIONS.map((m) => m.version));
    // The table-rebuild migration switches foreign keys off around its transaction; the adapter
    // must end with them enforced again.
    expect(await driver.get('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });
    const settings = new SettingsRepository({ db: driver, now: () => 1, newId: () => 'x' });
    await settings.set('units', 'metric');
    expect(await settings.get('units')).toBe('metric');
  });

  it('commits and rolls back transactions', async () => {
    const driver = createExpoSqliteDriver(fakeExpoDb().db);
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

  it('enforces foreign keys inside transactions (pragmas apply to the one connection)', async () => {
    // Regression: withExclusiveTransactionAsync opens a new connection where foreign_keys is off.
    const driver = createExpoSqliteDriver(fakeExpoDb().db);
    await configureConnection(driver);
    await migrate(driver);
    await expect(
      driver.transaction((tx) =>
        tx.run(
          "INSERT INTO route_points (activity_id, sequence_number, latitude, longitude, horizontal_accuracy_meters, recorded_at, source) VALUES ('missing', 0, 1, 1, 5, 1, 'replay')",
        ),
      ),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it('never interleaves outside statements into an open transaction', async () => {
    const { db, log } = fakeExpoDb();
    const driver = createExpoSqliteDriver(db);
    await driver.exec('CREATE TABLE t (v INTEGER)');
    log.length = 0;
    const tx = driver.transaction(async (t) => {
      await t.run('INSERT INTO t VALUES (?)', [1]);
      await new Promise((r) => setTimeout(r, 5));
      await t.run('INSERT INTO t VALUES (?)', [2]);
      throw new Error('rollback');
    });
    const outside = driver.run('INSERT INTO t VALUES (?)', [99]);
    await expect(tx).rejects.toThrow('rollback');
    await outside;
    // The outside insert ran after the rollback, so it survives and the transaction's rows don't.
    expect(log).toEqual(['BEGIN', 'INSERT', 'INSERT', 'ROLLBACK', 'INSERT']);
    expect(await driver.all<{ v: number }>('SELECT v FROM t')).toEqual([{ v: 99 }]);
  });
});
