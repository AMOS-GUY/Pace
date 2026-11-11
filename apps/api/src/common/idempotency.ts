import { createHash } from 'node:crypto';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, eq, lt } from 'drizzle-orm';
import { type AppDatabase, DB } from '../database/database.module';
import { idempotencyKeys } from '../database/schema';

/**
 * Stores the first response for (user, Idempotency-Key) and replays it for retries with the
 * same body. Reusing a key with a different body is a client bug and returns 409.
 */
@Injectable()
export class IdempotencyService {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  async run<T>(
    userId: string,
    key: string | undefined,
    body: unknown,
    fn: () => Promise<{ status: number; body: T }>,
  ): Promise<{ status: number; body: T }> {
    if (!key) return fn();
    if (key.length > 200)
      throw new ConflictException({
        code: 'invalid_idempotency_key',
        message: 'Idempotency key too long',
      });
    const hash = createHash('sha256')
      .update(JSON.stringify(body ?? null))
      .digest('hex');
    const [existing] = await this.db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)));
    if (existing) {
      if (existing.requestHash !== hash) {
        throw new ConflictException({
          code: 'idempotency_key_reused',
          message: 'Idempotency key was used with a different request',
        });
      }
      return { status: existing.statusCode, body: existing.response as T };
    }
    const result = await fn();
    await this.db
      .insert(idempotencyKeys)
      .values({
        userId,
        key,
        requestHash: hash,
        statusCode: result.status,
        response: result.body as object,
      })
      .onConflictDoNothing();
    return result;
  }

  /** Housekeeping: keys older than `days` are no longer needed for retries. */
  async purgeOlderThan(days: number): Promise<void> {
    await this.db
      .delete(idempotencyKeys)
      .where(lt(idempotencyKeys.createdAt, new Date(Date.now() - days * 86_400_000)));
  }
}
