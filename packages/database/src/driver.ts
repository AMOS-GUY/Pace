export type SqlValue = string | number | null | Uint8Array;

/**
 * Minimal async SQL driver contract.
 *
 * Implemented by `expo-sqlite` on device and by `node:sqlite` in tests, so every repository and
 * migration runs against real SQLite in both environments.
 */
export interface SqlDriver {
  /** Execute one or more statements without parameters (DDL). */
  exec(sql: string): Promise<void>;
  run(sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }>;
  all<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  get<T>(sql: string, params?: readonly SqlValue[]): Promise<T | null>;
  /**
   * Run `fn` in an exclusive transaction. Commits when it resolves, rolls back when it rejects.
   * Statements inside must use the provided `tx` driver.
   */
  transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T>;
}

/** Inserts rows in chunks so the statement stays well under SQLite's bound-parameter limit. */
export async function insertMany(
  db: SqlDriver,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly SqlValue[])[],
  options: { onConflict?: 'ignore' | 'abort' } = {},
): Promise<void> {
  if (rows.length === 0) return;
  const perRow = `(${columns.map(() => '?').join(',')})`;
  const chunk = Math.max(1, Math.floor(900 / columns.length));
  const verb = options.onConflict === 'ignore' ? 'INSERT OR IGNORE' : 'INSERT';
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const params: SqlValue[] = [];
    for (const r of slice) {
      if (r.length !== columns.length)
        throw new Error(`Row has ${r.length} values, expected ${columns.length}`);
      params.push(...r);
    }
    await db.run(
      `${verb} INTO ${table} (${columns.join(',')}) VALUES ${slice.map(() => perRow).join(',')}`,
      params,
    );
  }
}
