/**
 * R4 (docs/M4_7_RELEASE_READINESS.md): FIT records that share one second. A record repeating the
 * previous record's time used to be skipped entirely, losing a GPS position or sensor values the
 * first record did not have. Same-second records are now merged: the later record adds only what
 * is still missing at that time, and never replaces or duplicates a value.
 *
 * R5: sensor values recorded while the timer is stopped are kept (they are real measurements)
 * and do not create GPS points or segments.
 */
import { straightTrack } from '../../gps-engine/src/test-fixtures/synthetic-track';
import { type ParsedTrack, parseFit } from './index';
import { BT, FitWriter, fitFile, fitSeconds, semicircles } from './test-fixtures/fit-encoder';

const T = Date.UTC(2026, 9, 4, 6, 30);
const pts = straightTrack({ speedMps: 3, durationSeconds: 20, startTime: T });
const at = (i: number) => fitSeconds(pts[i]!.recordedAt);

function file(build: (w: FitWriter) => void): Uint8Array {
  const w = new FitWriter();
  w.define(0, 0, [[0, BT.enum]]).data(0, [4]);
  // Local 1: GPS record with heart rate. Local 3: sensor-only record (hr, cadence, power).
  // Local 2: sensor-only record without a timestamp field, for compressed-timestamp headers.
  w.define(1, 20, [
    [253, BT.uint32],
    [0, BT.sint32],
    [1, BT.sint32],
    [3, BT.uint8],
  ]);
  w.define(3, 20, [
    [253, BT.uint32],
    [3, BT.uint8],
    [4, BT.uint8],
    [7, BT.uint16],
  ]);
  w.define(2, 20, [
    [3, BT.uint8],
    [4, BT.uint8],
    [7, BT.uint16],
  ]);
  w.define(4, 21, [
    [253, BT.uint32],
    [0, BT.enum],
    [1, BT.enum],
  ]);
  build(w);
  return fitFile(w.bytes());
}
const gps = (w: FitWriter, i: number, hr: number | null) =>
  w.data(1, [at(i), semicircles(pts[i]!.latitude), semicircles(pts[i]!.longitude), hr]);
const sens = (w: FitWriter, i: number, hr: number | null, cad: number | null, pow: number | null) =>
  w.data(3, [at(i), hr, cad, pow]);

const only = (b: Uint8Array): ParsedTrack => {
  const tracks = parseFit(b);
  expect(tracks).toHaveLength(1);
  return tracks[0]!;
};
const pointSeconds = (t: ParsedTrack) => t.segments.flat().map((p) => (p.recordedAt - T) / 1000);
const sensorsAt = (t: ParsedTrack, i: number) =>
  t.sensors
    .filter((s) => s.recordedAt === pts[i]!.recordedAt)
    .map((s) => [s.type, s.value])
    .sort();

describe('FIT records sharing one second (R4)', () => {
  it('keeps cadence and power from a second record the first record did not have', () => {
    const t = only(
      file((w) => {
        for (let i = 0; i < 5; i++) {
          gps(w, i, 150);
          if (i === 2) sens(w, 2, null, 80, 250);
        }
      }),
    );
    expect(sensorsAt(t, 2)).toEqual([
      ['cadence', 80],
      ['heart_rate', 150],
      ['power', 250],
    ]);
    expect(pointSeconds(t)).toEqual([0, 1, 2, 3, 4]);
    expect(t.warnings.join(' ')).toMatch(/1 record\(s\) sharing a time with the previous record/);
  });

  it('keeps the GPS position when a sensor-only record came first in that second', () => {
    const t = only(
      file((w) => {
        for (let i = 0; i < 5; i++) {
          if (i === 2) sens(w, 2, 149, null, null);
          gps(w, i, 152);
        }
      }),
    );
    expect(pointSeconds(t)).toEqual([0, 1, 2, 3, 4]);
    // The first heart-rate value at that time is kept; the conflicting second one is reported.
    expect(sensorsAt(t, 2)).toEqual([['heart_rate', 149]]);
    expect(t.warnings.join(' ')).toMatch(/1 value\(s\) conflicting with the first record/);
  });

  it('keeps heart rate from a second record when the first had none', () => {
    const t = only(
      file((w) => {
        for (let i = 0; i < 5; i++) {
          gps(w, i, i === 2 ? null : 140);
          if (i === 2) sens(w, 2, 150, null, null);
        }
      }),
    );
    expect(sensorsAt(t, 2)).toEqual([['heart_rate', 150]]);
  });

  it('never duplicates or replaces: conflicting values keep the first, one sample per sensor and time', () => {
    const t = only(
      file((w) => {
        for (let i = 0; i < 5; i++) {
          gps(w, i, 140);
          if (i === 2) gps(w, 2, 160);
        }
      }),
    );
    expect(sensorsAt(t, 2)).toEqual([['heart_rate', 140]]);
    expect(pointSeconds(t)).toEqual([0, 1, 2, 3, 4]);
    for (let i = 0; i < 5; i++) expect(sensorsAt(t, i)).toHaveLength(1);
  });

  it('still reports an exact repeat as skipped (nothing new in it)', () => {
    const t = only(
      file((w) => {
        for (let i = 0; i < 5; i++) {
          gps(w, i, 140);
          if (i === 2) gps(w, 2, 140);
        }
      }),
    );
    expect(t.warnings).toContain("1 record(s) repeating the previous record's time were skipped.");
    expect(t.sensors).toHaveLength(5);
  });

  it('merges a compressed-timestamp record in the same second as well', () => {
    const t = only(
      file((w) => {
        for (let i = 0; i < 5; i++) {
          gps(w, i, 150);
          if (i === 2) w.compressed(2, at(2), [null, 82, 240]);
        }
      }),
    );
    expect(sensorsAt(t, 2)).toEqual([
      ['cadence', 82],
      ['heart_rate', 150],
      ['power', 240],
    ]);
  });
});

describe('FIT sensor values while the timer is stopped (R5)', () => {
  it('keeps them as measurements but adds no GPS point or segment', () => {
    const t = only(
      file((w) => {
        w.data(4, [at(0), 0, 0]); // timer start
        for (let i = 0; i < 5; i++) gps(w, i, 140);
        w.data(4, [at(4), 0, 4]); // timer stop
        for (let i = 5; i < 9; i++) sens(w, i, 120, 0, 0); // stopped: heart rate, zero cadence and power
        w.data(4, [at(9), 0, 0]); // timer start
        for (let i = 9; i < 14; i++) gps(w, i, 145);
      }),
    );
    expect(t.segments.map((s) => s.length)).toEqual([5, 5]);
    expect(pointSeconds(t)).toEqual([0, 1, 2, 3, 4, 9, 10, 11, 12, 13]);
    for (let i = 5; i < 9; i++)
      expect(sensorsAt(t, i)).toEqual([
        ['cadence', 0],
        ['heart_rate', 120],
        ['power', 0],
      ]);
  });
});

describe('FIT same-second merging: review edge cases (M4.8)', () => {
  const lap = (w: FitWriter, i: number) => w.data(5, [at(i), at(0)]);
  const fileWithLaps = (build: (w: FitWriter) => void) =>
    file((w) => {
      w.define(5, 19, [
        [253, BT.uint32],
        [2, BT.uint32],
      ]);
      build(w);
    });

  it('merges three or more records in one second, each adding only what is missing', () => {
    const t = only(
      file((w) => {
        for (let i = 0; i < 5; i++) {
          if (i === 2) {
            sens(w, 2, null, 80, null);
            sens(w, 2, 150, null, null);
            gps(w, 2, null);
            sens(w, 2, null, null, 240);
          } else gps(w, i, 140);
        }
      }),
    );
    expect(sensorsAt(t, 2)).toEqual([
      ['cadence', 80],
      ['heart_rate', 150],
      ['power', 240],
    ]);
    expect(pointSeconds(t)).toEqual([0, 1, 2, 3, 4]);
    expect(t.warnings.join(' ')).toMatch(/3 record\(s\) sharing a time/);
  });

  it('gives the same result whatever the order of the records in that second', () => {
    const orders = [
      (w: FitWriter) => {
        gps(w, 2, 150);
        sens(w, 2, null, 80, 240);
      },
      (w: FitWriter) => {
        sens(w, 2, null, 80, 240);
        gps(w, 2, 150);
      },
    ];
    const results = orders.map((order) =>
      only(
        file((w) => {
          for (let i = 0; i < 5; i++) {
            if (i === 2) order(w);
            else gps(w, i, 140);
          }
        }),
      ),
    );
    expect(sensorsAt(results[0]!, 2)).toEqual(sensorsAt(results[1]!, 2));
    expect(pointSeconds(results[0]!)).toEqual(pointSeconds(results[1]!));
  });

  it('reports a different second position as a conflict and keeps the first', () => {
    const t = only(
      file((w) => {
        for (let i = 0; i < 5; i++) {
          gps(w, i, 140);
          // A second record at second 2 with another position (point 3's).
          if (i === 2)
            w.data(1, [at(2), semicircles(pts[3]!.latitude), semicircles(pts[3]!.longitude), 140]);
        }
      }),
    );
    expect(pointSeconds(t)).toEqual([0, 1, 2, 3, 4]);
    const kept = t.segments.flat()[2]!;
    expect(kept.latitude).toBeCloseTo(pts[2]!.latitude, 7);
    expect(t.warnings.join(' ')).toMatch(/1 value\(s\) conflicting with the first record/);
  });

  it('does not count an identical repeated position as a conflict', () => {
    const t = only(
      file((w) => {
        for (let i = 0; i < 5; i++) {
          gps(w, i, 140);
          if (i === 2) gps(w, 2, 140);
        }
      }),
    );
    expect(t.warnings.join(' ')).not.toMatch(/conflicting/);
  });

  it('keeps lap boundaries and timer transitions unaffected by merging', () => {
    const t = only(
      fileWithLaps((w) => {
        w.data(4, [at(0), 0, 0]);
        for (let i = 0; i < 4; i++) gps(w, i, 140);
        w.data(4, [at(3), 0, 4]); // stop at second 3
        sens(w, 3, null, 0, 0); // same second as the stop: merged, adds zero cadence and power
        w.data(4, [at(6), 0, 0]); // start
        for (let i = 6; i < 10; i++) {
          gps(w, i, 145);
          if (i === 7) sens(w, 7, null, 82, null); // merged within the second lap
        }
        lap(w, 5);
      }),
    );
    expect(t.segments.map((s) => s.length)).toEqual([4, 4]);
    expect(sensorsAt(t, 3)).toEqual([
      ['cadence', 0],
      ['heart_rate', 140],
      ['power', 0],
    ]);
    expect(sensorsAt(t, 7)).toEqual([
      ['cadence', 82],
      ['heart_rate', 145],
    ]);
  });
});
