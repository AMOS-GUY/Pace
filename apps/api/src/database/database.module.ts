import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import { APP_ENV, type AppEnv } from '../config/env';
import { schema } from './schema';

export type AppDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;
export const DB = Symbol('DB');
export const DB_POOL = Symbol('DB_POOL');

/** Liveness hook for /health, independent of driver (node-postgres or PGlite). */
export const DB_PING = Symbol('DB_PING');
export type DbPing = () => Promise<void>;

@Global()
@Module({
  providers: [
    {
      provide: DB_POOL,
      inject: [APP_ENV],
      useFactory: (env: AppEnv) =>
        new Pool({
          connectionString: env.DATABASE_URL,
          max: 10,
          ssl: env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : undefined,
        }),
    },
    { provide: DB, inject: [DB_POOL], useFactory: (pool: Pool) => drizzle(pool, { schema }) },
    {
      provide: DB_PING,
      inject: [DB_POOL],
      useFactory:
        (pool: Pool): DbPing =>
        async () =>
          void (await pool.query('SELECT 1')),
    },
  ],
  exports: [DB, DB_PING],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
