/**
 * Backup format 2 (M4.8): sensor samples and portable settings survive backup and restore;
 * format-1 backups made by earlier PACE versions still restore; damaged, foreign and future
 * backups are refused; a restore that fails for one activity leaves nothing of it behind.
 * Everything runs through the real BackupService, encryption and SQLite.
 */
import { BackupError, MAX_BACKUP_JSON_BYTES, parseBackup, serializeBackup } from '@pace/backup';
import {
  type DatabaseContext,
  GoalRepository,
  SettingsRepository,
  configureConnection,
  migrate,
} from '@pace/database';
import { parseFit } from '@pace/formats';
import { hexToBytes } from '@noble/hashes/utils';
import { gzipSync, strToU8 } from 'fflate';
import { NodeSqliteDriver } from '../../database/src/test-fixtures/node-sqlite-driver';
import { type FitPoint, SPORT, fitActivity } from '../../formats/src/test-fixtures/fit-encoder';
import { straightTrack } from '../../gps-engine/src/test-fixtures/synthetic-track';
import { ActivityService, BackupService } from './index';
import { V1_FIXTURE } from './test-fixtures/v1-backups';

const T = Date.UTC(2026, 10, 7, 7, 0);
const PASS = { kind: 'passphrase' as const, passphrase: 'a long backup passphrase' };
// Low scrypt cost keeps the suite fast; the production default is tested in @pace/backup.

async function db(prefix = 'a'): Promise<DatabaseContext> {
  const d = new NodeSqliteDriver();
  await configureConnection(d);
  await migrate(d);
  let n = 0;
  const hex = prefix.charCodeAt(0).toString(16).padStart(4, '0');
  return {
    db: d,
    now: () => T,
    newId: () => `00000000-${hex}-4000-8000-${String(++n).padStart(12, '0')}`,
  };
}

const all = <R>(c: DatabaseContext, sql: string, params: Array<string | number> = []) =>
  c.db.all<R>(sql, params);
const one = async (c: DatabaseContext, sql: string) => (await c.db.get<{ n: number }>(sql))!.n;

/** Everything a restore must reproduce exactly, per activity id. */
async function snapshot(c: DatabaseContext) {
  const activities = await all<{ id: string }>(c, 'SELECT id FROM activities ORDER BY id');
  const out: Record<string, unknown> = {};
  for (const { id } of activities) {
    out[id] = {
      activity: await all(
        c,
        `SELECT sport_type, title, started_at, ended_at, timezone, status, source, elapsed_duration_ms,
           moving_duration_ms, distance_meters, elevation_gain_meters FROM activities WHERE id = ?`,
        [id],
      ),
      points: await all(
        c,
        'SELECT sequence_number, latitude, longitude, altitude_meters, recorded_at FROM route_points WHERE activity_id = ? ORDER BY sequence_number',
        [id],
      ),
      events: await all(
        c,
        'SELECT sequence_number, event_type, occurred_at FROM recording_events WHERE activity_id = ? ORDER BY sequence_number',
        [id],
      ),
      laps: await all(
        c,
        'SELECT sequence_number, started_at, duration_ms, distance_meters FROM laps WHERE activity_id = ? ORDER BY sequence_number',
        [id],
      ),
      // Stored order (rowid), exact values and times.
      sensors: await all(
        c,
        'SELECT sensor_type, value, unit, recorded_at, source_device_id FROM sensor_samples WHERE activity_id = ? ORDER BY rowid',
        [id],
      ),
    };
  }
  return out;
}

/** A ride with every kind of sensor stream, two laps and a timer pause. */
function ride(start: number): Uint8Array {
  const a = straightTrack({ speedMps: 8, durationSeconds: 90, startTime: start });
  const b = straightTrack({
    speedMps: 8,
    durationSeconds: 90,
    startTime: start + 120_000,
    start: { latitude: a.at(-1)!.latitude, longitude: a.at(-1)!.longitude },
  });
  const pts = (s: typeof a, off: number): FitPoint[] =>
    s.map((sample, i) => {
      const k = i + off;
      return {
        sample,
        hr: 120 + (k % 40), // every second
        ...(k % 4 === 0 ? { cadence: k % 12 === 0 ? 0 : 87.5 } : {}), // sparse, zeros, fractional
        ...(k >= 30 && k < 50 ? {} : { watts: k % 10 === 0 ? 0 : 180 + (k % 23) }), // dropout, zeros
      };
    });
  return fitActivity({
    sessions: [
      {
        sport: SPORT.cycling,
        laps: [[pts(a, 0)], [pts(b.slice(0, 40), 90), pts(b.slice(55), 145)]],
      },
    ],
  });
}

/** A run with GPS only: an empty sensor stream. */
function plainRun(start: number): Uint8Array {
  const s = straightTrack({ speedMps: 3, durationSeconds: 120, startTime: start });
  return fitActivity({
    sessions: [{ sport: SPORT.running, laps: [[s.map((sample) => ({ sample }))]] }],
  });
}

const PREFS = {
  measurementSystem: 'imperial',
  exportPrivacyZoneMeters: 200,
  autoPause: { cycling: true },
  lastSport: 'cycling',
  poolLengthMeters: 25,
};
const PROFILE = {
  displayName: 'Test Rider',
  preferredSports: ['cycling'],
  heightCm: 180,
  weightKg: 72,
};

async function source(): Promise<DatabaseContext> {
  const c = await db('s');
  const svc = new ActivityService(c);
  for (const bytes of [ride(T), plainRun(T + 86_400_000)])
    await svc.importTrack(parseFit(bytes)[0]!, { timezone: 'Europe/Zurich' });
  await new GoalRepository(c).create({
    goalType: 'distance',
    targetValue: 100_000,
    period: 'week',
    sportType: 'cycling',
  });
  const settings = new SettingsRepository(c);
  await settings.set('preferences', PREFS);
  await settings.set('profile', PROFILE);
  await settings.set('onboarding.completed', true);
  // An encrypted auth-session row, as the app's encrypted key-value store writes it.
  await c.db.run(
    'INSERT INTO settings (key, value, updated_at) VALUES (\'secure:supabase.auth.token\', \'{"n":"00","c":"ff"}\', 1)',
  );
  return c;
}

describe('backup format 2: round trip through BackupService', () => {
  it('restores activities, GPS, laps, pauses and every sensor sample exactly', async () => {
    const src = await source();
    const { bytes, document } = await new BackupService(src, '0.2.0').createBackup(PASS);
    expect(document.formatVersion).toBe(2);
    expect(document.counts.sensorSamples).toBe(
      await one(src, 'SELECT COUNT(*) n FROM sensor_samples'),
    );

    const dst = await db('d');
    const svc = new BackupService(dst, '0.2.0');
    const report = await svc.restore(svc.open(bytes, PASS));
    expect(report).toMatchObject({
      formatVersion: 2,
      restored: 2,
      skippedExisting: 0,
      failed: [],
      goalsRestored: 1,
    });
    expect(report.sensorSamplesRestored).toBe(document.counts.sensorSamples);
    expect(await snapshot(dst)).toEqual(await snapshot(src));
  });

  it('keeps zeros, fractional values, sparse streams, dropouts and empty streams as they were', async () => {
    const src = await source();
    const { bytes } = await new BackupService(src, '0.2.0').createBackup(null);
    const dst = await db('d');
    const svc = new BackupService(dst, '0.2.0');
    await svc.restore(svc.open(bytes, null));
    const q = (c: DatabaseContext, where: string) =>
      one(c, `SELECT COUNT(*) n FROM sensor_samples WHERE ${where}`);
    for (const where of [
      "sensor_type = 'cadence' AND value = 0",
      "sensor_type = 'cadence' AND value = 87.5",
      "sensor_type = 'power' AND value = 0",
      "sensor_type = 'heart_rate'",
    ]) {
      expect(await q(src, where)).toBeGreaterThan(0);
      expect(await q(dst, where)).toBe(await q(src, where));
    }
    // The run had no sensors, and still has none: nothing is invented.
    const run = await one(
      dst,
      "SELECT COUNT(*) n FROM sensor_samples s JOIN activities a ON a.id = s.activity_id WHERE a.sport_type = 'running'",
    );
    expect(run).toBe(0);
  });

  it('backs up and restores only the portable settings, never the auth session', async () => {
    const src = await source();
    const { document } = await new BackupService(src, '0.2.0').createBackup(null);
    expect(document.payload.settings.map((s) => s.key)).toEqual(['preferences', 'profile']);
    expect(JSON.stringify(document)).not.toMatch(/secure:|onboarding/);

    // The new phone already has its own (different) preferences: restore brings the backup's back.
    const dst = await db('d');
    await new SettingsRepository(dst).set('preferences', { measurementSystem: 'metric' });
    const svc = new BackupService(dst, '0.2.0');
    const report = await svc.restore(svc.open(serializeBackup(document), null));
    expect(report.settingsRestored).toEqual(['preferences', 'profile']);
    const settings = new SettingsRepository(dst);
    expect(await settings.get('preferences')).toEqual(PREFS);
    expect(await settings.get('profile')).toEqual(PROFILE);
    expect(await one(dst, "SELECT COUNT(*) n FROM settings WHERE key LIKE 'secure:%'")).toBe(0);
    expect(await settings.get('onboarding.completed')).toBeNull();
  });

  it('is additive: activities already on the phone are kept, with their own sensors', async () => {
    const src = await source();
    const { bytes } = await new BackupService(src, '0.2.0').createBackup(null);
    const svc = new BackupService(src, '0.2.0');
    const before = await snapshot(src);
    const report = await svc.restore(svc.open(bytes, null));
    expect(report).toMatchObject({ restored: 0, skippedExisting: 2, sensorSamplesRestored: 0 });
    expect(await snapshot(src)).toEqual(before);
  });
});

describe('backup format 1: backups from earlier PACE versions', () => {
  const open = (hex: string, key: typeof PASS | null) => {
    const svc = new BackupService(undefined as never, '0.2.0');
    return svc.open(hexToBytes(hex), key);
  };

  it('opens a genuine version-1 backup as version 1, never as version 2', () => {
    const doc = open(V1_FIXTURE.encryptedHex, {
      kind: 'passphrase',
      passphrase: V1_FIXTURE.passphrase,
    });
    expect(doc.formatVersion).toBe(1);
    expect('sensorSamples' in doc.payload).toBe(false);
    expect(doc.payload.settings.map((s) => s.key)).toEqual(V1_FIXTURE.settingsKeysInBackup);
  });

  it.each([
    ['encrypted', 'encryptedHex'],
    ['plain', 'plainHex'],
  ] as const)(
    'restores a %s version-1 backup completely (it has no sensor samples)',
    async (_, field) => {
      const dst = await db('d');
      const svc = new BackupService(dst, '0.2.0');
      const key =
        field === 'encryptedHex'
          ? { kind: 'passphrase' as const, passphrase: V1_FIXTURE.passphrase }
          : null;
      const report = await svc.restore(svc.open(hexToBytes(V1_FIXTURE[field]), key));
      expect(report).toMatchObject({
        formatVersion: 1,
        restored: 1,
        failed: [],
        goalsRestored: 1,
        sensorSamplesRestored: 0,
        settingsRestored: ['preferences', 'profile'],
        settingsIgnored: 1, // the encrypted auth-session row in the V1 backup
      });
      const s = V1_FIXTURE.source;
      expect(await one(dst, 'SELECT COUNT(*) n FROM activities')).toBe(s.activities);
      expect(await one(dst, 'SELECT COUNT(*) n FROM route_points')).toBe(s.routePoints);
      expect(await one(dst, 'SELECT COUNT(*) n FROM laps')).toBe(s.laps);
      expect(
        await one(dst, "SELECT COUNT(*) n FROM recording_events WHERE event_type = 'paused'"),
      ).toBe(s.pauses);
      expect(await one(dst, 'SELECT distance_meters n FROM activities')).toBe(s.distanceMeters);
      expect(
        await one(dst, "SELECT COUNT(*) n FROM activities WHERE source = 'imported_fit'"),
      ).toBe(1);
      expect(await one(dst, 'SELECT COUNT(*) n FROM sensor_samples')).toBe(0);
      expect(await one(dst, "SELECT COUNT(*) n FROM settings WHERE key LIKE 'secure:%'")).toBe(0);
    },
  );
});

describe('refusing invalid, damaged and future backups', () => {
  async function v2Document() {
    const src = await source();
    return (await new BackupService(src, '0.2.0').createBackup(null)).document;
  }
  const code = (f: () => unknown): string => {
    try {
      f();
    } catch (e) {
      return e instanceof BackupError ? e.code : `other: ${(e as Error).message}`;
    }
    return 'accepted';
  };

  it('refuses unknown, missing and future format versions', async () => {
    const doc = await v2Document();
    for (const [version, expected] of [
      [3, 'unsupported_version'],
      [99, 'unsupported_version'],
      [0, 'invalid_format'],
      [-1, 'invalid_format'],
      [1.5, 'invalid_format'],
      ['2', 'invalid_format'],
      [undefined, 'invalid_format'],
    ] as const)
      expect([
        version,
        code(() => parseBackup(serializeBackup({ ...doc, formatVersion: version } as never))),
      ]).toEqual([version, expected]);
  });

  it('refuses a version-2 backup that claims to be version 1, or the reverse', async () => {
    const doc = await v2Document();
    expect(code(() => parseBackup(serializeBackup({ ...doc, formatVersion: 1 } as never)))).toBe(
      'invalid_format',
    );
    const v1 = new BackupService(undefined as never, '0.2.0').open(
      hexToBytes(V1_FIXTURE.plainHex),
      null,
    );
    expect(code(() => parseBackup(serializeBackup({ ...v1, formatVersion: 2 } as never)))).toBe(
      'invalid_format',
    );
  });

  it('refuses inconsistent version-2 contents', async () => {
    const doc = await v2Document();
    const variants: Array<[string, unknown]> = [
      [
        'counts mismatch',
        { ...doc, counts: { ...doc.counts, sensorSamples: doc.counts.sensorSamples + 1 } },
      ],
      [
        'sensor sample of a missing activity',
        {
          ...doc,
          payload: {
            ...doc.payload,
            sensorSamples: [
              {
                ...doc.payload.sensorSamples[0]!,
                activityId: '00000000-0000-4000-8000-0000000000ff',
              },
              ...doc.payload.sensorSamples.slice(1),
            ],
          },
        },
      ],
      [
        'unit not matching the sensor',
        {
          ...doc,
          payload: {
            ...doc.payload,
            sensorSamples: [
              { ...doc.payload.sensorSamples[0]!, unit: 'W' },
              ...doc.payload.sensorSamples.slice(1),
            ],
          },
        },
      ],
      [
        'a non-portable setting',
        { ...doc, payload: { ...doc.payload, settings: [{ key: 'secure:x', value: '{}' }] } },
      ],
    ];
    for (const [name, v] of variants)
      expect([name, code(() => parseBackup(serializeBackup(v as never)))]).toEqual([
        name,
        'invalid_format',
      ]);
  });

  it('detects changed contents through the checksum', async () => {
    const doc = await v2Document();
    const changed = structuredClone(doc);
    changed.payload.sensorSamples[0]!.value += 1;
    expect(code(() => parseBackup(serializeBackup(changed)))).toBe('checksum_mismatch');
  });

  it('refuses truncated, corrupted and foreign files', async () => {
    const bytes = serializeBackup(await v2Document());
    expect(code(() => parseBackup(bytes.slice(0, Math.floor(bytes.length / 2))))).toBe(
      'invalid_format',
    );
    const corrupt = bytes.slice();
    corrupt[corrupt.length - 20] ^= 0xff;
    expect(code(() => parseBackup(corrupt))).not.toBe('accepted');
    expect(code(() => parseBackup(strToU8('not a backup')))).toBe('invalid_format');
  });

  it('stops a decompression bomb by the bytes it produces, not by what the file claims', () => {
    const magic = new Uint8Array([0x50, 0x41, 0x43, 0x45, 0x42, 0x4b, 0x01]);
    const bomb = gzipSync(new Uint8Array(8 * 1024 * 1024)); // 8 MB of zeros, ~8 KB compressed
    const file = new Uint8Array(magic.length + bomb.length);
    file.set(magic);
    file.set(bomb, magic.length);
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect(code(() => parseBackup(file, { maxJsonBytes: 1024 * 1024 }))).toBe('too_large');
    // The limit can be lowered for a caller, never raised above the built-in maximum.
    expect(MAX_BACKUP_JSON_BYTES).toBe(512 * 1024 * 1024);
  });

  it('never writes a backup that restore would refuse', async () => {
    const src = await source();
    await src.db.run(
      'UPDATE sensor_samples SET value = 5000 WHERE rowid = (SELECT MIN(rowid) FROM sensor_samples)',
    );
    await expect(new BackupService(src, '0.2.0').createBackup(null)).rejects.toMatchObject({
      code: 'invalid_format',
    });
  });
});

describe('restore is atomic per activity', () => {
  it('a failure while writing one activity leaves nothing of it, and others restore', async () => {
    const src = await source();
    const { bytes } = await new BackupService(src, '0.2.0').createBackup(null);
    const dst = await db('d');
    // Make the database refuse power samples, to fail mid-transaction (after the activity row,
    // its points and events were written).
    await dst.db.exec(
      "CREATE TRIGGER no_power BEFORE INSERT ON sensor_samples WHEN NEW.sensor_type = 'power' BEGIN SELECT RAISE(ABORT, 'refused'); END",
    );
    const svc = new BackupService(dst, '0.2.0');
    const report = await svc.restore(svc.open(bytes, null));
    expect(report.restored).toBe(1); // the run (no power)
    expect(report.failed).toHaveLength(1); // the ride
    const failedId = report.failed[0]!.activityId;
    for (const table of ['route_points', 'recording_events', 'laps', 'sensor_samples'])
      expect(
        await one(dst, `SELECT COUNT(*) n FROM ${table} WHERE activity_id = '${failedId}'`),
      ).toBe(0);
    expect(await one(dst, `SELECT COUNT(*) n FROM activities WHERE id = '${failedId}'`)).toBe(0);
    expect(await dst.db.all('PRAGMA foreign_key_check')).toEqual([]);
  });
});
