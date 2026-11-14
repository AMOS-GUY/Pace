/**
 * Timestamps outside 2000–2100 (the range every stored activity time must be in; see
 * epochMsSchema) are refused at import, like any other invalid time. Before this, one GPX or TCX
 * point dated in year 99999 was accepted, dropped every later point as "out of order", and
 * stored an activity whose time no backup can hold: the whole backup then failed validation on
 * restore.
 */
import { type DatabaseContext, configureConnection, migrate } from '@pace/database';
import { parseGpxTrack, parseTcx } from '@pace/formats';
import { NodeSqliteDriver } from '../../database/src/test-fixtures/node-sqlite-driver';
import { ActivityService, BackupService } from './index';

const T = Date.UTC(2026, 10, 10, 7, 0);
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

const iso = (s: number) => new Date(T + s * 1000).toISOString();
const gpxPoint = (s: number, time = iso(s)) =>
  `<trkpt lat="47.0" lon="${(8 + s / 10_000).toFixed(5)}"><time>${time}</time></trkpt>`;
const gpx = (pts: string) =>
  `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><type>running</type><trkseg>${pts}</trkseg></trk></gpx>`;
const tcxPoint = (s: number, time = iso(s)) =>
  `<Trackpoint><Time>${time}</Time><Position><LatitudeDegrees>47.0</LatitudeDegrees><LongitudeDegrees>${(8 + s / 10_000).toFixed(5)}</LongitudeDegrees></Position></Trackpoint>`;
const tcx = (pts: string) =>
  `<?xml version="1.0"?><TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"><Activities><Activity Sport="Running"><Id>${iso(0)}</Id><Lap StartTime="${iso(0)}"><Track>${pts}</Track></Lap></Activity></Activities></TrainingCenterDatabase>`;

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('import refuses timestamps outside 2000–2100', () => {
  it.each([
    ['year 99999', '+099999-01-01T00:00:00Z'],
    ['year 2200', '2200-01-01T00:00:00Z'],
    ['year 1970', '1970-01-01T00:00:00Z'],
  ])('GPX: a point dated %s is skipped and later points are kept', (_, bad) => {
    const t = parseGpxTrack(
      gpx(
        range(10)
          .map((s) => (s === 4 ? gpxPoint(s, bad) : gpxPoint(s)))
          .join(''),
      ),
    );
    expect(t.segments.flat().map((p) => (p.recordedAt - T) / 1000)).toEqual([
      0, 1, 2, 3, 5, 6, 7, 8, 9,
    ]);
    expect(t.warnings.join(' ')).toMatch(
      /1 point\(s\) without valid coordinates or time were skipped/,
    );
  });

  it('TCX: a point dated year 99999 is skipped and later points are kept', () => {
    const [t] = parseTcx(
      tcx(
        range(10)
          .map((s) => (s === 4 ? tcxPoint(s, '+099999-01-01T00:00:00Z') : tcxPoint(s)))
          .join(''),
      ),
    );
    expect(t!.segments.flat().map((p) => (p.recordedAt - T) / 1000)).toEqual([
      0, 1, 2, 3, 5, 6, 7, 8, 9,
    ]);
  });

  it('keeps backups restorable after importing such a file', async () => {
    const src = await db('8001');
    await new ActivityService(src).importTrack(
      parseGpxTrack(
        gpx(
          range(30)
            .map((s) => (s === 10 ? gpxPoint(s, '+099999-01-01T00:00:00Z') : gpxPoint(s)))
            .join(''),
        ),
      ),
      { timezone: 'UTC' },
    );
    const { bytes } = await new BackupService(src, '0.1.0').createBackup(null);
    const dst = await db('8002');
    const svc = new BackupService(dst, '0.1.0');
    const report = await svc.restore(svc.open(bytes, null));
    expect(report).toMatchObject({ restored: 1, failed: [] });
  });
});
