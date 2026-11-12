import { NodeSqliteDriver } from '../../database/src/test-fixtures/node-sqlite-driver';
import { MIGRATIONS, configureConnection, migrate } from '@pace/database';
import {
  ManifestError,
  MemorySqliteDriver,
  PrivacyLeakError,
  Secrets,
  assertNoLeak,
  compareNumbers,
  expectNumber,
  overallStatus,
  parseManifest,
  scrub,
} from './index';

describe('privacy', () => {
  it('scrubs emails, paths, coordinates, identifiers, times and titles', () => {
    const s = new Secrets();
    s.addPath('C:\\Exports\\jane.doe@example.com_123456789.fit');
    const text =
      'Could not open C:\\Exports\\jane.doe@example.com_123456789.fit or /home/jane/runs/a.tcx: ' +
      'point 47.3769123, 8.5417234 by unit 3456789012 at 2026-10-04T06:30:00Z in “Run with Ann”; ' +
      'stem jane.doe@example.com_123456789';
    const out = scrub(text, s);
    expect(out).not.toMatch(/jane|example|123456789|47\.3769|8\.5417|3456789012|2026-10-04|Ann/i);
    expect(out).toContain('[redacted]');
    expect(out).toContain('[path]');
    expect(out).toContain('[number]');
    expect(out).toContain('[time]');
    expect(scrub('x'.repeat(1000)).length).toBeLessThanOrEqual(401);
  });

  it('folder names are scrubbed but ordinary words in report text do not block output', () => {
    const s = new Secrets();
    s.addPath('/Users/someone/exports', 'folder');
    s.addPath('/Users/someone/exports/report', 'folder');
    expect(() =>
      assertNoLeak('many exports drop channels; see report.json and report.md', s),
    ).not.toThrow();
    expect(() => assertNoLeak('stopped in /Users/someone/exports', s)).toThrow(PrivacyLeakError);
    expect(scrub('could not read exports', s)).toBe('could not read [redacted]');
    const named = new Secrets();
    named.addPath('/data/jane.doe@example.com', 'folder');
    expect(() => assertNoLeak('jane.doe@example.com', named)).toThrow(PrivacyLeakError);
  });

  it('keeps ordinary import messages readable', () => {
    const m =
      'Not imported: running dynamics and device name. 12 point(s) with invalid coordinates were skipped.';
    expect(scrub(m)).toBe(m);
  });

  it('blocks output containing secrets or personal-data patterns without echoing them', () => {
    const s = new Secrets();
    s.addPath('/data/exports/strava_98765432.fit.gz');
    s.addIdentifier(3999000111);
    const attempts = [
      'file strava_98765432.fit.gz failed',
      'unit 3999000111',
      'mail me at someone@example.org',
      'at 47.37691, 8.54172',
      'see /data/exports/x',
    ];
    for (const a of attempts) {
      let message = '';
      try {
        assertNoLeak(a, s);
      } catch (e) {
        expect(e).toBeInstanceOf(PrivacyLeakError);
        message = (e as Error).message;
      }
      expect(message).toMatch(/^Output withheld/);
      expect(message).not.toMatch(/98765432|3999000111|someone|47\.37|data\/exports/);
    }
    expect(() => assertNoLeak('V1 PASS imported, 1.95 km, 10.2 min', s)).not.toThrow();
  });
});

describe('scenario manifest', () => {
  const ok = {
    version: 1,
    scenarios: [
      {
        id: 'V1',
        file: 'garmin/run.fit',
        companion: 'garmin/run.tcx',
        expect: {
          sport: 'running',
          lapDistanceMeters: { approx: 1000, tolerance: 30 },
          sensors: { heart_rate: 'present', power: 'unknown' },
          pauses: 'unknown',
          laps: null,
        },
      },
      { id: 'V4b', file: 'edge/ride.fit.gz', expect: { sensors: { power: { min: 100 } } } },
      { id: 'A1', archive: 'export.zip', expect: { imported: { min: 1 }, failed: 0 } },
    ],
  };

  it('parses scenarios, companions and unknown expectations', () => {
    const m = parseManifest(JSON.stringify(ok));
    expect(m.scenarios.map((s) => s.id)).toEqual(['V1', 'V4b', 'A1']);
    expect(m.scenarios[0]).toMatchObject({ kind: 'activity', companions: ['garmin/run.tcx'] });
    expect(m.scenarios[2]).toMatchObject({ kind: 'archive', archive: 'export.zip' });
  });

  it.each([
    [{ ...ok, version: 2 }, /version/],
    [{ version: 1, scenarios: [{ id: 'Jane run', file: 'a.fit' }] }, /anonymous label/],
    [{ version: 1, scenarios: [{ id: 'V1', file: 'C:\\Users\\a.fit' }] }, /relative/],
    [{ version: 1, scenarios: [{ id: 'V1', file: '../a.fit' }] }, /relative/],
    [
      { version: 1, scenarios: [{ id: 'V1', file: 'a.fit', expect: { lapz: 1 } }] },
      /unknown expectation/,
    ],
    [
      { version: 1, scenarios: [{ id: 'V1', file: 'a.fit', expect: { laps: '3' } }] },
      /expected a number/,
    ],
    [
      {
        version: 1,
        scenarios: [{ id: 'V1', file: 'a.fit', expect: { sensors: { speed: 'present' } } }],
      },
      /unknown sensor/,
    ],
    [
      {
        version: 1,
        scenarios: [
          { id: 'V1', file: 'a.fit' },
          { id: 'V1', file: 'b.fit' },
        ],
      },
      /duplicate/,
    ],
    [{ version: 1, scenarios: [{ id: 'A1', archive: 'a.zip', file: 'b.fit' }] }, /exactly one/],
  ])('rejects invalid manifests (%#)', (m, error) => {
    expect(() => parseManifest(JSON.stringify(m))).toThrow(ManifestError);
    expect(() => parseManifest(JSON.stringify(m))).toThrow(error);
  });

  it('never reports a file path in a manifest error', () => {
    try {
      parseManifest(
        JSON.stringify({ version: 1, scenarios: [{ id: 'V1', file: '/home/jane/a.fit' }] }),
      );
    } catch (e) {
      expect((e as Error).message).not.toContain('jane');
    }
  });
});

describe('result classification', () => {
  it('unknown expectations are NOT TESTED, never a pass', () => {
    expect(expectNumber('laps', 3, 'unknown').status).toBe('NOT TESTED');
    expect(expectNumber('laps', 3, null).status).toBe('NOT TESTED');
    expect(expectNumber('laps', 3, undefined).status).toBe('NOT TESTED');
    expect(expectNumber('laps', 3, 3).status).toBe('PASS');
    expect(expectNumber('laps', 3, { equals: 4 }).status).toBe('FAIL');
    expect(expectNumber('d', 1010, { approx: 1000, tolerance: 10 }).status).toBe('PASS');
    expect(expectNumber('d', 1011, { approx: 1000, tolerance: 10 }).status).toBe('FAIL');
    expect(expectNumber('d', 5, { min: 1 }).status).toBe('PASS');
    expect(expectNumber('d', null, { min: 1 }).status).toBe('FAIL');
    expect(overallStatus([expectNumber('laps', 3, 'unknown')])).toBe('NOT TESTED');
  });

  it('applies absolute and relative tolerances and explains the result', () => {
    const base = {
      tier: 'pipeline' as const,
      metric: 'distance',
      absolute: 5,
      relative: 0.01,
      outside: 'FAIL' as const,
      unit: 'm',
      same: 'same',
      differs: 'differs',
      missing: 'missing',
    };
    expect(compareNumbers({ ...base, value: 1009, reference: 1000 }).status).toBe('PASS');
    const c = compareNumbers({ ...base, value: 1011, reference: 1000 });
    expect(c).toMatchObject({
      status: 'FAIL',
      difference: 11,
      tolerance: '±5 m or ±1%',
      explanation: 'differs',
    });
    expect(compareNumbers({ ...base, value: null, reference: 1000 }).status).toBe('NOT TESTED');
  });
});

describe('harness database', () => {
  it('runs the real migrations exactly like the database test driver', async () => {
    const a = new MemorySqliteDriver();
    const b = new NodeSqliteDriver();
    for (const db of [a, b]) {
      await configureConnection(db);
      await migrate(db);
    }
    const schema = (db: MemorySqliteDriver | NodeSqliteDriver) =>
      db.all(
        "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
      );
    expect(await schema(a)).toEqual(await schema(b));
    expect((await a.get<{ v: number }>('SELECT MAX(version) AS v FROM schema_migrations'))!.v).toBe(
      MIGRATIONS.length,
    );
    await expect(a.transaction(async (tx) => tx.transaction(async () => 1))).rejects.toThrow(
      /Nested/,
    );
  });
});
