import {
  type EntitySource,
  type OutboxItem,
  type OutboxPort,
  type PushResult,
  SyncEngine,
  type SyncTransport,
  backoffDelayMs,
  resolveActivityConflict,
} from './index';

class MemOutbox implements OutboxPort {
  items: Array<OutboxItem & { nextAttemptAt: number; lastError?: string }> = [];
  constructor(private readonly now: () => number) {}
  async due(limit: number): Promise<OutboxItem[]> {
    return this.items.filter((i) => i.nextAttemptAt <= this.now()).slice(0, limit);
  }
  async complete(id: number): Promise<void> {
    this.items = this.items.filter((i) => i.id !== id);
  }
  async fail(id: number, next: number, error: string): Promise<void> {
    const i = this.items.find((x) => x.id === id)!;
    i.attempts++;
    i.nextAttemptAt = next;
    i.lastError = error;
  }
}

const activity = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  title: 'Run',
  description: null,
  updatedAt: 100,
  version: 2,
  deletedAt: null,
  distanceMeters: 5000,
  ...over,
});

function setup(push: (item: OutboxItem) => PushResult | Promise<PushResult>) {
  let t = 1_000;
  const now = () => t;
  const outbox = new MemOutbox(now);
  outbox.items.push({
    id: 1,
    entityType: 'activity',
    entityId: 'a1',
    operation: 'upsert',
    entityVersion: 2,
    idempotencyKey: 'activity:a1:2:upsert',
    attempts: 0,
    nextAttemptAt: 0,
  });
  const routeBatches: number[] = [];
  const applied: unknown[] = [];
  const samples = Array.from({ length: 4500 }, (_, i) => ({ sequenceNumber: i }));
  const source: EntitySource = {
    load: async () => activity(),
    routeSamples: async (_id, after, limit) =>
      samples.filter((s) => s.sequenceNumber > after).slice(0, limit),
    applyResolved: async (_t, _id, merged) => {
      applied.push(merged);
    },
  };
  const transport: SyncTransport = {
    push: async (item) => push(item),
    pushRouteBatch: async (_id, first) => {
      routeBatches.push(first);
    },
  };
  const engine = new SyncEngine(
    outbox,
    source,
    transport,
    (_t, l, s) => resolveActivityConflict(l as never, s as never),
    {
      now,
      random: () => 0.5,
      baseDelayMs: 1000,
      maxDelayMs: 60_000,
    },
  );
  return {
    engine,
    outbox,
    routeBatches,
    applied,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('SyncEngine', () => {
  it('uploads route points in batches, then the activity, and clears the outbox', async () => {
    const { engine, outbox, routeBatches } = setup(() => ({ status: 'applied' }));
    expect(await engine.runOnce()).toEqual({ pushed: 1, failed: 0, conflicts: 0, rejected: 0 });
    expect(routeBatches).toEqual([0, 2000, 4000]);
    expect(outbox.items).toHaveLength(0);
  });

  it('treats duplicates as success (idempotency)', async () => {
    const { engine, outbox } = setup(() => ({ status: 'duplicate' }));
    await engine.runOnce();
    expect(outbox.items).toHaveLength(0);
  });

  it('retries failures with backoff and keeps the entry', async () => {
    let calls = 0;
    const { engine, outbox, advance } = setup(() => {
      calls++;
      if (calls === 1) throw new Error('network down');
      return { status: 'applied' };
    });
    expect((await engine.runOnce()).failed).toBe(1);
    expect(outbox.items[0]!.attempts).toBe(1);
    expect(outbox.items[0]!.lastError).toBe('network down');
    expect((await engine.runOnce()).pushed).toBe(0); // not yet due
    advance(60_000);
    expect((await engine.runOnce()).pushed).toBe(1);
  });

  it('resolves conflicts with the activity policy', async () => {
    const { engine, applied } = setup(() => ({
      status: 'conflict',
      serverVersion: 5,
      serverEntity: activity({
        title: 'Renamed on web',
        updatedAt: 200,
        version: 5,
        distanceMeters: 1,
      }),
    }));
    expect((await engine.runOnce()).conflicts).toBe(1);
    expect(applied[0]).toMatchObject({ title: 'Renamed on web', distanceMeters: 5000, version: 6 });
  });
});

describe('conflict rules and backoff', () => {
  it('never resurrects a deleted activity', () => {
    const merged = resolveActivityConflict(
      activity({ updatedAt: 300 }) as never,
      activity({ deletedAt: 250, updatedAt: 250 }) as never,
    );
    expect(merged.deletedAt).toBe(250);
  });
  it('caps exponential backoff', () => {
    expect(backoffDelayMs(0, 1000, 60_000, () => 1)).toBe(1000);
    expect(backoffDelayMs(3, 1000, 60_000, () => 1)).toBe(8000);
    expect(backoffDelayMs(30, 1000, 60_000, () => 1)).toBe(60_000);
    expect(backoffDelayMs(30, 1000, 60_000, () => 0)).toBe(1000);
  });
});
