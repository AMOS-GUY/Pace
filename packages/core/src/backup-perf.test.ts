/**
 * Backup performance on SYNTHETIC data, in Node on the development machine. Not a measure of
 * iPhone performance. Opt-in, because it takes minutes:
 *
 *   PACE_PERF=1 npx jest packages/core/src/backup-perf.test.ts
 *
 * Prints, per scenario: activities, GPS points, sensor samples, time to create an encrypted
 * backup, its size, time to open and restore it into an empty database, and the heap growth.
 */
import { type DatabaseContext, configureConnection, migrate } from '@pace/database';
import { type ParsedTrack } from '@pace/formats';
import { NodeSqliteDriver } from '../../database/src/test-fixtures/node-sqlite-driver';
import { straightTrack } from '../../gps-engine/src/test-fixtures/synthetic-track';
import { ActivityService, BackupService } from './index';

const run = process.env.PACE_PERF === '1' ? describe : describe.skip;
const T = Date.UTC(2026, 0, 1, 7, 0);
const KEY = { kind: 'passphrase' as const, passphrase: 'a long backup passphrase' };

async function db(tag: string): Promise<DatabaseContext> {
  const d = new NodeSqliteDriver();
  await configureConnection(d);
  await migrate(d);
  let n = 0;
  return {
    db: d,
    now: () => T,
    newId: () => `00000000-${tag}-4000-8000-${String(++n).padStart(12, '0')}`,
  };
}

/** A synthetic activity: GPS at 1 Hz, heart rate, cadence and power at 1 Hz. */
function activity(start: number, seconds: number): ParsedTrack {
  const pts = straightTrack({ speedMps: 8, durationSeconds: seconds, startTime: start });
  return {
    format: 'fit',
    name: 'Ride',
    description: null,
    sportType: 'cycling',
    segments: [pts],
    sensors: pts.flatMap((p, i) => [
      {
        type: 'heart_rate' as const,
        recordedAt: p.recordedAt,
        value: 120 + (i % 40),
        unit: 'bpm' as const,
      },
      {
        type: 'cadence' as const,
        recordedAt: p.recordedAt,
        value: 85 + (i % 10) / 2,
        unit: 'rpm' as const,
      },
      {
        type: 'power' as const,
        recordedAt: p.recordedAt,
        value: 150 + (i % 90),
        unit: 'W' as const,
      },
    ]),
    lapStarts: [],
    warnings: [],
  };
}

run('backup performance (synthetic)', () => {
  it.each([
    ['100 activities × 10 min', 100, 600],
    ['1,000 activities × 1 min', 1000, 60],
    ['1 activity × 4 h, dense', 1, 4 * 3600],
    ['5 activities × 2 h', 5, 2 * 3600],
  ])(
    '%s',
    async (label, count, seconds) => {
      const src = await db('9001');
      const svc = new ActivityService(src);
      for (let i = 0; i < count; i++)
        await svc.importTrack(activity(T + i * 86_400_000, seconds), { timezone: 'UTC' });

      global.gc?.();
      const heap0 = process.memoryUsage().heapUsed;
      let t = performance.now();
      const { bytes, document } = await new BackupService(src, '0.2.0').createBackup(KEY);
      const createMs = performance.now() - t;
      const heap1 = process.memoryUsage().heapUsed;

      const dst = await db('9002');
      t = performance.now();
      const restoreSvc = new BackupService(dst, '0.2.0');
      const report = await restoreSvc.restore(restoreSvc.open(bytes, KEY));
      const restoreMs = performance.now() - t;
      const heap2 = process.memoryUsage().heapUsed;

      expect(report.restored).toBe(count);
      expect(report.sensorSamplesRestored).toBe(document.counts.sensorSamples);
      process.stdout.write(
        `PERF ${label} | activities ${count} | points ${document.counts.samples} | sensor samples ${document.counts.sensorSamples} | create ${(createMs / 1000).toFixed(1)} s | size ${(bytes.length / 1024 / 1024).toFixed(2)} MB | restore ${(restoreMs / 1000).toFixed(1)} s | heap +${((heap1 - heap0) / 1024 / 1024).toFixed(0)} MB create, +${((heap2 - heap1) / 1024 / 1024).toFixed(0)} MB restore\n`,
      );
    },
    900_000,
  );
});
