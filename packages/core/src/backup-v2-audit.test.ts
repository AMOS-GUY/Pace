/**
 * Independent audit of backup format 2 (M4.8): strictness, cross-format fidelity, settings
 * security and restore atomicity at every write stage. Real BackupService, encryption and SQLite.
 */
import { BackupError, type BackupDocumentV1, parseBackup, serializeBackup } from '@pace/backup';
import {
  type DatabaseContext,
  SettingsRepository,
  configureConnection,
  migrate,
} from '@pace/database';
import type { LocationSample } from '@pace/domain';
import { parseFit, parseGpxTrack, parseTcx } from '@pace/formats';
import { gzipSync, strToU8 } from 'fflate';
import { NodeSqliteDriver } from '../../database/src/test-fixtures/node-sqlite-driver';
import { garminTcx, stravaGpx, withSensors } from '../../formats/src/test-fixtures/device-files';
import {
  type FitPoint,
  SPORT,
  SUB_SPORT,
  fitActivity,
  fitPoints,
} from '../../formats/src/test-fixtures/fit-encoder';
import { straightTrack } from '../../gps-engine/src/test-fixtures/synthetic-track';
import { ActivityService, BackupService } from './index';

const T = Date.UTC(2026, 10, 9, 7, 0);
const DAY = 86_400_000;
const PASS = { kind: 'passphrase' as const, passphrase: 'a long backup passphrase' };

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
const one = async (c: DatabaseContext, sql: string) => (await c.db.get<{ n: number }>(sql))!.n;
const after = (s: LocationSample[]) => ({
  latitude: s.at(-1)!.latitude,
  longitude: s.at(-1)!.longitude,
});

/** Every table a restore writes, per activity, in a comparable order. */
async function snapshot(c: DatabaseContext) {
  const ids = await c.db.all<{ id: string }>('SELECT id FROM activities ORDER BY started_at');
  const out = [];
  for (const { id } of ids) {
    const q = (sql: string) => c.db.all(sql, [id]);
    out.push({
      activity: await q(
        `SELECT sport_type, source, started_at, ended_at, elapsed_duration_ms, moving_duration_ms,
           distance_meters, elevation_gain_meters FROM activities WHERE id = ?`,
      ),
      points: await q(
        'SELECT sequence_number, latitude, longitude, altitude_meters, recorded_at FROM route_points WHERE activity_id = ? ORDER BY sequence_number',
      ),
      events: await q(
        'SELECT event_type, occurred_at FROM recording_events WHERE activity_id = ? ORDER BY sequence_number',
      ),
      laps: await q(
        'SELECT sequence_number, started_at, duration_ms, distance_meters FROM laps WHERE activity_id = ? ORDER BY sequence_number',
      ),
      legs: await q(
        'SELECT segment_type, sequence_number, started_at, distance_meters FROM activity_segments WHERE parent_activity_id = ? ORDER BY sequence_number',
      ),
      splits: await q(
        'SELECT split_index, distance_meters, moving_duration_ms FROM activity_splits WHERE activity_id = ? ORDER BY split_index',
      ),
      sensors: await q(
        'SELECT sensor_type, value, unit, recorded_at FROM sensor_samples WHERE activity_id = ? ORDER BY rowid',
      ),
    });
  }
  return out;
}

/** A FIT triathlon (swim, T1, bike with power, T2, run with heart rate and cadence). */
function triathlon(start: number): Uint8Array {
  const swim = straightTrack({
    speedMps: 1,
    durationSeconds: 300,
    startTime: start,
    intervalMs: 5000,
  });
  const t1 = straightTrack({
    speedMps: 1,
    durationSeconds: 40,
    startTime: start + 305_000,
    start: after(swim),
  });
  const bike = straightTrack({
    speedMps: 9,
    durationSeconds: 400,
    startTime: start + 346_000,
    start: after(t1),
  });
  const t2 = straightTrack({
    speedMps: 1,
    durationSeconds: 30,
    startTime: start + 747_000,
    start: after(bike),
  });
  const run = straightTrack({
    speedMps: 3.5,
    durationSeconds: 300,
    startTime: start + 778_000,
    start: after(t2),
  });
  const legs = [
    fitPoints(swim),
    fitPoints(t1),
    fitPoints(bike, { watts: 210 }),
    fitPoints(t2),
    fitPoints(run, { hr: true, cadence: 86.5 }),
  ];
  const sports = [SPORT.swimming, SPORT.transition, SPORT.cycling, SPORT.transition, SPORT.running];
  return fitActivity({
    sportMessage: { sport: SPORT.multisport },
    sessions: sports.map((sport, i) => ({
      sport,
      subSport: i === 0 ? SUB_SPORT.openWater : 0,
      laps: [[legs[i]!]],
    })),
  });
}

/** One activity of each import kind, with different sensor frequencies. */
async function mixedHistory(): Promise<DatabaseContext> {
  const c = await db('5001');
  const svc = new ActivityService(c);
  // FIT ride: heart rate every second, power every 2 s (with zeros), cadence every 3 s.
  const ride = straightTrack({ speedMps: 8, durationSeconds: 240, startTime: T });
  const ridePts: FitPoint[] = ride.map((sample, i) => ({
    sample,
    hr: 125 + (i % 30),
    ...(i % 2 === 0 ? { watts: i % 20 === 0 ? 0 : 190 + (i % 17) } : {}),
    ...(i % 3 === 0 ? { cadence: 89.5 } : {}),
  }));
  await svc.importTrack(
    parseFit(
      fitActivity({
        sessions: [{ sport: SPORT.cycling, laps: [[ridePts.slice(0, 120)], [ridePts.slice(120)]] }],
      }),
    )[0]!,
    { timezone: 'UTC' },
  );
  // TCX run: two laps, a pause inside the first lap, run cadence.
  const a = straightTrack({ speedMps: 3, durationSeconds: 120, startTime: T + DAY });
  const b = straightTrack({
    speedMps: 3,
    durationSeconds: 120,
    startTime: T + DAY + 180_000,
    start: after(a),
  });
  const c2 = straightTrack({
    speedMps: 3,
    durationSeconds: 120,
    startTime: T + DAY + 301_000,
    start: after(b),
  });
  await svc.importTrack(
    parseTcx(
      garminTcx({
        sport: 'Running',
        runCadence: true,
        laps: [
          {
            tracks: [
              withSensors(a, { hr: true, cadence: 82 }),
              withSensors(b, { hr: true, cadence: 83 }),
            ],
          },
          { tracks: [withSensors(c2, { hr: true, cadence: 84 })] },
        ],
      }),
    )[0]!,
    { timezone: 'UTC' },
  );
  // GPX walk with heart rate only.
  const w = straightTrack({ speedMps: 1.4, durationSeconds: 300, startTime: T + 2 * DAY });
  await svc.importTrack(
    parseGpxTrack(
      stravaGpx({ name: 'Walk', type: 'walking', points: withSensors(w, { hr: true }) }),
    ),
    { timezone: 'UTC' },
  );
  // FIT triathlon.
  await svc.importTrack(parseFit(triathlon(T + 3 * DAY))[0]!, { timezone: 'UTC' });
  return c;
}

describe('cross-format fidelity through backup format 2', () => {
  it.each([
    ['encrypted', PASS],
    ['plain', null],
  ] as const)(
    'FIT, TCX, GPX and a triathlon survive a %s backup and restore exactly',
    async (_, key) => {
      const src = await mixedHistory();
      const before = await snapshot(src);
      expect(before).toHaveLength(4);
      // The history really has what we claim to check.
      expect(before[3]!.legs).toHaveLength(5);
      expect(
        before[1]!.events.some((e) => (e as { event_type: string }).event_type === 'paused'),
      ).toBe(true);

      const { bytes } = await new BackupService(src, '0.2.0').createBackup(key);
      const dst = await db('5002');
      const svc = new BackupService(dst, '0.2.0');
      const report = await svc.restore(svc.open(bytes, key));
      expect(report).toMatchObject({
        formatVersion: 2,
        restored: 4,
        failed: [],
        otherFailures: [],
      });
      expect(report.sensorSamplesRestored).toBe(
        await one(src, 'SELECT COUNT(*) n FROM sensor_samples'),
      );
      expect(await snapshot(dst)).toEqual(before);
    },
  );
});

describe('strict documents', () => {
  const code = (f: () => unknown) => {
    try {
      f();
      return 'accepted';
    } catch (e) {
      return e instanceof BackupError ? e.code : `other: ${(e as Error).message}`;
    }
  };
  const gz = (json: string) => {
    const magic = [0x50, 0x41, 0x43, 0x45, 0x42, 0x4b, 0x01];
    return Uint8Array.from([...magic, ...gzipSync(strToU8(json))]);
  };

  it('refuses fields it does not know, at every level of the document', async () => {
    const src = await mixedHistory();
    const { document } = await new BackupService(src, '0.2.0').createBackup(null);
    for (const changed of [
      { ...document, extra: 1 },
      { ...document, counts: { ...document.counts, extra: 1 } },
      { ...document, payload: { ...document.payload, extra: [] } },
    ])
      expect(code(() => parseBackup(serializeBackup(changed as never)))).toBe('invalid_format');
  });

  it('refuses an empty file, empty JSON, a non-object and deep nesting without crashing', () => {
    expect(code(() => parseBackup(new Uint8Array()))).toBe('invalid_format');
    expect(code(() => parseBackup(gz('')))).toBe('invalid_format');
    expect(code(() => parseBackup(gz('{}')))).toBe('invalid_format');
    expect(code(() => parseBackup(gz('[]')))).toBe('invalid_format');
    expect(code(() => parseBackup(gz('null')))).toBe('invalid_format');
    const deep = 200_000;
    expect(code(() => parseBackup(gz('['.repeat(deep) + ']'.repeat(deep))))).toBe('invalid_format');
  });
});

describe('settings security', () => {
  /** A version-1 document as an old or hostile backup could contain it (restore() input). */
  const v1With = (settings: Array<{ key: string; value: string }>): BackupDocumentV1 => ({
    format: 'pace-backup',
    formatVersion: 1,
    createdAt: T,
    appVersion: '0.1.0',
    schemaVersion: 3,
    counts: { activities: 0, samples: 0, events: 0 },
    payloadSha256: '0'.repeat(64),
    payload: { activities: [], samples: [], events: [], laps: [], goals: [], settings },
  });

  it('applies only valid portable settings and never touches anything else', async () => {
    const dst = await db('6001');
    const settings = new SettingsRepository(dst);
    await settings.set('onboarding.completed', true);
    await dst.db.run(
      "INSERT INTO settings (key, value, updated_at) VALUES ('secure:supabase.auth.token', 'LOCAL', 1)",
    );
    const report = await new BackupService(dst, '0.2.0').restore(
      v1With([
        { key: 'secure:supabase.auth.token', value: 'FROM-BACKUP' },
        { key: 'secure:other', value: 'x' },
        { key: 'onboarding.completed', value: 'false' },
        { key: '__proto__', value: '{"polluted":true}' },
        { key: 'constructor', value: '{}' },
        { key: 'PREFERENCES', value: '{"measurementSystem":"imperial"}' },
        { key: 'preferences ', value: '{"measurementSystem":"imperial"}' },
        { key: 'profile', value: 'not json' },
        // Valid, with an unknown field and a prototype-pollution attempt: both are dropped.
        {
          key: 'preferences',
          value: '{"measurementSystem":"imperial","__proto__":{"polluted":true},"apiKey":"s3cret"}',
        },
        // A second 'preferences' never overrides the first.
        { key: 'preferences', value: '{"measurementSystem":"metric"}' },
      ]),
    );
    expect(report.settingsRestored).toEqual(['preferences']);
    expect(report.settingsIgnored).toBe(9);
    expect(await settings.get('preferences')).toEqual({ measurementSystem: 'imperial' });
    expect(await settings.get('onboarding.completed')).toBe(true);
    expect(
      (await dst.db.get<{ value: string }>(
        "SELECT value FROM settings WHERE key = 'secure:supabase.auth.token'",
      ))!.value,
    ).toBe('LOCAL');
    expect(await one(dst, "SELECT COUNT(*) n FROM settings WHERE key = 'secure:other'")).toBe(0);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(await one(dst, "SELECT COUNT(*) n FROM settings WHERE value LIKE '%s3cret%'")).toBe(0);
  });
});

describe('restore atomicity at every write stage', () => {
  async function backupOfTwo() {
    const src = await db('7001');
    const svc = new ActivityService(src);
    for (const day of [0, 1]) {
      const pts = straightTrack({ speedMps: 3, durationSeconds: 120, startTime: T + day * DAY });
      await svc.importTrack(
        parseFit(
          fitActivity({
            sessions: [
              {
                sport: SPORT.running,
                laps: [
                  [fitPoints(pts.slice(0, 60), { hr: true })],
                  [fitPoints(pts.slice(60), { hr: true })],
                ],
              },
            ],
          }),
        )[0]!,
        { timezone: 'UTC' },
      );
    }
    await new SettingsRepository(src).set('preferences', { measurementSystem: 'imperial' });
    return (await new BackupService(src, '0.2.0').createBackup(null)).document;
  }
  const refuse = (table: string, when = '1') =>
    `CREATE TRIGGER refuse_${table} BEFORE INSERT ON ${table} WHEN ${when} BEGIN SELECT RAISE(ABORT, 'refused'); END`;

  it.each([
    ['activity row', 'activities'],
    ['GPS points', 'route_points'],
    ['recording events', 'recording_events'],
    ['laps', 'laps'],
    ['sensor samples', 'sensor_samples'],
  ])('a failure while writing %s leaves no trace of that activity', async (_, table) => {
    const doc = await backupOfTwo();
    const second = doc.payload.activities[1]!.id;
    const dst = await db('7002');
    const col = table === 'activities' ? 'id' : 'activity_id';
    await dst.db.exec(refuse(table, `NEW.${col} = '${second}'`));
    const report = await new BackupService(dst, '0.2.0').restore(doc);
    expect(report.restored).toBe(1);
    expect(report.failed.map((f) => f.activityId)).toEqual([second]);
    for (const t of [
      'route_points',
      'recording_events',
      'laps',
      'sensor_samples',
      'activity_splits',
    ])
      expect(await one(dst, `SELECT COUNT(*) n FROM ${t} WHERE activity_id = '${second}'`)).toBe(0);
    expect(await one(dst, `SELECT COUNT(*) n FROM activities WHERE id = '${second}'`)).toBe(0);
    expect(await dst.db.all('PRAGMA foreign_key_check')).toEqual([]);
  });

  it('a failure while writing settings is reported; restored activities are kept', async () => {
    const doc = await backupOfTwo();
    const dst = await db('7003');
    await dst.db.exec(refuse('settings'));
    const report = await new BackupService(dst, '0.2.0').restore(doc);
    expect(report.restored).toBe(2);
    expect(report.settingsRestored).toEqual([]);
    expect(report.otherFailures).toEqual([
      { part: 'settings', reason: expect.stringMatching(/refused/) },
    ]);
    // Running the restore again completes it once the cause is gone.
    await dst.db.exec('DROP TRIGGER refuse_settings');
    const again = await new BackupService(dst, '0.2.0').restore(doc);
    expect(again).toMatchObject({
      restored: 0,
      skippedExisting: 2,
      settingsRestored: ['preferences'],
      otherFailures: [],
    });
  });
});
