/**
 * R1: power survives PACE's own GPX export and re-import (FIT → PACE → GPX → PACE), through the
 * real services and SQLite. Before the fix the re-imported activity had no power at all.
 */
import { type DatabaseContext, configureConnection, migrate } from '@pace/database';
import { parseFit, parseGpxTrack } from '@pace/formats';
import { NodeSqliteDriver } from '../../database/src/test-fixtures/node-sqlite-driver';
import { type FitPoint, SPORT, fitActivity } from '../../formats/src/test-fixtures/fit-encoder';
import { straightTrack } from '../../gps-engine/src/test-fixtures/synthetic-track';
import { ActivityService } from './index';

const T = Date.UTC(2026, 10, 2, 7, 0);

async function db(): Promise<DatabaseContext> {
  const d = new NodeSqliteDriver();
  await configureConnection(d);
  await migrate(d);
  let n = 0;
  return {
    db: d,
    now: () => T,
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  };
}

const powerRows = (ctx: DatabaseContext, id: string) =>
  ctx.db.all<{ recorded_at: number; value: number }>(
    "SELECT recorded_at, value FROM sensor_samples WHERE activity_id = ? AND sensor_type = 'power' ORDER BY recorded_at",
    [id],
  );

/** Imports a FIT ride, exports it as GPX, imports that GPX into a fresh database. */
async function roundTrip(points: FitPoint[]) {
  const a = await db();
  const svc = new ActivityService(a);
  const [track] = parseFit(fitActivity({ sessions: [{ sport: SPORT.cycling, laps: [[points]] }] }));
  const first = await svc.importTrack(track!, { timezone: 'UTC' });
  const { content } = await svc.exportGpx(first.activityId);
  const b = await db();
  const second = await new ActivityService(b).importTrack(parseGpxTrack(content), {
    timezone: 'UTC',
  });
  return {
    before: await powerRows(a, first.activityId),
    after: await powerRows(b, second.activityId),
    content,
  };
}

const ride = straightTrack({ speedMps: 8, durationSeconds: 300, startTime: T });

describe('GPX export round trip: power (R1)', () => {
  it('keeps complete power exactly: same times, same values, including zeros', async () => {
    const r = await roundTrip(
      ride.map((sample, i) => ({ sample, watts: i % 20 < 3 ? 0 : 150 + (i % 60) })),
    );
    expect(r.before.length).toBe(ride.length);
    expect(r.after).toEqual(r.before);
    expect(r.after.filter((p) => p.value === 0).length).toBeGreaterThan(0);
  });

  it('keeps sparse power sparse and dropouts as gaps (nothing is filled in)', async () => {
    const r = await roundTrip(
      ride.map((sample, i) => ({
        sample,
        ...(i % 7 === 0 && !(i >= 100 && i < 160) ? { watts: 210 } : {}),
      })),
    );
    expect(r.before.length).toBeGreaterThan(10);
    expect(r.after).toEqual(r.before);
    const gap = r.after.find(
      (p, i) => i > 0 && p.recorded_at - r.after[i - 1]!.recorded_at > 30_000,
    );
    expect(gap).toBeDefined();
  });

  it('exports no power and no power namespace for a ride without power', async () => {
    const r = await roundTrip(ride.map((sample) => ({ sample, hr: 140 })));
    expect(r.before).toEqual([]);
    expect(r.after).toEqual([]);
    expect(r.content).not.toMatch(/PowerInWatts|PowerExtension/);
  });
});
