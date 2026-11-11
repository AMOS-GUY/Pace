import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  PayloadTooLargeException,
  Post,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from '@pace/validation';
import { and, desc, eq } from 'drizzle-orm';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { type AuthUser, CurrentUser } from '../common/auth';
import { IdempotencyService } from '../common/idempotency';
import { ZodPipe } from '../common/http';
import { OBJECT_STORAGE, type ObjectStorage, UnconfiguredStorage } from '../common/storage';
import { type AppDatabase, DB } from '../database/database.module';
import { backups } from '../database/schema';

export const MAX_BACKUP_BYTES = 512 * 1024 * 1024;
const MAX_BACKUPS_PER_USER = 30;

const createSchema = z.object({
  sizeBytes: z.number().int().positive(),
  checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
  formatVersion: z.number().int().positive(),
  // Cloud backups must be encrypted on the device. The server never accepts plaintext data.
  encrypted: z.literal(true),
});
type CreateBody = z.infer<typeof createSchema>;

type Row = typeof backups.$inferSelect;
const toDto = (b: Row) => ({
  id: b.id,
  createdAt: b.createdAt.toISOString(),
  completedAt: b.completedAt?.toISOString() ?? null,
  sizeBytes: b.sizeBytes,
  checksumSha256: b.checksumSha256,
  formatVersion: b.formatVersion,
  encrypted: b.encrypted,
  status: b.status as 'pending' | 'complete',
});

@Injectable()
export class BackupsService {
  constructor(
    @Inject(DB) private readonly db: AppDatabase,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  private ensureStorage(): void {
    if (this.storage instanceof UnconfiguredStorage) {
      throw new ServiceUnavailableException({
        code: 'storage_unavailable',
        message: 'Cloud backup storage is not configured',
      });
    }
  }

  private async owned(userId: string, id: string): Promise<Row> {
    const [b] = await this.db
      .select()
      .from(backups)
      .where(and(eq(backups.id, id), eq(backups.userId, userId)));
    if (!b) throw new NotFoundException({ code: 'not_found', message: 'Backup not found' });
    return b;
  }

  async create(userId: string, body: CreateBody) {
    this.ensureStorage();
    if (body.sizeBytes > MAX_BACKUP_BYTES)
      throw new PayloadTooLargeException({
        code: 'too_large',
        message: 'Backup exceeds the 512 MB limit',
      });
    const existing = await this.db
      .select({ id: backups.id })
      .from(backups)
      .where(eq(backups.userId, userId));
    if (existing.length >= MAX_BACKUPS_PER_USER) {
      throw new ConflictException({
        code: 'backup_limit',
        message: `Delete old backups first (limit ${MAX_BACKUPS_PER_USER})`,
      });
    }
    const id = randomUUID();
    const storageKey = `users/${userId}/backups/${id}.pacebackup`;
    const [b] = await this.db
      .insert(backups)
      .values({
        id,
        userId,
        formatVersion: body.formatVersion,
        storageKey,
        sizeBytes: body.sizeBytes,
        checksumSha256: body.checksumSha256,
        encrypted: true,
        status: 'pending',
      })
      .returning();
    const uploadUrl = await this.storage.presignPut(storageKey, body.sizeBytes, 15 * 60);
    return { backup: toDto(b!), uploadUrl };
  }

  /** Confirms the upload landed with the declared size before the backup is offered for restore. */
  async complete(userId: string, id: string) {
    this.ensureStorage();
    const b = await this.owned(userId, id);
    if (b.status === 'complete') return { backup: toDto(b) };
    const size = await this.storage.head(b.storageKey);
    if (size == null)
      throw new ConflictException({
        code: 'upload_missing',
        message: 'The backup file has not been uploaded yet',
      });
    if (size !== b.sizeBytes)
      throw new ConflictException({
        code: 'size_mismatch',
        message: 'Uploaded size does not match the declared size',
      });
    const [u] = await this.db
      .update(backups)
      .set({ status: 'complete', completedAt: new Date() })
      .where(eq(backups.id, id))
      .returning();
    return { backup: toDto(u!) };
  }

  async list(userId: string) {
    const rows = await this.db
      .select()
      .from(backups)
      .where(eq(backups.userId, userId))
      .orderBy(desc(backups.createdAt));
    return { items: rows.map(toDto) };
  }

  async download(userId: string, id: string) {
    this.ensureStorage();
    const b = await this.owned(userId, id);
    if (b.status !== 'complete')
      throw new ConflictException({
        code: 'incomplete',
        message: 'Backup upload was not completed',
      });
    return { backup: toDto(b), downloadUrl: await this.storage.presignGet(b.storageKey, 10 * 60) };
  }

  async remove(userId: string, id: string): Promise<void> {
    const b = await this.owned(userId, id);
    if (!(this.storage instanceof UnconfiguredStorage)) await this.storage.delete(b.storageKey);
    await this.db.delete(backups).where(eq(backups.id, id));
  }

  /** All objects for a user (account deletion). */
  async removeAll(userId: string): Promise<void> {
    const rows = await this.db.select().from(backups).where(eq(backups.userId, userId));
    if (!(this.storage instanceof UnconfiguredStorage))
      for (const b of rows) await this.storage.delete(b.storageKey);
    await this.db.delete(backups).where(eq(backups.userId, userId));
  }
}

@Controller('backups')
export class BackupsController {
  constructor(
    private readonly svc: BackupsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(createSchema)) body: CreateBody,
    @Headers('idempotency-key') key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const r = await this.idempotency.run(
      user.id,
      key ? `backup:${key}` : undefined,
      body,
      async () => ({ status: 201, body: await this.svc.create(user.id, body) }),
    );
    res.status(r.status);
    return r.body;
  }

  @Post(':id/complete')
  @HttpCode(200)
  complete(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.complete(user.id, id);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.svc.list(user.id);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.download(user.id, id);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.svc.remove(user.id, id);
  }
}

@Module({
  controllers: [BackupsController],
  providers: [BackupsService, IdempotencyService],
  exports: [BackupsService],
})
export class BackupsModule {}
