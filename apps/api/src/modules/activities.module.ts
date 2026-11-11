import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { activityEditSchema, activitySchema, locationSampleSchema, z } from '@pace/validation';
import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';
import { type AuthUser, CurrentUser } from '../common/auth';
import { type Page, ZodPipe } from '../common/http';
import { type AppDatabase, DB } from '../database/database.module';
import { activities, routePoints } from '../database/schema';

/** Activity payload as produced by the mobile sync engine (local SQLite shape). */
const syncSchema = z.object({
  activity: activitySchema.omit({ userId: true }),
});
type SyncBody = z.infer<typeof syncSchema>;

const routeBatchSchema = z.object({
  firstSequence: z.number().int().nonnegative(),
  samples: z
    .array(locationSampleSchema.extend({ sequenceNumber: z.number().int().nonnegative() }))
    .min(1)
    .max(5000),
});
type RouteBatch = z.infer<typeof routeBatchSchema>;

const deleteSchema = z.object({ version: z.number().int().nonnegative() });
const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});

type Row = typeof activities.$inferSelect;

export function toActivityDto(r: Row) {
  return {
    id: r.id,
    sportType: r.sportType,
    title: r.title,
    description: r.description,
    startedAt: r.startedAt.getTime(),
    endedAt: r.endedAt?.getTime() ?? null,
    timezone: r.timezone,
    status: r.status,
    source: r.source,
    swimMode: r.swimMode,
    poolLengthMeters: r.poolLengthMeters,
    elapsedDurationMs: r.elapsedDurationMs,
    movingDurationMs: r.movingDurationMs,
    distanceMeters: r.distanceMeters,
    elevationGainMeters: r.elevationGainMeters,
    elevationLossMeters: r.elevationLossMeters,
    averageSpeedMps: r.averageSpeedMps,
    maximumSpeedMps: r.maximumSpeedMps,
    averagePaceMsPerKm: r.averagePaceMsPerKm,
    version: r.version,
    updatedAt: r.clientUpdatedAt.getTime(),
    deletedAt: r.deletedAt?.getTime() ?? null,
  };
}

@Injectable()
export class ActivitiesService {
  constructor(@Inject(DB) private readonly db: AppDatabase) {}

  private async owned(userId: string, id: string): Promise<Row | null> {
    const [r] = await this.db
      .select()
      .from(activities)
      .where(and(eq(activities.id, id), eq(activities.userId, userId)));
    return r ?? null;
  }

  /** Activity ids are client-generated UUIDs. Another user's id is reported as a conflict without revealing data. */
  private async assertNotForeign(userId: string, id: string): Promise<void> {
    const [r] = await this.db
      .select({ userId: activities.userId })
      .from(activities)
      .where(eq(activities.id, id));
    if (r && r.userId !== userId)
      throw new ConflictException({ code: 'id_conflict', message: 'Activity id is not available' });
  }

  /**
   * Version-checked upsert:
   * - unknown id → created ("applied");
   * - same version and timestamp → "duplicate" (idempotent retry);
   * - higher version → applied;
   * - otherwise → 409 with the server copy, so the client can merge with its conflict policy.
   * A tombstoned activity is never resurrected.
   */
  async sync(
    userId: string,
    body: SyncBody,
  ): Promise<{ status: 'applied' | 'duplicate'; activity: ReturnType<typeof toActivityDto> }> {
    const a = body.activity;
    await this.assertNotForeign(userId, a.id);
    const values = {
      id: a.id,
      userId,
      sportType: a.sportType,
      title: a.title,
      description: a.description,
      startedAt: new Date(a.startedAt),
      endedAt: a.endedAt != null ? new Date(a.endedAt) : null,
      timezone: a.timezone,
      status: a.status,
      source: a.source,
      swimMode: a.swimMode,
      poolLengthMeters: a.poolLengthMeters,
      elapsedDurationMs: Math.round(a.elapsedDurationMs),
      movingDurationMs: Math.round(a.movingDurationMs),
      distanceMeters: a.distanceMeters,
      elevationGainMeters: a.elevationGainMeters,
      elevationLossMeters: a.elevationLossMeters,
      averageSpeedMps: a.averageSpeedMps,
      maximumSpeedMps: a.maximumSpeedMps,
      averagePaceMsPerKm: a.averagePaceMsPerKm,
      version: a.version,
      clientUpdatedAt: new Date(a.updatedAt),
      deletedAt: a.deletedAt != null ? new Date(a.deletedAt) : null,
    };
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(activities)
        .where(eq(activities.id, a.id))
        .for('update');
      if (!existing) {
        const [created] = await tx.insert(activities).values(values).returning();
        return { status: 'applied' as const, activity: toActivityDto(created!) };
      }
      if (existing.version === a.version && existing.clientUpdatedAt.getTime() === a.updatedAt) {
        return { status: 'duplicate' as const, activity: toActivityDto(existing) };
      }
      if (existing.deletedAt || a.version <= existing.version) {
        throw new ConflictException({
          code: 'version_conflict',
          message: 'Server has a newer version',
          server: toActivityDto(existing),
        });
      }
      const [updated] = await tx
        .update(activities)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(activities.id, a.id))
        .returning();
      return { status: 'applied' as const, activity: toActivityDto(updated!) };
    });
  }

  /** Idempotent: re-sending a batch inserts nothing new. */
  async addRouteBatch(
    userId: string,
    id: string,
    batch: RouteBatch,
  ): Promise<{ inserted: number }> {
    const a = await this.owned(userId, id);
    if (!a || a.deletedAt)
      throw new NotFoundException({ code: 'not_found', message: 'Activity not found' });
    batch.samples.forEach((s, i) => {
      if (s.sequenceNumber !== batch.firstSequence + i) {
        throw new ConflictException({
          code: 'invalid_batch',
          message: 'Samples must be contiguous from firstSequence',
        });
      }
    });
    const rows = await this.db
      .insert(routePoints)
      .values(
        batch.samples.map((s) => ({
          activityId: id,
          sequenceNumber: s.sequenceNumber,
          latitude: s.latitude,
          longitude: s.longitude,
          altitudeMeters: s.altitudeMeters,
          horizontalAccuracyMeters: s.horizontalAccuracyMeters,
          verticalAccuracyMeters: s.verticalAccuracyMeters,
          speedMps: s.speedMps,
          courseDegrees: s.courseDegrees,
          recordedAt: new Date(s.recordedAt),
          source: s.source,
        })),
      )
      .onConflictDoNothing()
      .returning({ seq: routePoints.sequenceNumber });
    return { inserted: rows.length };
  }

  async list(
    userId: string,
    q: z.infer<typeof listSchema>,
  ): Promise<Page<ReturnType<typeof toActivityDto>>> {
    const conds = [eq(activities.userId, userId), isNull(activities.deletedAt)];
    if (q.cursor) {
      const [ts, cid] = Buffer.from(q.cursor, 'base64url').toString('utf8').split('|');
      const t = Number(ts);
      if (Number.isFinite(t) && cid) {
        conds.push(
          or(
            lt(activities.startedAt, new Date(t)),
            and(eq(activities.startedAt, new Date(t)), lt(activities.id, cid)),
          )!,
        );
      }
    }
    const rows = await this.db
      .select()
      .from(activities)
      .where(and(...conds))
      .orderBy(desc(activities.startedAt), desc(activities.id))
      .limit(q.limit + 1);
    const items = rows.slice(0, q.limit).map(toActivityDto);
    const last = rows.length > q.limit ? rows[q.limit - 1] : undefined;
    return {
      items,
      nextCursor: last
        ? Buffer.from(`${last.startedAt.getTime()}|${last.id}`).toString('base64url')
        : null,
    };
  }

  async get(userId: string, id: string) {
    const a = await this.owned(userId, id);
    if (!a || a.deletedAt)
      throw new NotFoundException({ code: 'not_found', message: 'Activity not found' });
    return toActivityDto(a);
  }

  async edit(userId: string, id: string, patch: z.infer<typeof activityEditSchema>) {
    const [r] = await this.db
      .update(activities)
      .set({
        ...patch,
        version: (await this.get(userId, id)).version + 1,
        clientUpdatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(eq(activities.id, id), eq(activities.userId, userId), isNull(activities.deletedAt)),
      )
      .returning();
    if (!r) throw new NotFoundException({ code: 'not_found', message: 'Activity not found' });
    return toActivityDto(r);
  }

  /** Tombstone: metadata row is kept (for other devices to sync the deletion), route data is purged. */
  async remove(userId: string, id: string, version: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [a] = await tx
        .select()
        .from(activities)
        .where(and(eq(activities.id, id), eq(activities.userId, userId)))
        .for('update');
      if (!a) return; // already gone: deletion is idempotent
      await tx.delete(routePoints).where(eq(routePoints.activityId, id));
      await tx
        .update(activities)
        .set({
          deletedAt: a.deletedAt ?? new Date(),
          version: Math.max(a.version + 1, version),
          updatedAt: new Date(),
        })
        .where(eq(activities.id, id));
    });
  }
}

@Controller('activities')
export class ActivitiesController {
  constructor(private readonly svc: ActivitiesService) {}

  @Post('sync')
  @HttpCode(200)
  sync(@CurrentUser() user: AuthUser, @Body(new ZodPipe(syncSchema)) body: SyncBody) {
    return this.svc.sync(user.id, body);
  }

  @Post(':id/route-batches')
  @HttpCode(200)
  route(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(routeBatchSchema)) body: RouteBatch,
  ) {
    return this.svc.addRouteBatch(user.id, id, body);
  }

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query(new ZodPipe(listSchema)) q: z.infer<typeof listSchema>,
  ) {
    return this.svc.list(user.id, q);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(user.id, id);
  }

  @Patch(':id')
  edit(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(activityEditSchema)) body: z.infer<typeof activityEditSchema>,
  ) {
    return this.svc.edit(user.id, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(deleteSchema.partial())) q: { version?: number },
  ) {
    await this.svc.remove(user.id, id, q.version ?? 0);
  }
}

@Module({ controllers: [ActivitiesController], providers: [ActivitiesService] })
export class ActivitiesModule {}
