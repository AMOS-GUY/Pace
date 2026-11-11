/**
 * Outbox-based synchronisation engine.
 *
 * Local changes are written to `sync_outbox` in the same transaction as the change itself.
 * The engine pushes due entries with an idempotency key, retries failures with capped
 * exponential backoff and jitter, and resolves conflicts with explicit, per-field rules.
 * It never deletes local data as a consequence of a successful upload.
 */

export interface OutboxItem {
  id: number;
  entityType: 'activity' | 'goal' | 'profile';
  entityId: string;
  operation: 'upsert' | 'delete';
  entityVersion: number;
  idempotencyKey: string;
  attempts: number;
}

export interface OutboxPort {
  due(limit: number): Promise<OutboxItem[]>;
  complete(id: number): Promise<void>;
  fail(id: number, nextAttemptAt: number, error: string): Promise<void>;
}

export type PushResult =
  | { status: 'applied' | 'duplicate' }
  | { status: 'conflict'; serverVersion: number; serverEntity: unknown }
  | { status: 'rejected'; reason: string };

export interface SyncTransport {
  push(item: OutboxItem, payload: unknown): Promise<PushResult>;
  /** Upload raw route samples in idempotent batches keyed by (activityId, firstSequence). */
  pushRouteBatch(
    activityId: string,
    firstSequence: number,
    samples: readonly unknown[],
  ): Promise<void>;
}

export interface EntitySource {
  /** Current local payload for an entity, or null when it no longer exists locally. */
  load(entityType: OutboxItem['entityType'], entityId: string): Promise<unknown>;
  /** Raw route samples for an activity, from `afterSequence` (exclusive), at most `limit`. */
  routeSamples(
    activityId: string,
    afterSequence: number,
    limit: number,
  ): Promise<Array<{ sequenceNumber: number }>>;
  /** Apply a merged entity after conflict resolution (local write + new outbox entry). */
  applyResolved(
    entityType: OutboxItem['entityType'],
    entityId: string,
    merged: unknown,
  ): Promise<void>;
}

export type ConflictResolver = (
  entityType: OutboxItem['entityType'],
  local: unknown,
  server: unknown,
) => unknown;

export interface SyncOptions {
  now: () => number;
  random?: () => number;
  batchSize?: number;
  routeBatchSize?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Errors marked permanent stop retrying fast; still kept in the outbox for diagnosis. */
  maxAttempts?: number;
  /** Entity types this server supports; others remain in the outbox untouched. */
  entityTypes?: ReadonlyArray<OutboxItem['entityType']>;
}

export interface SyncReport {
  pushed: number;
  failed: number;
  conflicts: number;
  rejected: number;
}

/** Capped exponential backoff with full jitter: random in [0, min(cap, base * 2^attempt)]. */
export function backoffDelayMs(
  attempt: number,
  base: number,
  cap: number,
  random: () => number,
): number {
  const exp = Math.min(cap, base * 2 ** Math.min(attempt, 30));
  return Math.max(base, Math.floor(random() * exp));
}

export class SyncEngine {
  private running = false;

  constructor(
    private readonly outbox: OutboxPort,
    private readonly source: EntitySource,
    private readonly transport: SyncTransport,
    private readonly resolve: ConflictResolver,
    private readonly options: SyncOptions,
  ) {}

  /** Push every due entry once. Concurrent calls are coalesced. */
  async runOnce(): Promise<SyncReport> {
    const report: SyncReport = { pushed: 0, failed: 0, conflicts: 0, rejected: 0 };
    if (this.running) return report;
    this.running = true;
    try {
      const items = await this.outbox.due(this.options.batchSize ?? 25);
      for (const item of items) {
        // Entity types the server does not accept yet stay queued (never reported as synced).
        if (this.options.entityTypes && !this.options.entityTypes.includes(item.entityType))
          continue;
        try {
          const payload =
            item.operation === 'delete'
              ? null
              : await this.source.load(item.entityType, item.entityId);
          if (item.operation === 'upsert' && payload == null) {
            // Entity vanished locally (e.g. deleted since) — a later delete entry supersedes this one.
            await this.outbox.complete(item.id);
            continue;
          }
          const result = await this.transport.push(item, payload);
          switch (result.status) {
            case 'applied':
            case 'duplicate':
              // Route points reference the activity row, so they follow the metadata upload.
              // Batches are idempotent, so a retry after a partial upload is safe.
              if (item.entityType === 'activity' && item.operation === 'upsert') {
                await this.pushRoute(item.entityId);
              }
              await this.outbox.complete(item.id);
              report.pushed++;
              break;
            case 'conflict': {
              const merged = this.resolve(item.entityType, payload, result.serverEntity);
              await this.source.applyResolved(item.entityType, item.entityId, merged);
              await this.outbox.complete(item.id);
              report.conflicts++;
              break;
            }
            case 'rejected':
              await this.retryLater(item, `rejected: ${result.reason}`, true);
              report.rejected++;
              break;
          }
        } catch (e) {
          await this.retryLater(item, e instanceof Error ? e.message : String(e), false);
          report.failed++;
        }
      }
      return report;
    } finally {
      this.running = false;
    }
  }

  private async pushRoute(activityId: string): Promise<void> {
    const size = this.options.routeBatchSize ?? 2000;
    let after = -1;
    for (;;) {
      const batch = await this.source.routeSamples(activityId, after, size);
      if (batch.length === 0) return;
      await this.transport.pushRouteBatch(activityId, batch[0]!.sequenceNumber, batch);
      after = batch[batch.length - 1]!.sequenceNumber;
      if (batch.length < size) return;
    }
  }

  private async retryLater(item: OutboxItem, error: string, permanent: boolean): Promise<void> {
    const base = this.options.baseDelayMs ?? 5_000;
    const cap = this.options.maxDelayMs ?? 6 * 3_600_000;
    const attempt = permanent ? Math.max(item.attempts, 20) : item.attempts;
    const delay = backoffDelayMs(attempt, base, cap, this.options.random ?? Math.random);
    await this.outbox.fail(item.id, this.options.now() + delay, error);
  }
}

// ============================================================================ conflict rules

export interface SyncableActivity {
  id: string;
  title: string;
  description: string | null;
  updatedAt: number;
  version: number;
  deletedAt: number | null;
  [key: string]: unknown;
}

/**
 * Activity conflict policy (not blanket last-write-wins):
 * - recorded data (times, distance, metrics, route) is immutable once completed: local wins;
 * - user-editable fields (title, description) take the most recently updated side;
 * - a deletion on either side wins (tombstones are never resurrected);
 * - the merged version is above both sides so it supersedes them.
 */
export function resolveActivityConflict(
  local: SyncableActivity,
  server: SyncableActivity,
): SyncableActivity {
  const editsFromServer = server.updatedAt > local.updatedAt;
  return {
    ...local,
    title: editsFromServer ? server.title : local.title,
    description: editsFromServer ? server.description : local.description,
    deletedAt: local.deletedAt ?? server.deletedAt ?? null,
    updatedAt: Math.max(local.updatedAt, server.updatedAt),
    version: Math.max(local.version, server.version) + 1,
  };
}
