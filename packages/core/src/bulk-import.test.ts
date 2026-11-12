import { type DatabaseContext, configureConnection, migrate } from '@pace/database';
import { bytesSource } from '@pace/formats';
import { gzipSync, strToU8, zipSync } from 'fflate';
import { NodeSqliteDriver } from '../../database/src/test-fixtures/node-sqlite-driver';
import { garminTcx, stravaGpx, withSensors } from '../../formats/src/test-fixtures/device-files';
import { straightTrack } from '../../gps-engine/src/test-fixtures/synthetic-track';
import { type BulkImportProgress, BulkImportService, type ImportSourceFile } from './index';

const DAY = 86_400_000;
const T = Date.UTC(2026, 0, 5, 7);

async function freshDb(): Promise<DatabaseContext> {
  const db = new NodeSqliteDriver();
  await configureConnection(db);
  await migrate(db);
  let n = 0;
  return {
    db,
    now: () => T,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  };
}

/** A run on day `d` (one activity per day so sessions never overlap). */
const run = (d: number, seconds = 600) =>
  straightTrack({ speedMps: 3.1, durationSeconds: seconds, startTime: T + d * DAY });
const gpxRun = (d: number, seconds?: number) =>
  stravaGpx({
    name: `Run ${d}`,
    type: 'running',
    points: withSensors(run(d, seconds), { hr: true }),
  });

const file = (name: string, bytes: Uint8Array, chunk = 64 * 1024): ImportSourceFile => ({
  name,
  size: bytes.length,
  open: () => bytesSource(bytes, chunk),
});

async function count(ctx: DatabaseContext, sql: string): Promise<number> {
  return (await ctx.db.get<{ n: number }>(sql))!.n;
}

const mixedArchive = zipSync({
  'export/activities/1.gpx': strToU8(gpxRun(1)),
  'export/activities/2.tcx.gz': gzipSync(
    strToU8(
      garminTcx({
        sport: 'Biking',
        laps: [
          {
            tracks: [
              withSensors(
                straightTrack({ speedMps: 8, durationSeconds: 900, startTime: T + 2 * DAY }),
                { watts: 200 },
              ),
            ],
          },
        ],
        extraActivities: [{ sport: 'Other', laps: [{ tracks: [withSensors(run(3))] }] }],
      }),
    ),
  ),
  // The same run exported twice under different names.
  'export/activities/4.gpx': strToU8(gpxRun(4)),
  'export/activities/4-copy.gpx': strToU8(gpxRun(4)),
  'export/activities/5.gpx': strToU8('<gpx><trk><trkseg></trkseg></trk></gpx>'),
  'export/activities/6.fit.gz': new Uint8Array([1, 2, 3]),
  'export/media/p1.jpg': new Uint8Array(100),
  'export/media/p2.jpg': new Uint8Array(100),
  'export/activities.csv': strToU8('id\n1'),
  '../outside.gpx': strToU8(gpxRun(7)),
});

describe('bulk import', () => {
  it('imports a mixed archive file by file and reports every outcome', async () => {
    const ctx = await freshDb();
    const report = await new BulkImportService(ctx).importFiles(
      [file('export.zip', mixedArchive)],
      {
        timezone: 'Europe/Zurich',
      },
    );
    const by = Object.fromEntries(report.outcomes.map((o) => [o.entry, o.status]));
    expect(by).toEqual({
      'export/activities/1.gpx': 'imported',
      'export/activities/2.tcx.gz#1': 'imported',
      'export/activities/2.tcx.gz#2': 'needs_sport',
      'export/activities/4.gpx': 'imported',
      'export/activities/4-copy.gpx': 'duplicate',
      'export/activities/5.gpx': 'failed',
      'export/activities/6.fit.gz': 'failed',
      '../outside.gpx': 'failed',
    });
    expect([report.imported, report.duplicates, report.needsSport, report.failed]).toEqual([
      3, 1, 1, 3,
    ]);
    expect(report.skipped).toEqual({ count: 3, byExtension: { '.jpg': 2, '.csv': 1 } });
    expect(report.sourceErrors).toEqual([]);
    expect(report.cancelled).toBe(false);
    const dup = report.outcomes.find((o) => o.status === 'duplicate')!;
    const original = report.outcomes.find((o) => o.entry === 'export/activities/4.gpx')!;
    expect(dup.existingActivityId).toBe(original.activityId);
    for (const o of report.outcomes.filter((x) => x.status !== 'imported'))
      expect(o.message).toBeTruthy();
    expect(report.outcomes.find((o) => o.entry === 'export/activities/5.gpx')!.message).toMatch(
      /fewer than two/,
    );
    expect(
      await count(ctx, "SELECT COUNT(*) AS n FROM activities WHERE status = 'completed'"),
    ).toBe(3);
    expect(
      await count(ctx, "SELECT COUNT(*) AS n FROM activities WHERE source = 'imported_tcx'"),
    ).toBe(1);
    expect(
      await count(ctx, "SELECT COUNT(*) AS n FROM sensor_samples WHERE sensor_type = 'power'"),
    ).toBeGreaterThan(0);
  });

  it('is safe to repeat: a second import of the same archive adds nothing', async () => {
    const ctx = await freshDb();
    const svc = new BulkImportService(ctx);
    await svc.importFiles([file('export.zip', mixedArchive)], { timezone: 'UTC' });
    const before = await count(ctx, 'SELECT COUNT(*) AS n FROM activities');
    const pointsBefore = await count(ctx, 'SELECT COUNT(*) AS n FROM route_points');
    const sensorsBefore = await count(ctx, 'SELECT COUNT(*) AS n FROM sensor_samples');
    const again = await svc.importFiles([file('export.zip', mixedArchive)], { timezone: 'UTC' });
    expect(again.imported).toBe(0);
    expect(again.duplicates).toBe(4);
    expect(await count(ctx, 'SELECT COUNT(*) AS n FROM activities')).toBe(before);
    expect(await count(ctx, 'SELECT COUNT(*) AS n FROM route_points')).toBe(pointsBefore);
    expect(await count(ctx, 'SELECT COUNT(*) AS n FROM sensor_samples')).toBe(sensorsBefore);
  });

  it('applies the fallback sport only to files without a sport', async () => {
    const ctx = await freshDb();
    const report = await new BulkImportService(ctx).importFiles(
      [file('export.zip', mixedArchive)],
      {
        timezone: 'UTC',
        fallbackSportType: 'walking',
      },
    );
    expect(report.needsSport).toBe(0);
    expect(report.imported).toBe(4);
    const sports = await ctx.db.all<{ sport_type: string; n: number }>(
      'SELECT sport_type, COUNT(*) AS n FROM activities GROUP BY sport_type ORDER BY sport_type',
    );
    // The bike file keeps its own sport; only the "Other" activity becomes a walk.
    expect(sports).toEqual([
      { sport_type: 'cycling', n: 1 },
      { sport_type: 'running', n: 2 },
      { sport_type: 'walking', n: 1 },
    ]);
  });

  it('imports several picked files of different kinds', async () => {
    const ctx = await freshDb();
    const report = await new BulkImportService(ctx).importFiles(
      [
        file('a.gpx', strToU8(gpxRun(10))),
        file('b.gpx.gz', gzipSync(strToU8(gpxRun(11)))),
        file(
          'c.tcx',
          strToU8(garminTcx({ sport: 'Running', laps: [{ tracks: [withSensors(run(12))] }] })),
        ),
        file('notes.txt', strToU8('not an activity')),
      ],
      { timezone: 'UTC' },
    );
    expect(report.outcomes.map((o) => [o.file, o.status])).toEqual([
      ['a.gpx', 'imported'],
      ['b.gpx.gz', 'imported'],
      ['c.tcx', 'imported'],
      ['notes.txt', 'failed'],
    ]);
  });

  it('handles a large archive and keeps every metric per activity', async () => {
    const ctx = await freshDb();
    const N = 250;
    const zip = zipSync(
      Object.fromEntries(
        Array.from({ length: N }, (_, d) => [`a/${d}.gpx`, strToU8(gpxRun(d, 120))]),
      ),
    );
    const started = Date.now();
    const report = await new BulkImportService(ctx).importFiles([file('big.zip', zip)], {
      timezone: 'UTC',
    });
    const elapsed = Date.now() - started;
    expect(report.imported).toBe(N);
    expect(report.failed + report.duplicates).toBe(0);
    expect(
      await count(ctx, "SELECT COUNT(*) AS n FROM activities WHERE status = 'completed'"),
    ).toBe(N);
    expect(await count(ctx, 'SELECT COUNT(*) AS n FROM route_points')).toBe(N * 121);
    const d = await ctx.db.all<{ distance_meters: number; moving_duration_ms: number }>(
      'SELECT distance_meters, moving_duration_ms FROM activities',
    );
    // 120 s at 3.1 m/s: the engine reports the same distance for every identical run.
    for (const r of d) {
      expect(r.distance_meters).toBeCloseTo(d[0]!.distance_meters, 6);
      expect(r.distance_meters).toBeGreaterThan(350);
      expect(r.distance_meters).toBeLessThan(380);
    }
    // Generous guard against pathological slowness (node:sqlite on CI-class hardware).
    expect(elapsed).toBeLessThan(60_000);
  });

  it('keeps what was imported when an archive is truncated, and completes on retry', async () => {
    const ctx = await freshDb();
    const svc = new BulkImportService(ctx);
    const zip = zipSync(
      Object.fromEntries(Array.from({ length: 10 }, (_, d) => [`${d}.gpx`, strToU8(gpxRun(d))])),
      {
        level: 0,
      },
    );
    const cut = zip.subarray(0, Math.floor(zip.length * 0.55));
    const partial = await svc.importFiles([file('cut.zip', cut)], { timezone: 'UTC' });
    expect(partial.imported).toBeGreaterThanOrEqual(4);
    expect(partial.imported).toBeLessThan(10);
    expect(partial.sourceErrors).toHaveLength(1);
    expect(partial.sourceErrors[0]!.message).toMatch(/damaged or incomplete/);
    expect(
      partial.outcomes.some((o) => o.message === 'The archive ended before this file was complete'),
    ).toBe(true);
    const retry = await svc.importFiles([file('full.zip', zip)], { timezone: 'UTC' });
    expect(retry.duplicates).toBe(partial.imported);
    expect(retry.imported).toBe(10 - partial.imported);
    expect(await count(ctx, 'SELECT COUNT(*) AS n FROM activities')).toBe(10);
  });

  it('stops between files when cancelled and reports progress as it goes', async () => {
    const ctx = await freshDb();
    const zip = zipSync(
      Object.fromEntries(Array.from({ length: 8 }, (_, d) => [`${d}.gpx`, strToU8(gpxRun(d))])),
    );
    const seen: BulkImportProgress[] = [];
    let cancel = false;
    const report = await new BulkImportService(ctx).importFiles([file('x.zip', zip, 2048)], {
      timezone: 'UTC',
      // As the UI does: the user taps Cancel while the third file's result is on screen.
      onProgress: (p) => {
        seen.push(p);
        if (p.imported >= 3) cancel = true;
      },
      isCancelled: () => cancel,
    });
    expect(report.cancelled).toBe(true);
    expect(report.imported).toBe(3);
    expect(await count(ctx, 'SELECT COUNT(*) AS n FROM activities')).toBe(3);
    const bytes = seen.map((p) => p.bytesRead);
    expect(bytes).toEqual([...bytes].sort((a, b) => a - b));
    expect(seen.every((p) => p.bytesTotal === zip.length && p.fileCount === 1)).toBe(true);
  });

  it('records archive-level failures without throwing', async () => {
    const ctx = await freshDb();
    const report = await new BulkImportService(ctx).importFiles(
      [file('empty.zip', zipSync({})), file('ok.gpx', strToU8(gpxRun(30)))],
      { timezone: 'UTC' },
    );
    expect(report.sourceErrors).toEqual([
      { file: 'empty.zip', message: expect.stringMatching(/no files|damaged/) },
    ]);
    expect(report.imported).toBe(1);
  });
});
