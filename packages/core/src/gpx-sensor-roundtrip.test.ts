/**
 * R6: heart rate and cadence through PACE's own GPX export and re-import
 * (PACE activity → exportGpx → parseGpxTrack → importTrack), through the real services and
 * SQLite. GPX can carry a sensor value only on a track point, so a sample can move to the
 * nearest point; it must never be copied onto other points or invented.
 */
import { type DatabaseContext, configureConnection, migrate } from '@pace/database';
import type { LocationSample } from '@pace/domain';
import { type ImportedSensorSample, type ParsedTrack, parseGpxTrack } from '@pace/formats';
import { NodeSqliteDriver } from '../../database/src/test-fixtures/node-sqlite-driver';
import { straightTrack } from '../../gps-engine/src/test-fixtures/synthetic-track';
import { ActivityService } from './index';

const T = Date.UTC(2026, 10, 4, 7, 0);
/** How far a sample may move to reach a track point (see EXPORT_FORMATS.md). */
const MAX_SHIFT_MS = 2000;

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

type Sample = { type: string; at: number; value: number };
const rows = async (ctx: DatabaseContext, id: string): Promise<Sample[]> =>
  (
    await ctx.db.all<{ sensor_type: string; recorded_at: number; value: number }>(
      'SELECT sensor_type, recorded_at, value FROM sensor_samples WHERE activity_id = ? ORDER BY sensor_type, recorded_at',
      [id],
    )
  ).map((r) => ({ type: r.sensor_type, at: r.recorded_at, value: r.value }));

const UNIT = { heart_rate: 'bpm', cadence: 'rpm', power: 'W' } as const;
const sensor = (
  type: ImportedSensorSample['type'],
  recordedAt: number,
  value: number,
): ImportedSensorSample => ({ type, recordedAt, value, unit: UNIT[type] });

/** A track with GPS points at the given offsets (seconds). */
function points(offsets: number[]): LocationSample[] {
  const line = straightTrack({ speedMps: 3, durationSeconds: offsets.at(-1)! + 1, startTime: T });
  return offsets.map((s) => ({ ...line[s]!, recordedAt: T + s * 1000 }));
}

function track(pts: LocationSample[], sensors: ImportedSensorSample[]): ParsedTrack {
  return {
    format: 'fit',
    name: 'Run',
    description: null,
    sportType: 'running',
    segments: [pts],
    sensors: [...sensors].sort((a, b) => a.recordedAt - b.recordedAt),
    lapStarts: [],
    warnings: [],
  };
}

async function roundTrip(t: ParsedTrack) {
  const a = await db();
  const svc = new ActivityService(a);
  const { activityId } = await svc.importTrack(t, { timezone: 'UTC' });
  const original = await rows(a, activityId);
  const { content } = await svc.exportGpx(activityId);
  const exported = {
    heart_rate: (content.match(/<gpxtpx:hr>/g) ?? []).length,
    cadence: (content.match(/<gpxtpx:cad>/g) ?? []).length,
    power: (content.match(/<gpxpx:PowerInWatts>/g) ?? []).length,
  };
  const b = await db();
  const again = await new ActivityService(b).importTrack(parseGpxTrack(content), {
    timezone: 'UTC',
  });
  return { original, exported, reimported: await rows(b, again.activityId) };
}

/**
 * The invariant: every re-imported sample is one original sample of the same sensor, moved by
 * at most MAX_SHIFT_MS, with its value rounded to a whole number (GPX TrackPointExtension holds
 * whole numbers). No original sample is used twice, so nothing is duplicated or invented.
 */
function expectNoFabrication(original: Sample[], reimported: Sample[]): void {
  const used = new Set<Sample>();
  for (const r of reimported) {
    const match = original
      .filter(
        (o) =>
          !used.has(o) &&
          o.type === r.type &&
          Math.abs(o.at - r.at) <= MAX_SHIFT_MS &&
          Math.round(o.value) === r.value,
      )
      .sort((x, y) => Math.abs(x.at - r.at) - Math.abs(y.at - r.at))[0];
    if (!match)
      throw new Error(`re-imported ${r.type} ${r.value} at +${r.at - T} ms has no original`);
    used.add(match);
  }
}

const count = (s: Sample[], type: string) => s.filter((x) => x.type === type).length;
const range = (n: number, step = 1, from = 0) =>
  Array.from({ length: n }, (_, i) => from + i * step);

describe('GPX export round trip: heart rate and cadence (R6)', () => {
  it('1: heart rate every second on every GPS point survives exactly', async () => {
    const pts = points(range(120));
    const r = await roundTrip(
      track(
        pts,
        pts.map((p, i) => sensor('heart_rate', p.recordedAt, 130 + (i % 20))),
      ),
    );
    expect(r.exported.heart_rate).toBe(120);
    expect(r.reimported).toEqual(r.original);
  });

  it('2: heart rate every 5 s is not copied onto the points in between', async () => {
    const pts = points(range(120));
    const hr = range(24, 5).map((s) => sensor('heart_rate', T + s * 1000, 140 + s / 5));
    const r = await roundTrip(track(pts, hr));
    expect(count(r.original, 'heart_rate')).toBe(24);
    expect(r.exported.heart_rate).toBe(24);
    expect(r.reimported).toEqual(r.original);
  });

  it('3: sparse cadence (every 7 s) stays sparse', async () => {
    const pts = points(range(140));
    const cad = range(20, 7).map((s) => sensor('cadence', T + s * 1000, 80 + (s % 5)));
    const r = await roundTrip(track(pts, cad));
    expect(r.exported.cadence).toBe(20);
    expect(r.reimported).toEqual(r.original);
  });

  it('4: a 30 s heart-rate dropout stays a gap', async () => {
    const pts = points(range(120));
    const hr = pts
      .map((p, i) => ({ p, i }))
      .filter(({ i }) => i < 40 || i >= 70)
      .map(({ p, i }) => sensor('heart_rate', p.recordedAt, 120 + (i % 30)));
    const r = await roundTrip(track(pts, hr));
    expect(r.reimported).toEqual(r.original);
    const inGap = r.reimported.filter((s) => s.at >= T + 40_000 && s.at < T + 70_000);
    expect(inGap).toEqual([]);
  });

  it('5: samples between GPS timestamps move to the nearest point, at most once each', async () => {
    const pts = points(range(60, 2)); // GPS every 2 s
    const hr = range(60, 2, 1).map((s) => sensor('heart_rate', T + s * 1000, 150 + (s % 7))); // odd seconds
    const r = await roundTrip(track(pts, hr));
    expectNoFabrication(r.original, r.reimported);
    expect(count(r.reimported, 'heart_rate')).toBeLessThanOrEqual(60);
    // Each value lands on one GPS point, 1 s from where it was measured.
    for (const s of r.reimported) expect((s.at - T) % 2000).toBe(0);
  });

  it('6: repeated identical values at different times are all kept, none merged or added', async () => {
    const pts = points(range(90));
    const r = await roundTrip(
      track(
        pts,
        pts.map((p) => sensor('heart_rate', p.recordedAt, 150)),
      ),
    );
    expect(count(r.reimported, 'heart_rate')).toBe(90);
    expect(r.reimported).toEqual(r.original);
  });

  it('7: zero cadence is a real value and survives', async () => {
    const pts = points(range(60));
    const cad = pts.map((p, i) => sensor('cadence', p.recordedAt, i >= 20 && i < 30 ? 0 : 85));
    const r = await roundTrip(track(pts, cad));
    expect(r.reimported.filter((s) => s.value === 0).length).toBe(10);
    expect(r.reimported).toEqual(r.original);
  });

  it('8: irregular GPS intervals with 1 Hz heart rate: nothing invented, nothing used twice', async () => {
    const gaps = [1, 3, 1, 4, 2, 1, 1, 3, 2, 4];
    const offsets = [0];
    for (let i = 0; offsets.length < 60; i++)
      offsets.push(offsets.at(-1)! + gaps[i % gaps.length]!);
    const pts = points(offsets);
    const last = offsets.at(-1)!;
    const hr = range(last + 1).map((s) => sensor('heart_rate', T + s * 1000, 120 + (s % 40)));
    const r = await roundTrip(track(pts, hr));
    expectNoFabrication(r.original, r.reimported);
    // At most one value per GPS point, and every value that has its own point survives exactly.
    expect(count(r.reimported, 'heart_rate')).toBeLessThanOrEqual(pts.length);
    const onPoint = r.original.filter((o) => offsets.includes((o.at - T) / 1000));
    for (const o of onPoint) expect(r.reimported).toContainEqual(o);
  });

  it('9: several streams at different rates are each kept without copies', async () => {
    const pts = points(range(120));
    const sensors = [
      ...range(120).map((s) => sensor('heart_rate', T + s * 1000, 130 + (s % 10))),
      ...range(40, 3).map((s) => sensor('cadence', T + s * 1000, 88)),
      ...range(60, 2).map((s) => sensor('power', T + s * 1000, 200 + (s % 13))),
    ];
    const r = await roundTrip(track(pts, sensors));
    expect(r.exported).toEqual({ heart_rate: 120, cadence: 40, power: 60 });
    expect(r.reimported).toEqual(r.original);
  });

  it('rounds fractional cadence to whole rpm (a GPX TrackPointExtension limit) without moving it', async () => {
    const pts = points(range(30));
    const r = await roundTrip(
      track(
        pts,
        pts.map((p) => sensor('cadence', p.recordedAt, 85.5)),
      ),
    );
    expect(r.reimported.map((s) => s.value)).toEqual(Array(30).fill(86));
    expect(r.reimported.map((s) => s.at)).toEqual(r.original.map((s) => s.at));
  });
});
