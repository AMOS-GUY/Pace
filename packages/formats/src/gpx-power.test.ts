/**
 * R1 (docs/M4_7_RELEASE_READINESS.md): power in PACE's GPX export. Power is written as Garmin's
 * PowerExtension v1 `PowerInWatts` on the track point with exactly the same time, and PACE's GPX
 * importer reads it back. Files without power are unchanged.
 */
import { straightTrack } from '../../gps-engine/src/test-fixtures/synthetic-track';
import { type GpxExportInput, parseGpxTrack, toGpx } from './index';

const T = Date.UTC(2026, 10, 1, 7, 0);
const points = straightTrack({ speedMps: 8, durationSeconds: 120, startTime: T });
const base: GpxExportInput = {
  name: 'Ride',
  sportType: 'cycling',
  startedAt: T,
  segments: [points.slice(0, 60), points.slice(70)],
};
const powerOf = (xml: string) =>
  parseGpxTrack(xml)
    .sensors.filter((s) => s.type === 'power')
    .map((s) => [s.recordedAt, s.value]);

describe('GPX export: power', () => {
  it('writes every power sample on its own track point, and the importer reads it back exactly', () => {
    const power = [...points.slice(0, 60), ...points.slice(70)].map((p, i) => ({
      recordedAt: p.recordedAt,
      watts: 180 + (i % 37),
    }));
    const xml = toGpx({ ...base, power });
    expect(xml).toContain('xmlns:gpxpx="http://www.garmin.com/xmlschemas/PowerExtension/v1"');
    expect(powerOf(xml)).toEqual(power.map((p) => [p.recordedAt, p.watts]));
    // The import does not report the power element as "not imported".
    expect(parseGpxTrack(xml).warnings.join(' ')).not.toMatch(/PowerInWatts/);
  });

  it('keeps sparse power sparse: no sample is copied to neighbouring points', () => {
    const power = points
      .filter((_, i) => i % 10 === 0 && i < 60)
      .map((p) => ({ recordedAt: p.recordedAt, watts: 250 }));
    expect(powerOf(toGpx({ ...base, power }))).toEqual(power.map((p) => [p.recordedAt, 250]));
  });

  it('keeps zero watts as a real value, distinct from missing power', () => {
    const power = [
      { recordedAt: points[1]!.recordedAt, watts: 0 },
      { recordedAt: points[2]!.recordedAt, watts: 140 },
    ];
    expect(powerOf(toGpx({ ...base, power }))).toEqual([
      [points[1]!.recordedAt, 0],
      [points[2]!.recordedAt, 140],
    ]);
  });

  it('does not round power, and leaves out samples that have no track point at their time', () => {
    const between = points[5]!.recordedAt + 500; // no GPS point at this time
    const power = [
      { recordedAt: points[5]!.recordedAt, watts: 201.5 },
      { recordedAt: between, watts: 999 },
      { recordedAt: points[65]!.recordedAt, watts: 300 }, // inside the gap between segments
    ];
    expect(powerOf(toGpx({ ...base, power }))).toEqual([[points[5]!.recordedAt, 201.5]]);
  });

  it('writes power alongside heart rate and cadence on the same point', () => {
    const at = points[3]!.recordedAt;
    const xml = toGpx({
      ...base,
      heartRate: [{ recordedAt: at, bpm: 150 }],
      cadence: [{ recordedAt: at, rpm: 88 }],
      power: [{ recordedAt: at, watts: 220 }],
    });
    const t = parseGpxTrack(xml);
    expect(t.sensors.filter((s) => s.recordedAt === at).map((s) => [s.type, s.value])).toEqual(
      expect.arrayContaining([
        ['heart_rate', 150],
        ['cadence', 88],
        ['power', 220],
      ]),
    );
  });

  it('is unchanged for activities without power (backward compatible)', () => {
    const without = toGpx(base);
    expect(toGpx({ ...base, power: [] })).toBe(without);
    expect(without).not.toMatch(/PowerExtension|PowerInWatts|gpxpx/);
    expect(powerOf(without)).toEqual([]);
  });
});
