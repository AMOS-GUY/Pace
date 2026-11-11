import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Minimal SQL executor shared by node-postgres (production) and PGlite (tests). */
export interface SqlExec {
  exec(sql: string): Promise<unknown>;
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export const MIGRATIONS_DIR = resolve(__dirname, '../../../../infrastructure/database/migrations');

/**
 * Applies pending SQL migrations in filename order, each in a transaction, recording them in
 * schema_migrations. Applied files are never re-run or modified.
 */
export async function runMigrations(db: SqlExec, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const applied = new Set(
    (await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
      (r) => r.name,
    ),
  );
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  const ran: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(dir, f), 'utf8');
    await db.exec('BEGIN');
    try {
      await db.exec(sql);
      await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      await db.exec('COMMIT');
    } catch (e) {
      await db.exec('ROLLBACK');
      throw new Error(`Migration ${f} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    ran.push(f);
  }
  return ran;
}

/** CLI: `pnpm --filter @pace/api db:migrate` (reads DATABASE_URL). */
if (require.main === module) {
  void (async () => {
    const { Pool } = await import('pg');
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is required');
    const pool = new Pool({ connectionString: url });
    const client = await pool.connect();
    try {
      const ran = await runMigrations({
        exec: (s) => client.query(s),
        query: <T>(s: string, p?: unknown[]) =>
          client.query(s, p) as unknown as Promise<{ rows: T[] }>,
      });
      console.warn(ran.length ? `Applied: ${ran.join(', ')}` : 'Database is up to date.');
    } finally {
      client.release();
      await pool.end();
    }
  })().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
