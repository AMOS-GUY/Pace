import { destinationPoint } from '@pace/gps-engine';
import {
  ORIGIN,
  T0,
  driftTrack,
  straightTrack,
} from '../../gps-engine/src/test-fixtures/synthetic-track';
import {
  RecordingCoordinator,
  RecordingSession,
  type RecordingState,
  defaultTitle,
  replaySession,
  runScript,
  sessionConfigFor,
  transition,
} from './index';
import { FakeBridge, MemoryStore } from './test-fixtures/fakes';

describe('state machine', () => {
  const at = 1;
  it('follows the happy path', () => {
    let s: RecordingState = { status: 'READY' };
    const step = (e: Parameters<typeof transition>[1]): void => {
      const r = transition(s, e);
      expect(r.ok).toBe(true);
      s = r.state;
    };
    step({ type: 'START_REQUESTED', at, requiresGps: true });
    expect(s.status).toBe('ACQUIRING_GPS');
    step({ type: 'GPS_ACQUIRED' });
    step({ type: 'PAUSE', at });
    expect(s.status).toBe('PAUSED');
    step({ type: 'RESUME' });
    step({ type: 'FINISH' });
    expect(s.status).toBe('FINALIZING');
    step({ type: 'SAVE_SUCCEEDED' });
    expect(s.status).toBe('SAVED');
  });

  it('rejects invalid transitions without changing state', () => {
    const s: RecordingState = { status: 'READY' };
    const r = transition(s, { type: 'PAUSE', at });
    expect(r.ok).toBe(false);
    expect(r.state).toBe(s);
    expect(
      transition({ status: 'SAVED' }, { type: 'START_REQUESTED', at, requiresGps: true }).ok,
    ).toBe(false);
  });

  it('handles permission, unavailability, interruption and failure', () => {
    expect(transition({ status: 'READY' }, { type: 'PERMISSION_DENIED' }).state.status).toBe(
      'PERMISSION_DENIED',
    );
    expect(
      transition({ status: 'PERMISSION_DENIED' }, { type: 'PERMISSION_GRANTED', at }).state.status,
    ).toBe('ACQUIRING_GPS');
    expect(
      transition({ status: 'ACQUIRING_GPS', since: 0 }, { type: 'LOCATION_UNAVAILABLE', at }).state
        .status,
    ).toBe('LOCATION_UNAVAILABLE');
    expect(
      transition({ status: 'RECORDING', autoPaused: false }, { type: 'INTERRUPT', at }).state
        .status,
    ).toBe('INTERRUPTED');
    expect(transition({ status: 'FINALIZING' }, { type: 'SAVE_FAILED', error: 'x' }).state).toEqual(
      { status: 'FAILED', error: 'x', recoverable: true },
    );
    expect(
      transition({ status: 'FAILED', error: 'x', recoverable: true }, { type: 'RETRY_SAVE' }).state
        .status,
    ).toBe('FINALIZING');
    expect(
      transition({ status: 'RECOVERING' }, { type: 'RECOVERY_SUCCEEDED', resumeAs: 'PAUSED', at })
        .state.status,
    ).toBe('PAUSED');
  });

  it('does not allow double auto-pause', () => {
    expect(transition({ status: 'RECORDING', autoPaused: true }, { type: 'AUTO_PAUSE' }).ok).toBe(
      false,
    );
    expect(transition({ status: 'RECORDING', autoPaused: false }, { type: 'AUTO_RESUME' }).ok).toBe(
      false,
    );
  });
});

describe('RecordingSession', () => {
  it('records a run with correct elapsed vs moving time across a pause', () => {
    const a = straightTrack({ speedMps: 3, durationSeconds: 300 });
    const b = straightTrack({
      start: destinationPoint(a[a.length - 1]!, 90, 500), // moved 500 m while paused (e.g. walked home)
      startTime: T0 + 600_000,
      speedMps: 3,
      durationSeconds: 300,
    });
    const { session } = runScript(
      sessionConfigFor('a1', 'running'),
      [...a, ...b],
      [
        { atSample: a.length, command: 'pause' },
        { atSample: a.length, command: 'resume' },
      ],
    );
    const sum = session.summary();
    expect(sum.metrics.elapsedDurationMs).toBe(900_000);
    // Moving: 300 s + 300 s; the paused interval is excluded.
    expect(sum.metrics.movingDurationMs).toBe(600_000);
    // 900 m + 900 m; the 500 m covered while paused is not counted.
    expect(Math.abs(sum.metrics.distanceMeters - 1800)).toBeLessThan(15);
    expect(sum.route.segments).toHaveLength(2);
    expect(sum.metrics.averagePaceMsPerKm!).toBeCloseTo(
      600_000 / (sum.metrics.distanceMeters / 1000),
      6,
    );
    expect(sum.splits.length).toBe(2);
  });

  it('auto-pauses (backdated) and auto-resumes for cycling', () => {
    const ride1 = straightTrack({ speedMps: 8, durationSeconds: 120 });
    const stop = driftTrack({
      center: ride1[ride1.length - 1]!,
      startTime: T0 + 121_000,
      durationSeconds: 60,
      noiseMeters: 1,
      accuracyMeters: 5,
    });
    const ride2 = straightTrack({
      start: ride1[ride1.length - 1]!,
      startTime: T0 + 182_000,
      speedMps: 8,
      durationSeconds: 120,
    });
    const { session, events } = runScript(
      sessionConfigFor('c1', 'cycling', { autoPauseEnabled: true }),
      [...ride1, ...stop, ...ride2],
      [],
    );
    const types = events.map((e) => e.event.type);
    expect(types).toContain('auto_paused');
    expect(types).toContain('auto_resumed');
    const sum = session.summary();
    // Roughly 60 s stopped (minus speed-window lag) is excluded from moving time.
    expect(sum.metrics.elapsedDurationMs - sum.metrics.movingDurationMs).toBeGreaterThan(35_000);
    expect(sum.metrics.elapsedDurationMs - sum.metrics.movingDurationMs).toBeLessThan(65_000);
  });

  it('never auto-pauses on signal loss', () => {
    const a = straightTrack({ speedMps: 8, durationSeconds: 60 });
    const b = straightTrack({
      start: destinationPoint(a[a.length - 1]!, 90, 480),
      startTime: T0 + 120_000,
      speedMps: 8,
      durationSeconds: 60,
    });
    const { events, session } = runScript(
      sessionConfigFor('c2', 'cycling', { autoPauseEnabled: true }),
      [...a, ...b],
      [],
    );
    expect(events.some((e) => e.event.type === 'auto_paused')).toBe(false);
    expect(session.summary().route.gaps).toHaveLength(1);
  });

  it('records manual laps', () => {
    const t = straightTrack({ speedMps: 4, durationSeconds: 500 });
    const { session } = runScript(sessionConfigFor('l1', 'running'), t, [
      { atSample: 251, command: 'lap' },
    ]);
    const laps = session.summary().laps;
    expect(laps).toHaveLength(2);
    expect(laps[0]!.durationMs).toBe(250_000);
    expect(Math.abs(laps[0]!.distanceMeters - 1000)).toBeLessThan(10);
  });

  it('records a pool swim from manual laps without GPS', () => {
    const cfg = sessionConfigFor('s1', 'swimming', { swimMode: 'pool', poolLengthMeters: 25 });
    const s = new RecordingSession(cfg);
    expect(s.requiresGps).toBe(false);
    s.start(T0);
    s.lap(T0 + 120_000, 4);
    s.lap(T0 + 250_000, 4);
    s.finish(T0 + 260_000);
    const sum = s.summary();
    expect(sum.metrics.distanceMeters).toBe(200);
    expect(sum.laps.map((l) => l.lengthCount)).toEqual([4, 4]);
    expect(sum.laps[0]!.distanceMeters).toBe(100);
    expect(() => sessionConfigFor('s2', 'swimming', { swimMode: 'pool' })).toThrow();
  });

  it('records a triathlon as one parent with ordered legs and transitions', () => {
    const cfg = sessionConfigFor('t1', 'triathlon');
    const s = new RecordingSession(cfg);
    s.start(T0, { withoutFix: true });
    const swim = straightTrack({ speedMps: 1, durationSeconds: 600, accuracyMeters: 10 });
    swim.forEach((x) => s.ingestSample(x));
    s.advanceLeg(T0 + 601_000); // T1
    s.advanceLeg(T0 + 700_000); // bike
    const bike = straightTrack({
      start: ORIGIN,
      startTime: T0 + 700_000,
      speedMps: 9,
      durationSeconds: 1200,
    });
    bike.forEach((x) => s.ingestSample(x));
    s.advanceLeg(T0 + 1_901_000); // T2
    s.advanceLeg(T0 + 1_960_000); // run
    const run = straightTrack({
      start: ORIGIN,
      startTime: T0 + 1_960_000,
      speedMps: 3.5,
      durationSeconds: 1200,
    });
    run.forEach((x) => s.ingestSample(x));
    expect(() => s.advanceLeg(T0 + 3_200_000)).toThrow('final leg');
    s.finish(T0 + 3_161_000);
    const sum = s.summary();
    expect(sum.legs.map((l) => l.segmentType)).toEqual([
      'swim',
      'transition_1',
      'bike',
      'transition_2',
      'run',
    ]);
    expect(sum.legs[1]!.elapsedDurationMs).toBe(99_000);
    expect(sum.legs[3]!.elapsedDurationMs).toBe(59_000);
    const legSum = sum.legs.reduce((a, l) => a + l.distanceMeters, 0);
    expect(sum.metrics.distanceMeters).toBeCloseTo(legSum, 6);
    expect(Math.abs(sum.legs[2]!.distanceMeters - 10_800) / 10_800).toBeLessThan(0.01);
    expect(sum.metrics.elapsedDurationMs).toBe(3_161_000);
  });

  it('replays to an identical result (deterministic replay)', () => {
    const t = straightTrack({ speedMps: 3.2, durationSeconds: 900, noiseMeters: 3, seed: 3 });
    const cfg = sessionConfigFor('r1', 'running', { autoPauseEnabled: true });
    const { session, events } = runScript(cfg, t, [
      { atSample: 300, command: 'pause' },
      { atSample: 300, command: 'resume' },
      { atSample: 500, command: 'lap' },
    ]);
    const replayed = replaySession(cfg, events, t);
    expect(replayed.summary()).toEqual(session.summary());
  });

  it('rejects a replay whose samples are missing', () => {
    const t = straightTrack({ speedMps: 3, durationSeconds: 100 });
    const cfg = sessionConfigFor('r2', 'running');
    const { events } = runScript(cfg, t, []);
    expect(() => replaySession(cfg, events, t.slice(0, 10))).toThrow('missing samples');
  });

  it('counts samples recorded before pause but delivered after it', () => {
    const cfg = sessionConfigFor('d1', 'running');
    const s = new RecordingSession(cfg);
    const t = straightTrack({ speedMps: 3, durationSeconds: 100 });
    s.start(T0);
    t.slice(0, 90).forEach((x) => s.ingestSample(x));
    s.pause(T0 + 100_000);
    t.slice(90).forEach((x) => s.ingestSample(x)); // late batch, recorded before pause time
    s.finish(T0 + 100_000);
    expect(Math.abs(s.summary().metrics.distanceMeters - 300)).toBeLessThan(6);
  });
});

describe('RecordingCoordinator', () => {
  function setup(): {
    bridge: FakeBridge;
    store: MemoryStore;
    clock: { t: number; now(): number };
    coordinator: RecordingCoordinator;
  } {
    const bridge = new FakeBridge();
    const store = new MemoryStore();
    const clock = {
      t: T0,
      now() {
        return this.t;
      },
    };
    let n = 0;
    const coordinator = new RecordingCoordinator({
      bridge,
      store,
      clock,
      newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
      timezone: () => 'UTC',
      userId: () => 'user-1',
    });
    return { bridge, store, clock, coordinator };
  }
  const flush = (c: RecordingCoordinator): Promise<unknown> =>
    c.snapshot() ? (c as unknown as { queue: Promise<unknown> }).queue : Promise.resolve();

  it('records, persists incrementally, acknowledges, and saves', async () => {
    const { bridge, store, clock, coordinator } = setup();
    await coordinator.prepare('running');
    const started = await coordinator.start();
    expect(started.ok).toBe(true);
    const id = (started as { activityId: string }).activityId;
    expect(await coordinator.start()).toEqual({ ok: false, reason: 'already_recording' });

    const t = straightTrack({ speedMps: 3, durationSeconds: 120 });
    bridge.emit(t.slice(0, 60));
    await flush(coordinator);
    expect(store.recordings.get(id)!.samples).toHaveLength(60);
    expect(bridge.acknowledged.get(id)).toBe(59);

    bridge.emit(t.slice(60));
    clock.t = T0 + 120_000;
    const summary = await coordinator.finish();
    expect(store.recordings.get(id)!.samples).toHaveLength(121);
    expect(summary.metrics.distanceMeters).toBeGreaterThan(350);
    expect(coordinator.snapshot()!.state.status).toBe('SAVED');
    expect(bridge.recordingId).toBeNull();
  });

  it('reports permission denial', async () => {
    const { bridge, coordinator } = setup();
    bridge.authorization = 'denied';
    expect(await coordinator.prepare('running')).toEqual({
      ok: false,
      reason: 'permission_denied',
    });
    expect(coordinator.snapshot()!.state.status).toBe('PERMISSION_DENIED');
  });

  it('drains un-notified journal entries before control events (no lost samples)', async () => {
    const { bridge, store, clock, coordinator } = setup();
    await coordinator.prepare('running');
    const { activityId } = (await coordinator.start()) as { activityId: string };
    const t = straightTrack({ speedMps: 3, durationSeconds: 30 });
    bridge.emit(t, { notify: false }); // JS was suspended; native kept journaling
    clock.t = T0 + 31_000;
    await coordinator.pause();
    const rec = store.recordings.get(activityId)!;
    expect(rec.samples).toHaveLength(31);
    expect(rec.events.find((e) => e.event.type === 'paused')!.afterSampleCount).toBe(31);
  });

  it('recovers after an app crash and keeps native-captured samples', async () => {
    const first = setup();
    await first.coordinator.prepare('running');
    const { activityId } = (await first.coordinator.start()) as { activityId: string };
    const t = straightTrack({ speedMps: 3, durationSeconds: 200 });
    first.bridge.emit(t.slice(0, 100));
    await flush(first.coordinator);
    // App process dies. Native continues journaling while JS is dead.
    first.bridge.emit(t.slice(100), { notify: false });

    const revived = new RecordingCoordinator({
      bridge: first.bridge,
      store: first.store,
      clock: { now: () => T0 + 201_000 },
      newId: () => 'unused',
      timezone: () => 'UTC',
      userId: () => 'user-1',
    });
    const r = await revived.recover();
    expect(r).toEqual({ recovered: true, activityId, status: 'RECORDING' });
    expect(first.store.recordings.get(activityId)!.samples).toHaveLength(201);
    const summary = await revived.finish();
    expect(Math.abs(summary.metrics.distanceMeters - 600)).toBeLessThan(10);
  });

  it('marks a recovered session INTERRUPTED when native stopped recording', async () => {
    const first = setup();
    await first.coordinator.prepare('walking');
    const { activityId } = (await first.coordinator.start()) as { activityId: string };
    first.bridge.emit(straightTrack({ speedMps: 1.4, durationSeconds: 60 }));
    await flush(first.coordinator);
    first.bridge.recordingId = null; // OS terminated everything (e.g. device restart)
    const revived = new RecordingCoordinator({
      bridge: first.bridge,
      store: first.store,
      clock: { now: () => T0 + 3_600_000 },
      newId: () => 'x',
      timezone: () => 'UTC',
      userId: () => null,
    });
    const r = await revived.recover();
    expect(r).toMatchObject({ recovered: true, activityId, status: 'INTERRUPTED' });
    // Moving time stops at the last known data, not at recovery time.
    expect(revived.snapshot()!.movingMs).toBe(60_000);
  });

  it('retries a failed batch persist without losing samples', async () => {
    const { bridge, store, coordinator } = setup();
    await coordinator.prepare('running');
    const { activityId } = (await coordinator.start()) as { activityId: string };
    const t = straightTrack({ speedMps: 3, durationSeconds: 20 });
    store.failNextAppend = true;
    bridge.emit(t.slice(0, 10));
    await flush(coordinator);
    expect(store.recordings.get(activityId)!.samples).toHaveLength(0);
    expect(bridge.acknowledged.get(activityId)).toBeUndefined();
    bridge.emit(t.slice(10));
    await flush(coordinator);
    expect(store.recordings.get(activityId)!.samples).toHaveLength(21);
  });

  it('surfaces a failed final save and allows retry', async () => {
    const { bridge, store, coordinator } = setup();
    await coordinator.prepare('running');
    await coordinator.start();
    bridge.emit(straightTrack({ speedMps: 3, durationSeconds: 20 }));
    store.failNextComplete = true;
    await expect(coordinator.finish()).rejects.toThrow('write failed');
    expect(coordinator.snapshot()!.state.status).toBe('FAILED');
    await coordinator.retrySave();
    expect(coordinator.snapshot()!.state.status).toBe('SAVED');
  });

  it('discards on explicit user request', async () => {
    const { store, coordinator } = setup();
    await coordinator.prepare('hiking');
    const { activityId } = (await coordinator.start()) as { activityId: string };
    await coordinator.discard();
    expect(store.recordings.get(activityId)!.discardedAt).not.toBeNull();
    expect(coordinator.snapshot()).toBeNull();
  });
});

describe('defaultTitle', () => {
  it('names activities by local time of day', () => {
    expect(defaultTitle('running', Date.UTC(2026, 0, 1, 7), 'UTC')).toBe('Morning Run');
    expect(defaultTitle('cycling', Date.UTC(2026, 0, 1, 7), 'America/New_York')).toBe('Night Ride');
  });
});
