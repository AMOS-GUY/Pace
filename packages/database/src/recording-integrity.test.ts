/**
 * Data-integrity suite for the native → JavaScript → SQLite pipeline.
 *
 * Uses the real SQLite recording store and a bridge double that follows the Swift recorder
 * contract (journal before notify, persisted sequence high-water mark, nextSequence on start).
 * The core invariant checked throughout: stored raw samples are exactly the journal's samples,
 * contiguous from sequence 0, with nothing lost and nothing duplicated.
 */
import { RecordingCoordinator } from '@pace/activity-engine';
import type { LocationSample } from '@pace/domain';
import { destinationPoint } from '@pace/gps-engine';
import { FakeBridge } from '../../activity-engine/src/test-fixtures/fakes';
import { T0, straightTrack } from '../../gps-engine/src/test-fixtures/synthetic-track';
import {
  ActivityRepository,
  type DatabaseContext,
  ROUTE_POINT_COLUMNS,
  SqliteRecordingStore,
  configureConnection,
  insertMany,
  migrate,
  sampleValues,
} from './index';
import { NodeSqliteDriver } from './test-fixtures/node-sqlite-driver';

interface Harness {
  ctx: DatabaseContext;
  db: NodeSqliteDriver;
  clock: { t: number };
  bridge: FakeBridge;
  store: SqliteRecordingStore;
  coordinator: () => RecordingCoordinator;
  errors: unknown[];
}

async function harness(): Promise<Harness> {
  const db = new NodeSqliteDriver();
  await configureConnection(db);
  await migrate(db);
  const clock = { t: T0 };
  let n = 0;
  const ctx: DatabaseContext = {
    db,
    now: () => clock.t,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  };
  const bridge = new FakeBridge();
  const store = new SqliteRecordingStore(ctx);
  const errors: unknown[] = [];
  return {
    ctx,
    db,
    clock,
    bridge,
    store,
    errors,
    coordinator: () =>
      new RecordingCoordinator({
        bridge,
        store,
        clock: { now: () => clock.t },
        newId: ctx.newId,
        timezone: () => 'UTC',
        userId: () => null,
        onError: (e) => errors.push(e),
      }),
  };
}

/** Waits for the coordinator's serial queue (listener-triggered work) to settle. */
const settle = (c: RecordingCoordinator): Promise<unknown> =>
  (c as unknown as { queue: Promise<unknown> }).queue;

async function storedSequences(h: Harness, id: string): Promise<number[]> {
  return (
    await h.db.all<{ s: number }>(
      'SELECT sequence_number AS s FROM route_points WHERE activity_id = ? ORDER BY sequence_number',
      [id],
    )
  ).map((r) => r.s);
}

function expectContiguous(seqs: number[], count: number): void {
  expect(seqs).toEqual(Array.from({ length: count }, (_, i) => i));
}

async function startRun(h: Harness): Promise<{ c: RecordingCoordinator; id: string }> {
  const c = h.coordinator();
  await c.prepare('running');
  const r = await c.start();
  if (!r.ok) throw new Error('start failed');
  return { c, id: r.activityId };
}

const track = (
  seconds: number,
  startTime = T0,
  start?: { latitude: number; longitude: number },
): LocationSample[] =>
  straightTrack({ speedMps: 3, durationSeconds: seconds, startTime, ...(start ? { start } : {}) });

describe('native → JS sample delivery', () => {
  it('stores duplicated deliveries exactly once', async () => {
    const h = await harness();
    const { c, id } = await startRun(h);
    const entries = h.bridge.emit(track(20));
    h.bridge.deliver(id, entries);
    h.bridge.deliver(id, entries.slice(5, 10));
    await settle(c);
    expectContiguous(await storedSequences(h, id), 21);
  });

  it('recovers from out-of-order batches by re-reading the journal', async () => {
    const h = await harness();
    const { c, id } = await startRun(h);
    const t = track(30);
    const first = h.bridge.emit(t.slice(0, 10), { notify: false });
    const second = h.bridge.emit(t.slice(10), { notify: false });
    h.bridge.deliver(id, second); // later batch arrives first
    h.bridge.deliver(id, first);
    await settle(c);
    expectContiguous(await storedSequences(h, id), 31);
    expect(h.errors).toEqual([]);
  });

  it('never counts an acquisition fix delivered after recording started', async () => {
    const h = await harness();
    const c = h.coordinator();
    await c.prepare('running');
    const { activityId: id } = (await c.start()) as { activityId: string };
    // An acquisition-only fix queued before start is delivered late.
    h.bridge.emitAcquisition(track(1));
    await settle(c);
    h.bridge.emit(track(10, T0 + 1000));
    await settle(c);
    expectContiguous(await storedSequences(h, id), 11);
    h.clock.t = T0 + 12_000;
    const summary = await c.finish();
    expect(summary.quality.acceptedSamples).toBe(11);
  });

  it('persists every sample when JS missed all events (suspended runtime)', async () => {
    const h = await harness();
    const { c, id } = await startRun(h);
    h.bridge.emit(track(600), { notify: false });
    h.clock.t = T0 + 600_000;
    await c.finish();
    expectContiguous(await storedSequences(h, id), 601);
    expect(h.bridge.deletedJournals).toContain(id);
  });

  it('acknowledges only what is durably stored', async () => {
    const h = await harness();
    const { c, id } = await startRun(h);
    h.bridge.emit(track(9));
    await settle(c);
    expect(h.bridge.acknowledged.get(id)).toBe(9);
    expect((await storedSequences(h, id)).at(-1)).toBe(9);
  });
});

describe('lifecycle integrity', () => {
  it('discards nothing on finish: samples captured up to the tap are stored, the journal removed afterwards', async () => {
    const h = await harness();
    const { c, id } = await startRun(h);
    h.bridge.emit(track(120).slice(0, 100));
    await settle(c);
    h.bridge.emit(track(120).slice(100), { notify: false }); // captured, not yet delivered
    h.clock.t = T0 + 121_000;
    const summary = await c.finish();
    expectContiguous(await storedSequences(h, id), 121);
    expect(h.bridge.recordingId).toBeNull();
    expect(h.bridge.journal.has(id)).toBe(false);
    expect(summary.metrics.distanceMeters).toBeCloseTo(360, 0);
  });

  it('keeps raw samples recorded while paused but excludes them from distance and time', async () => {
    const h = await harness();
    const { c, id } = await startRun(h);
    const before = track(60);
    h.bridge.emit(before);
    h.clock.t = T0 + 60_000;
    await c.pause();
    // While paused the athlete walks 300 m with GPS still on.
    const walk = straightTrack({
      speedMps: 1.5,
      durationSeconds: 200,
      startTime: T0 + 61_000,
      start: before.at(-1)!,
    });
    h.bridge.emit(walk);
    await settle(c);
    h.clock.t = T0 + 262_000;
    await c.resume();
    // A fix taken just before resume but delivered after it must not start the new segment.
    const resumeFrom = walk.at(-1)!;
    const after = straightTrack({
      speedMps: 3,
      durationSeconds: 60,
      startTime: T0 + 262_000,
      start: resumeFrom,
    });
    h.bridge.emit([{ ...resumeFrom, recordedAt: T0 + 261_500 }, ...after]);
    h.clock.t = T0 + 322_000;
    const summary = await c.finish();
    expectContiguous(await storedSequences(h, id), before.length + walk.length + 1 + after.length);
    expect(summary.metrics.movingDurationMs).toBe(120_000);
    expect(summary.metrics.distanceMeters).toBeCloseTo(360, 0);
  });

  it('removes all raw data on an explicit discard', async () => {
    const h = await harness();
    const { c, id } = await startRun(h);
    h.bridge.emit(track(30));
    await settle(c);
    await c.discard();
    expect(await storedSequences(h, id)).toEqual([]);
    expect(h.bridge.journal.has(id)).toBe(false);
    expect((await new ActivityRepository(h.ctx).getById(id))!.status).toBe('discarded');
  });

  it('leaves no orphan activity when native cannot start recording', async () => {
    const h = await harness();
    const c = h.coordinator();
    await c.prepare('running');
    h.bridge.failNextStartRecording = true;
    await expect(c.start()).rejects.toThrow('Could not open journal');
    expect(await h.store.findIncompleteRecordingId()).toBeNull();
    // The prepared session can be started again.
    const retry = await c.start();
    expect(retry.ok).toBe(true);
  });
});

describe('recovery', () => {
  it('continues seamlessly after a JS reload while native keeps recording', async () => {
    const h = await harness();
    const { c, id } = await startRun(h);
    h.bridge.emit(track(120).slice(0, 60));
    await settle(c);
    c.dispose(); // JS runtime reloaded; native recorder (process singleton) continues
    h.bridge.emit(track(120).slice(60), { notify: false });
    h.clock.t = T0 + 120_000;
    const revived = h.coordinator();
    expect(await revived.recover()).toEqual({
      recovered: true,
      activityId: id,
      status: 'RECORDING',
    });
    const summary = await revived.finish();
    expectContiguous(await storedSequences(h, id), 121);
    expect(summary.metrics.movingDurationMs).toBe(120_000);
  });

  it('stops the moving clock at the last captured sample after a force-quit', async () => {
    const h = await harness();
    const { c, id } = await startRun(h);
    const t = track(300);
    h.bridge.emit(t.slice(0, 100));
    await settle(c);
    // Journal captured more before the process died, but JS never saw it.
    h.bridge.emit(t.slice(100, 200), { notify: false });
    c.dispose();
    h.bridge.recordingId = null; // process killed: CLLocationManager gone
    h.clock.t = T0 + 3 * 3_600_000; // relaunched hours later
    const revived = h.coordinator();
    expect(await revived.recover()).toMatchObject({ recovered: true, status: 'INTERRUPTED' });
    expectContiguous(await storedSequences(h, id), 200);
    // Moving time ends at the newest drained sample (199 s), not at relaunch time.
    expect(revived.snapshot()!.movingMs).toBe(199_000);
  });

  it('never reuses sequence numbers after resuming, even if the native journal was lost', async () => {
    const h = await harness();
    const { c, id } = await startRun(h);
    h.bridge.emit(track(50));
    await settle(c);
    c.dispose();
    h.bridge.recordingId = null;
    h.bridge.loseJournal(id);
    h.clock.t = T0 + 600_000;
    const revived = h.coordinator();
    await revived.recover();
    await revived.resumeInterrupted();
    h.bridge.emit(track(30, T0 + 600_000, destinationPoint(track(50).at(-1)!, 90, 10)));
    await settle(revived);
    expectContiguous(await storedSequences(h, id), 51 + 31);
  });

  it('completes a save that was interrupted after "finished" was persisted', async () => {
    const h = await harness();
    const { c, id } = await startRun(h);
    h.bridge.emit(track(60));
    await settle(c);
    // Simulate a crash between persisting the finish event and saving the summary.
    const original = h.store.completeRecording.bind(h.store);
    h.store.completeRecording = async () => {
      throw new Error('process killed');
    };
    h.clock.t = T0 + 61_000;
    await expect(c.finish()).rejects.toThrow('process killed');
    h.store.completeRecording = original;
    const revived = h.coordinator();
    expect(await revived.recover()).toEqual({ recovered: true, activityId: id, status: 'SAVED' });
    const a = (await new ActivityRepository(h.ctx).getById(id))!;
    expect(a.status).toBe('completed');
    expect(a.distanceMeters).toBeCloseTo(180, 0);
  });

  it('recovers persisted data even when the native module is unavailable', async () => {
    const h = await harness();
    const { c, id } = await startRun(h);
    h.bridge.emit(track(40));
    await settle(c);
    c.dispose();
    h.bridge.failReads = true;
    h.bridge.recordingId = null;
    h.clock.t = T0 + 3_600_000;
    const revived = h.coordinator();
    expect(await revived.recover()).toMatchObject({
      recovered: true,
      activityId: id,
      status: 'INTERRUPTED',
    });
    expect(h.errors.length).toBeGreaterThan(0);
    expect(revived.snapshot()!.movingMs).toBe(40_000);
  });
});

describe('SQLite transaction safety', () => {
  it('rolls back a whole batch when any row fails (no partial writes)', async () => {
    const h = await harness();
    const { c, id } = await startRun(h);
    await settle(c);
    const good = track(5).map((s, i) => sampleValues(id, i, s));
    const bad = [...good, [id, 5, null, 0, null, 5, null, null, null, T0, 'replay']];
    await expect(
      h.db.transaction((tx) => insertMany(tx, 'route_points', ROUTE_POINT_COLUMNS, bad)),
    ).rejects.toThrow(/NOT NULL/);
    expect(await storedSequences(h, id)).toEqual([]);
  });

  it('keeps samples and events consistent when a batch write fails and is retried', async () => {
    const h = await harness();
    const { c, id } = await startRun(h);
    const original = h.store.appendRecording.bind(h.store);
    let fail = true;
    h.store.appendRecording = async (...args) => {
      if (fail) {
        fail = false;
        throw new Error('disk I/O error');
      }
      return original(...args);
    };
    h.bridge.emit(track(30).slice(0, 15));
    await settle(c);
    expect(h.bridge.acknowledged.get(id)).toBeUndefined(); // nothing acknowledged on failure
    h.clock.t = T0 + 15_000;
    await c.pause(); // succeeds and carries the retained batch
    const events = await h.db.all<{ t: string; n: number }>(
      'SELECT event_type AS t, after_sample_count AS n FROM recording_events WHERE activity_id = ? ORDER BY sequence_number',
      [id],
    );
    expect(events).toEqual([
      { t: 'started', n: 0 },
      { t: 'paused', n: 15 },
    ]);
    expectContiguous(await storedSequences(h, id), 15);
  });
});
