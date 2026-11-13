/**
 * R3 (approved: document, no custom GPX extension): a triathlon exported as GPX cannot keep its
 * legs. Re-importing that GPX must say so clearly instead of passing as a complete file.
 */
import { type DatabaseContext, configureConnection, migrate } from '@pace/database';
import type { LocationSample } from '@pace/domain';
import { parseFit, parseGpxTrack } from '@pace/formats';
import { NodeSqliteDriver } from '../../database/src/test-fixtures/node-sqlite-driver';
import { stravaGpx, withSensors } from '../../formats/src/test-fixtures/device-files';
import {
  SPORT,
  SUB_SPORT,
  fitActivity,
  fitPoints,
} from '../../formats/src/test-fixtures/fit-encoder';
import { straightTrack } from '../../gps-engine/src/test-fixtures/synthetic-track';
import { ActivityService, BulkImportService, type ImportError } from './index';
import { strToU8 } from 'fflate';
import { bytesSource } from '@pace/formats';

const T = Date.UTC(2026, 10, 3, 6, 30);
const LIMITATION = /cannot hold the swim, transition, bike and run legs/;

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

function triathlon(): Uint8Array {
  const after = (s: LocationSample[]) => ({
    latitude: s.at(-1)!.latitude,
    longitude: s.at(-1)!.longitude,
  });
  const swim = straightTrack({ speedMps: 1, durationSeconds: 600, startTime: T, intervalMs: 5000 });
  const t1 = straightTrack({
    speedMps: 1,
    durationSeconds: 60,
    startTime: T + 605_000,
    start: after(swim),
  });
  const bike = straightTrack({
    speedMps: 9,
    durationSeconds: 900,
    startTime: T + 666_000,
    start: after(t1),
  });
  const t2 = straightTrack({
    speedMps: 1,
    durationSeconds: 40,
    startTime: T + 1_567_000,
    start: after(bike),
  });
  const run = straightTrack({
    speedMps: 3.5,
    durationSeconds: 600,
    startTime: T + 1_608_000,
    start: after(t2),
  });
  const legs = [swim, t1, bike, t2, run];
  const sports = [SPORT.swimming, SPORT.transition, SPORT.cycling, SPORT.transition, SPORT.running];
  return fitActivity({
    sportMessage: { sport: SPORT.multisport },
    sessions: sports.map((sport, i) => ({
      sport,
      subSport: i === 0 ? SUB_SPORT.openWater : 0,
      laps: [[fitPoints(legs[i]!)]],
    })),
  });
}

describe('GPX and multisport (R3)', () => {
  it('warns when a GPX is marked as a triathlon or multisport activity', () => {
    const pts = withSensors(straightTrack({ speedMps: 3, durationSeconds: 30, startTime: T }));
    for (const type of ['triathlon', 'multisport', 'multi_sport', 'duathlon']) {
      const t = parseGpxTrack(stravaGpx({ name: 'x', type, points: pts }));
      expect(t.sportType).toBeNull();
      expect(t.warnings.join(' ')).toMatch(LIMITATION);
    }
    // Other files are unaffected.
    const run = parseGpxTrack(stravaGpx({ name: 'x', type: 'running', points: pts }));
    expect(run.warnings.join(' ')).not.toMatch(LIMITATION);
  });

  it('PACE’s own GPX export of a triathlon reports the limitation when imported again', async () => {
    const a = await db();
    const svc = new ActivityService(a);
    const [track] = parseFit(triathlon());
    const { activityId } = await svc.importTrack(track!, { timezone: 'UTC' });
    const { content } = await svc.exportGpx(activityId);
    expect(content).toContain('<type>triathlon</type>');
    expect(content).not.toMatch(/xmlns:pace|<pace:/); // no custom GPX extension

    const parsed = parseGpxTrack(content);
    expect(parsed.sportType).toBeNull();
    expect(parsed.warnings.join(' ')).toMatch(LIMITATION);

    // Choosing "triathlon" for it is refused with the reason; nothing is stored.
    const b = await db();
    await expect(
      new ActivityService(b).importTrack(parsed, { timezone: 'UTC', sportType: 'triathlon' }),
    ).rejects.toMatchObject({
      code: 'unsupported_sport',
      message: expect.stringMatching(/without their swim, transition, bike and run legs/),
    } satisfies Partial<ImportError>);
    expect((await b.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM activities'))!.n).toBe(0);

    // Through bulk import (the app's import screen), the outcome carries the same warning.
    const report = await new BulkImportService(b).importFiles(
      [{ name: 'race.gpx', open: () => bytesSource(strToU8(content)) }],
      { timezone: 'UTC' },
    );
    expect(report.outcomes[0]).toMatchObject({ status: 'needs_sport' });
    expect(report.outcomes[0]!.warnings.join(' ')).toMatch(LIMITATION);
  });
});
