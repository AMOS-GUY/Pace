/** FIT times run to 2126; PACE stores 2000–2100, so later records are invalid times, skipped. */
import { straightTrack } from '../../gps-engine/src/test-fixtures/synthetic-track';
import { parseFit } from './index';
import { BT, FitWriter, fitFile, fitSeconds, semicircles } from './test-fixtures/fit-encoder';

const T = Date.UTC(2026, 9, 4, 6, 30);
const pts = straightTrack({ speedMps: 3, durationSeconds: 10, startTime: T });

it('skips a FIT record dated after 2100 and keeps the rest of the activity', () => {
  const w = new FitWriter();
  w.define(0, 0, [[0, BT.enum]]).data(0, [4]);
  w.define(1, 20, [
    [253, BT.uint32],
    [0, BT.sint32],
    [1, BT.sint32],
    [3, BT.uint8],
  ]);
  const rec = (i: number, time = fitSeconds(pts[i]!.recordedAt)) =>
    w.data(1, [time, semicircles(pts[i]!.latitude), semicircles(pts[i]!.longitude), 150]);
  for (let i = 0; i < 4; i++) rec(i);
  rec(4, fitSeconds(Date.UTC(2110, 0, 1))); // valid FIT time, outside what PACE can store
  for (let i = 5; i < 9; i++) rec(i);
  const [t] = parseFit(fitFile(w.bytes()));
  expect(t!.segments.flat().map((p) => (p.recordedAt - T) / 1000)).toEqual([
    0, 1, 2, 3, 5, 6, 7, 8,
  ]);
  expect(t!.sensors).toHaveLength(8);
  expect(t!.warnings.join(' ')).toMatch(/1 record\(s\) without a time were skipped/);
});
