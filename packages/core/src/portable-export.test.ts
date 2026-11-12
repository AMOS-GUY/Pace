import { RecordingCoordinator, RecordingSession, sessionConfigFor } from '@pace/activity-engine';
import {
  ActivityRepository,
  type DatabaseContext,
  GoalRepository,
  SettingsRepository,
  SqliteRecordingStore,
  configureConnection,
  migrate,
} from '@pace/database';
import { bytesSource, parseGpx } from '@pace/formats';
import { haversineDistanceMeters } from '@pace/gps-engine';
import { strFromU8, unzipSync } from 'fflate';
import { FakeBridge } from '../../activity-engine/src/test-fixtures/fakes';
import { NodeSqliteDriver } from '../../database/src/test-fixtures/node-sqlite-driver';
import { garminTcx, withSensors } from '../../formats/src/test-fixtures/device-files';
import { straightTrack } from '../../gps-engine/src/test-fixtures/synthetic-track';
import {
  ActivityService,
  BulkImportService,
  EXPORTED_SETTINGS,
  PortableExportService,
  exportGpxName,
} from './index';

const DAY = 86_400_000;
const T = Date.UTC(2026, 2, 2, 6);
const SECRET = 'SECRET-TOKEN-should-never-leave-the-device';

async function freshDb(): Promise<{ ctx: DatabaseContext; clock: { t: number } }> {
  const db = new NodeSqliteDriver();
  await configureConnection(db);
  await migrate(db);
  const clock = { t: T };
  let n = 0;
  return {
    ctx: {
      db,
      now: () => clock.t,
      newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    },
    clock,
  };
}

const runLap1 = straightTrack({
  speedMps: 3.2,
  durationSeconds: 400,
  startTime: T,
  altitude: (t) => 5 + t / 20,
});
const runLap2 = straightTrack({
  speedMps: 3.3,
  durationSeconds: 400,
  startTime: T + 401_000,
  start: {
    latitude: runLap1[runLap1.length - 1]!.latitude,
    longitude: runLap1[runLap1.length - 1]!.longitude,
  },
});

/** A history like a real phone has: recorded ride with a pause, imported TCX run, pool swim, deleted run. */
async function populated(): Promise<{ ctx: DatabaseContext; ids: Record<string, string> }> {
  const { ctx, clock } = await freshDb();
  const ids: Record<string, string> = {};
  const [tcx] = await new ActivityService(ctx).importTcx(
    garminTcx({
      sport: 'Running',
      notes: 'Intervals',
      laps: [
        { tracks: [withSensors(runLap1, { hr: true, cadence: 86 })] },
        { tracks: [withSensors(runLap2, { hr: true, cadence: 90 })] },
      ],
    }),
    { timezone: 'Europe/Berlin' },
  );
  if (!tcx!.ok) throw tcx!.error;
  ids.run = tcx.result.activityId;

  const bridge = new FakeBridge();
  const store = new SqliteRecordingStore(ctx);
  clock.t = T + DAY;
  const coord = new RecordingCoordinator({
    bridge,
    store,
    clock: { now: () => clock.t },
    newId: ctx.newId,
    timezone: () => 'UTC',
    userId: () => null,
  });
  await coord.prepare('cycling');
  ids.ride = ((await coord.start()) as { activityId: string }).activityId;
  const first = straightTrack({ speedMps: 8, durationSeconds: 600, startTime: clock.t });
  bridge.emit(first);
  clock.t += 600_000;
  await coord.pause();
  clock.t += 120_000;
  await coord.resume();
  const last = first[first.length - 1]!;
  bridge.emit(
    straightTrack({
      speedMps: 8,
      durationSeconds: 600,
      startTime: clock.t + 1000,
      start: { latitude: last.latitude, longitude: last.longitude },
    }),
  );
  clock.t += 601_000;
  await coord.finish();
  coord.dispose();

  const swimCfg = sessionConfigFor(ctx.newId(), 'swimming', {
    swimMode: 'pool',
    poolLengthMeters: 25,
  });
  const swim = new RecordingSession(swimCfg);
  await store.createRecording({
    activity: {
      id: swimCfg.activityId,
      userId: null,
      sportType: 'swimming',
      title: 'Pool',
      startedAt: T + 2 * DAY,
      timezone: 'UTC',
      swimMode: 'pool',
      poolLengthMeters: 25,
    },
    config: swimCfg,
  });
  const evs = [
    ...swim.start(T + 2 * DAY),
    ...swim.lap(T + 2 * DAY + 300_000, 8),
    ...swim.finish(T + 2 * DAY + 310_000),
  ];
  await store.appendRecording(swimCfg.activityId, {
    samples: [],
    events: evs,
    status: 'recording',
    metrics: {
      elapsedDurationMs: 0,
      movingDurationMs: 0,
      distanceMeters: 0,
      elevationGainMeters: 0,
      elevationLossMeters: 0,
      averageSpeedMps: null,
      maximumSpeedMps: null,
      averagePaceMsPerKm: null,
    },
  });
  await store.completeRecording(swimCfg.activityId, swim.summary());
  ids.swim = swimCfg.activityId;

  const [gone] = await new ActivityService(ctx).importTcx(
    garminTcx({
      sport: 'Running',
      laps: [
        {
          tracks: [
            withSensors(
              straightTrack({ speedMps: 3, durationSeconds: 300, startTime: T + 3 * DAY }),
            ),
          ],
        },
      ],
    }),
    { timezone: 'UTC' },
  );
  if (!gone!.ok) throw gone!.error;
  await new ActivityRepository(ctx).softDelete(gone.result.activityId);
  ids.deleted = gone.result.activityId;

  await new GoalRepository(ctx).create({
    sportType: null,
    goalType: 'distance',
    targetValue: 30_000,
    period: 'week',
  });
  const settings = new SettingsRepository(ctx);
  await settings.set('profile', {
    displayName: 'Ada Runner',
    preferredSports: ['running'],
    heightCm: null,
    weightKg: null,
  });
  await settings.set('preferences', { measurementSystem: 'metric', exportPrivacyZoneMeters: 200 });
  // Things that must never be exported, even if some future code stores them in settings.
  await settings.set('sync.token', SECRET);
  await settings.set('auth.session', { accessToken: SECRET });
  return { ctx, ids };
}

async function exportZip(
  ctx: DatabaseContext,
  privacyZoneMeters: number,
): Promise<{
  files: Record<string, Uint8Array>;
  bytes: Uint8Array;
  chunks: number;
  summary: Awaited<ReturnType<PortableExportService['export']>>;
}> {
  const chunks: Uint8Array[] = [];
  const summary = await new PortableExportService(ctx).export(
    { write: async (c) => void chunks.push(c) },
    { privacyZoneMeters, appVersion: '0.1.0' },
  );
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.length;
  }
  return { files: unzipSync(bytes), bytes, chunks: chunks.length, summary };
}

describe('portable export', () => {
  it('writes one archive with README, JSON, CSVs and a GPX per tracked activity', async () => {
    const { ctx, ids } = await populated();
    const { files, bytes, chunks, summary } = await exportZip(ctx, 0);
    const names = Object.keys(files).sort();
    const run = (await new ActivityRepository(ctx).getById(ids.run!))!;
    const ride = (await new ActivityRepository(ctx).getById(ids.ride!))!;
    expect(names).toEqual(
      [
        'README.txt',
        'activities.csv',
        'data.json',
        'laps.csv',
        'personal_records.csv',
        'splits.csv',
        exportGpxName(run),
        exportGpxName(ride),
      ].sort(),
    );
    expect(summary).toMatchObject({
      activities: 3,
      gpxFiles: 2,
      withoutTrack: 1,
      bytes: bytes.length,
    });
    expect(summary.fileName).toBe(
      `pace-export-${new Date(ctx.now()).toISOString().slice(0, 10)}.zip`,
    );
    expect(chunks).toBeGreaterThan(1); // streamed, not one buffer

    const data = JSON.parse(strFromU8(files['data.json']!)) as {
      format: string;
      version: number;
      privacyZoneMeters: number;
      profile: { displayName: string };
      preferences: unknown;
      goals: unknown[];
      personalRecords: unknown[];
      activities: Array<
        Record<string, unknown> & {
          id: string;
          laps: unknown[];
          splits: unknown[];
          sensors: Record<string, { unit: string; samples: unknown[] }>;
        }
      >;
    };
    expect(data.format).toBe('pace-portable-export');
    expect(data.version).toBe(1);
    expect(data.profile.displayName).toBe('Ada Runner');
    expect(data.preferences).toBeTruthy();
    expect(data.goals).toHaveLength(1);
    expect(data.personalRecords.length).toBeGreaterThan(0);
    expect(data.activities.map((a) => a.id).sort()).toEqual([ids.run, ids.ride, ids.swim].sort());
    const jr = data.activities.find((a) => a.id === ids.run)!;
    expect(jr).toMatchObject({
      sportType: 'running',
      source: 'imported_tcx',
      description: 'Intervals',
      timezone: 'Europe/Berlin',
      distanceMeters: run.distanceMeters,
      movingDurationMs: run.movingDurationMs,
      elevationGainMeters: run.elevationGainMeters,
      gpxFile: exportGpxName(run),
    });
    expect(jr.laps).toHaveLength(2);
    expect(jr.splits.length).toBeGreaterThan(0);
    expect(jr.sensors.heart_rate!.samples).toHaveLength(runLap1.length + runLap2.length);
    expect(jr.sensors.cadence!.unit).toBe('rpm');
    const swim = data.activities.find((a) => a.id === ids.swim)!;
    expect(swim).toMatchObject({ swimMode: 'pool', poolLengthMeters: 25, gpxFile: null });
    const repo = new ActivityRepository(ctx);
    const dbLaps = {
      run: (await repo.laps(ids.run!)).length,
      ride: (await repo.laps(ids.ride!)).length,
      swim: (await repo.laps(ids.swim!)).length,
    };
    expect(dbLaps.swim).toBeGreaterThan(0);
    expect(swim.laps).toHaveLength(dbLaps.swim);
    expect(swim.laps[0]).toMatchObject({ poolLengthCount: 8, distanceMeters: 200 });

    const rows = (name: string) => strFromU8(files[name]!).split('\r\n').filter(Boolean).length - 1;
    expect(rows('activities.csv')).toBe(3);
    expect(rows('laps.csv')).toBe(dbLaps.run + dbLaps.ride + dbLaps.swim);
    expect(rows('personal_records.csv')).toBe(data.personalRecords.length);
  });

  it('never exports secrets, internal identifiers or coordinates outside GPX', async () => {
    const { ctx, ids } = await populated();
    const { files } = await exportZip(ctx, 0);
    for (const [name, content] of Object.entries(files)) {
      const text = strFromU8(content);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(ids.deleted!);
      if (name.endsWith('.gpx')) continue;
      expect(text).not.toMatch(/latitude|longitude|\blat\b|\blon\b|bounds|polyline/i);
      expect(text).not.toMatch(
        /userId|user_id|externalId|external_id|sessionConfig|session_config/,
      );
    }
    const data = JSON.parse(strFromU8(files['data.json']!)) as Record<string, unknown>;
    const topLevel = Object.keys(data).filter(
      (k) =>
        ![
          'format',
          'version',
          'exportedAt',
          'appVersion',
          'privacyZoneMeters',
          'units',
          'goals',
          'personalRecords',
          'activities',
        ].includes(k),
    );
    expect(topLevel.sort()).toEqual([...EXPORTED_SETTINGS].sort());
  });

  it('applies the privacy zone identically to every exported track', async () => {
    const { ctx } = await populated();
    const all = await new ActivityRepository(ctx).allCompleted();
    const zone = 300;
    const { files } = await exportZip(ctx, zone);
    const open = (await exportZip(ctx, 0)).files;
    let checked = 0;
    for (const a of all) {
      const name = exportGpxName(a);
      if (!files[name]) continue;
      const full = parseGpx(strFromU8(open[name]!)).segments.flat();
      const trimmed = parseGpx(strFromU8(files[name]!)).segments.flat();
      const start = full[0]!;
      const end = full[full.length - 1]!;
      expect(trimmed.length).toBeLessThan(full.length);
      for (const p of trimmed) {
        expect(haversineDistanceMeters(start, p)).toBeGreaterThanOrEqual(zone);
        expect(haversineDistanceMeters(end, p)).toBeGreaterThanOrEqual(zone);
      }
      checked++;
    }
    expect(checked).toBe(2);
    expect(strFromU8(files['README.txt']!)).toContain('trimmed by 300 m');
    expect(JSON.parse(strFromU8(files['data.json']!)).privacyZoneMeters).toBe(zone);
  });

  it('round-trips through import: same activities and metrics in a new database', async () => {
    const { ctx, ids } = await populated();
    const { bytes } = await exportZip(ctx, 0);
    const { ctx: fresh } = await freshDb();
    const report = await new BulkImportService(fresh).importFiles(
      [{ name: 'pace-export.zip', size: bytes.length, open: () => bytesSource(bytes, 4096) }],
      { timezone: 'UTC' },
    );
    expect(report.imported).toBe(2);
    expect(report.failed + report.duplicates + report.needsSport).toBe(0);
    // README, JSON and CSVs are not activities: counted as skipped, not failures.
    expect(report.skipped).toEqual({ count: 6, byExtension: { '.txt': 1, '.json': 1, '.csv': 4 } });

    const before = await new ActivityRepository(ctx).allCompleted();
    const after = await new ActivityRepository(fresh).allCompleted();
    const segmentsOf = async (c: DatabaseContext, id: string) =>
      (await c.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM recording_events WHERE activity_id = ? AND event_type IN ('started', 'resumed')",
        [id],
      ))!.n;
    for (const id of [ids.run!, ids.ride!]) {
      const a = before.find((x) => x.id === id)!;
      const b = after.find((x) => x.startedAt === a.startedAt)!;
      expect(b).toBeDefined();
      expect(b.title).toBe(a.title);
      expect(b.description).toBe(a.description);
      expect(b.sportType).toBe(a.sportType);
      expect(b.distanceMeters).toBeCloseTo(a.distanceMeters, 0);
      // GPX stores GPS points, not the moment Start/Resume/Finish was pressed, so each
      // segment can start up to one fix later and end up to one fix earlier (1 s fixes here).
      // An imported activity's segments already begin and end on fixes: exact.
      const bound = a.source === 'recorded' ? 2 * 1000 * (await segmentsOf(ctx, a.id)) : 0;
      expect(Math.abs(b.movingDurationMs - a.movingDurationMs)).toBeLessThanOrEqual(bound);
      expect(Math.abs(b.elapsedDurationMs - a.elapsedDurationMs)).toBeLessThanOrEqual(bound);
      expect(b.elevationGainMeters).toBeCloseTo(a.elevationGainMeters, 0);
      const sensors = async (c: DatabaseContext, activityId: string, type: string) =>
        (await c.db.get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM sensor_samples WHERE activity_id = ? AND sensor_type = ?',
          [activityId, type],
        ))!.n;
      expect(await sensors(fresh, b.id, 'heart_rate')).toBe(await sensors(ctx, a.id, 'heart_rate'));
      expect(await sensors(fresh, b.id, 'cadence')).toBe(await sensors(ctx, a.id, 'cadence'));
    }
    // Importing the export back into the original database adds nothing.
    const again = await new BulkImportService(ctx).importFiles(
      [{ name: 'pace-export.zip', open: () => bytesSource(bytes) }],
      { timezone: 'UTC' },
    );
    expect([again.imported, again.duplicates]).toEqual([0, 2]);
  });

  it('exports an empty history as a valid archive', async () => {
    const { ctx } = await freshDb();
    const { files, summary } = await exportZip(ctx, 0);
    expect(Object.keys(files).sort()).toEqual(
      [
        'README.txt',
        'activities.csv',
        'data.json',
        'laps.csv',
        'personal_records.csv',
        'splits.csv',
      ].sort(),
    );
    expect(summary).toMatchObject({ activities: 0, gpxFiles: 0 });
    expect(JSON.parse(strFromU8(files['data.json']!)).activities).toEqual([]);
  });
});
