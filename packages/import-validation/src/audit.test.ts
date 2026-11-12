/**
 * Regression tests for the M4.7 harness audit (docs/IMPORT_VALIDATION.md, "Audit"). Each test
 * names the finding it covers.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ARCHIVE_LIMITS, bytesSource } from '@pace/formats';
import { configureConnection, migrate } from '@pace/database';
import { strToU8, zipSync } from 'fflate';
import { stravaGpx, withSensors } from '../../formats/src/test-fixtures/device-files';
import {
  type ActivityMetrics,
  type ArchiveSummary,
  type Check,
  MemorySqliteDriver,
  Secrets,
  findRepoRoot,
  isInside,
  pipelineChecks,
  runCli,
  validateActivity,
  validateArchive,
} from './index';
import {
  otherRunGpx,
  pausedA,
  pausedB,
  pausedC,
  pausedFit,
  pausedTcx,
  runFit,
  runLap1,
  runLap2,
  triathlonFit,
} from './test-fixtures/activities';
import { garminTcx } from '../../formats/src/test-fixtures/device-files';

const byMetric = (checks: Check[], metric: string): Check => {
  const c = checks.find((x) => x.metric === metric);
  if (!c) throw new Error(`no check "${metric}" in: ${checks.map((x) => x.metric).join(', ')}`);
  return c;
};

describe('audit A: import isolation', () => {
  it('A1: a companion that names no sport is still compared, using the FIT’s sport', async () => {
    const gpx = stravaGpx({
      name: 'Run',
      type: 'gravel_unknown',
      points: [
        ...withSensors(runLap1, { hr: true, cadence: 86 }),
        ...withSensors(runLap2, { hr: true, cadence: 88 }),
      ],
    });
    const [r] = await validateActivity(
      { id: 'V1', fit: runFit(), companions: [{ format: 'gpx', text: gpx }], expect: {} },
      new Secrets(),
    );
    expect(byMetric(r!.checks, 'GPX sport')).toMatchObject({
      status: 'PASS',
      reference: 'running',
    });
    expect(byMetric(r!.checks, 'distance (GPX)').status).toBe('PASS');
    expect(byMetric(r!.checks, 'moving time (GPX)').status).toBe('PASS');
    // Duplicate detection still sees it as the same activity, not as "choose a sport".
    expect(byMetric(r!.checks, 'duplicate detection (FIT then GPX)').status).toBe('PASS');
    expect(r!.status).toBe('PASS');
  });

  it('A2: every import of a scenario runs in its own database (FIT and companion both import)', async () => {
    const [r] = await validateActivity(
      {
        id: 'V2',
        fit: pausedFit(),
        companions: [{ format: 'tcx', text: pausedTcx() }],
        expect: {},
      },
      new Secrets(),
    );
    // Both PACE results exist, so the processing tier compared them instead of skipping.
    expect(
      r!.checks
        .filter((c) => c.tier === 'pipeline' && c.status === 'NOT TESTED')
        .map((c) => c.metric),
    ).toEqual(['stored cadence samples (TCX)', 'stored power samples (TCX)']);
  });
});

describe('audit B: harness database behaves like the app database', () => {
  async function db(): Promise<MemorySqliteDriver> {
    const d = new MemorySqliteDriver();
    await configureConnection(d);
    await migrate(d);
    return d;
  }
  const insert = (d: MemorySqliteDriver, id: string, source = 'imported_fit') =>
    d.run(
      `INSERT INTO activities (id, sport_type, title, started_at, timezone, status, source, created_at, updated_at)
       VALUES (?, 'running', 't', 0, 'UTC', 'completed', ?, 0, 0)`,
      [id, source],
    );

  it('B1: foreign keys are enforced and cascade', async () => {
    const d = await db();
    expect((await d.get<{ foreign_keys: number }>('PRAGMA foreign_keys'))!.foreign_keys).toBe(1);
    await expect(
      d.run(
        "INSERT INTO laps (id, activity_id, sequence_number, started_at, duration_ms, distance_meters) VALUES ('l', 'missing', 0, 0, 0, 0)",
      ),
    ).rejects.toThrow(/FOREIGN KEY/);
    await insert(d, 'a1');
    await d.run(
      "INSERT INTO laps (id, activity_id, sequence_number, started_at, duration_ms, distance_meters) VALUES ('l', 'a1', 0, 0, 0, 0)",
    );
    await d.run("DELETE FROM activities WHERE id = 'a1'");
    expect((await d.get<{ n: number }>('SELECT COUNT(*) AS n FROM laps'))!.n).toBe(0);
  });

  it('B2: CHECK constraints are enforced', async () => {
    const d = await db();
    await expect(insert(d, 'bad', 'imported_zwift')).rejects.toThrow(/CHECK/);
  });

  it('B3: a failed transaction rolls back completely, and the connection stays usable', async () => {
    const d = await db();
    await expect(
      d.transaction(async (tx) => {
        await insert(tx as MemorySqliteDriver, 'a1');
        await insert(tx as MemorySqliteDriver, 'a1'); // primary-key violation
      }),
    ).rejects.toThrow(/UNIQUE|PRIMARY/);
    expect((await d.get<{ n: number }>('SELECT COUNT(*) AS n FROM activities'))!.n).toBe(0);
    await d.transaction(async (tx) => insert(tx as MemorySqliteDriver, 'a2'));
    expect((await d.get<{ n: number }>('SELECT COUNT(*) AS n FROM activities'))!.n).toBe(1);
  });

  it('B4: nested transactions are refused, as in the app driver', async () => {
    const d = await db();
    await expect(d.transaction(async (tx) => tx.transaction(async () => 1))).rejects.toThrow(
      /Nested/,
    );
    expect(await d.transaction(async () => 7)).toBe(7);
  });
});

describe('audit C: comparison correctness', () => {
  it('C1: pause boundaries are compared between formats, and a moved pause fails', async () => {
    const ok = await validateActivity(
      {
        id: 'V2',
        fit: pausedFit(),
        companions: [{ format: 'tcx', text: pausedTcx() }],
        expect: {},
      },
      new Secrets(),
    );
    expect(byMetric(ok[0]!.checks, 'segment boundaries (TCX)').status).toBe('PASS');
    // The TCX resumes 10 s later than the FIT: same segment count, different boundary.
    const late = garminTcx({
      sport: 'Running',
      laps: [
        {
          tracks: [
            withSensors(pausedA, { hr: true }),
            withSensors(pausedB.slice(10), { hr: true }),
          ],
        },
        { tracks: [withSensors(pausedC, { hr: true })] },
      ],
    });
    const [r] = await validateActivity(
      { id: 'V2', fit: pausedFit(), companions: [{ format: 'tcx', text: late }], expect: {} },
      new Secrets(),
    );
    const b = byMetric(r!.checks, 'segment boundaries (TCX)');
    expect(b.status).toBe('FAIL');
    expect(b.difference).toBe(10);
  });

  it('C2: lap starts are not paired by index when lap counts differ', async () => {
    const oneLap = garminTcx({
      sport: 'Running',
      laps: [{ tracks: [withSensors([...runLap1, ...runLap2], { hr: true, cadence: 86 })] }],
    });
    const [r] = await validateActivity(
      { id: 'V1', fit: runFit(), companions: [{ format: 'tcx', text: oneLap }], expect: {} },
      new Secrets(),
    );
    expect(byMetric(r!.checks, 'lap count (TCX)').status).toBe('FAIL');
    expect(byMetric(r!.checks, 'lap start times (TCX)').status).toBe('NOT TESTED');
  });

  it('C3: a different number of stored pauses is a FAIL, not a crash', () => {
    const m = (pauses: number): ActivityMetrics => ({
      sport: 'running',
      startedAt: 0,
      endedAt: 100_000,
      elapsedSeconds: 100,
      movingSeconds: 90,
      distanceMeters: 300,
      laps: [],
      pauses: Array.from({ length: pauses }, (_, i) => ({
        pausedAt: i * 10_000,
        resumedAt: i * 10_000 + 5000,
      })),
      legs: [],
      pointTimes: [0, 100_000],
      sensors: [],
    });
    const checks = pipelineChecks(m(2), m(1), 'TCX', true);
    expect(byMetric(checks, 'pause durations')).toMatchObject({
      status: 'FAIL',
      value: 2,
      reference: 1,
    });
  });

  it('C4: a multisport file’s device elapsed time includes the gaps between legs', async () => {
    const [r] = await validateActivity(
      { id: 'V8', fit: triathlonFit(), companions: [], expect: {} },
      new Secrets(),
    );
    const c = byMetric(r!.checks, 'elapsed time vs device total');
    expect(c.status).toBe('PASS');
    expect(c.value).toBe(c.reference);
  });
});

describe('audit D: privacy and repository safety', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pace-audit-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('D1: a report folder reached through a link into the repository is refused', async () => {
    const repo = findRepoRoot()!;
    const link = join(dir, 'linked');
    symlinkSync(join(repo, 'packages'), link, 'junction');
    expect(isInside(join(link, 'reports'), repo)).toBe(true);
    const lines: string[] = [];
    expect(await runCli([dir, '--out', join(link, 'reports')], { log: (l) => lines.push(l) })).toBe(
      2,
    );
    expect(lines.at(-1)).toMatch(/inside the repository/);
    // An exports folder that is itself a link into the repository is refused too.
    expect(await runCli([link], { log: (l) => lines.push(l) })).toBe(2);
  });

  it('D2: linked folders inside the exports folder are not followed', async () => {
    const repo = findRepoRoot()!;
    symlinkSync(join(repo, 'packages'), join(dir, 'into-repo'), 'junction');
    writeFileSync(join(dir, 'a.fit'), runFit());
    const lines: string[] = [];
    expect(await runCli([dir], { log: (l) => lines.push(l) })).toBe(0);
    const report = JSON.parse(
      readFileSync(join(dir, 'pace-validation-report', 'report.json'), 'utf8'),
    );
    expect(report.scenarios.map((s: { id: string }) => s.id)).toEqual(['F1']);
  });

  it('D3: one unreadable file fails its scenario without stopping the run or exposing its path', async () => {
    mkdirSync(join(dir, 'jane.doe@example.com_123.fit')); // a folder where a file is expected
    writeFileSync(join(dir, 'ok.fit'), runFit());
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        version: 1,
        scenarios: [
          { id: 'V1', file: 'jane.doe@example.com_123.fit' },
          { id: 'V2', file: 'ok.fit' },
        ],
      }),
    );
    const lines: string[] = [];
    const code = await runCli(
      [dir, '--manifest', join(dir, 'manifest.json'), '--out', join(dir, 'out')],
      {
        log: (l) => lines.push(l),
      },
    );
    expect(code).toBe(1);
    const json = readFileSync(join(dir, 'out', 'report.json'), 'utf8');
    const report = JSON.parse(json);
    expect(report.scenarios.map((s: { id: string; status: string }) => [s.id, s.status])).toEqual([
      ['V1', 'FAIL'],
      ['V2', 'PASS'],
    ]);
    expect(report.scenarios[0].checks[0].explanation).toMatch(/unexpected error/);
    for (const text of [json, lines.join('\n')])
      expect(text).not.toMatch(/jane|example\.com|pace-audit-/);
  });
});

describe('audit E: archive limits', () => {
  it('E1: the entry-count limit stops an archive with a warning and keeps a consistent database', async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 5; i++) files[`a/${i}.gpx`] = strToU8(otherRunGpx(300 + i));
    const zip = zipSync(files);
    const r = await validateArchive(
      {
        id: 'A1',
        extension: '.zip',
        open: () => bytesSource(zip, 2048),
        expect: {},
        limits: { ...DEFAULT_ARCHIVE_LIMITS, maxArchiveEntries: 3 },
      },
      new Secrets(),
    );
    const s = r.summary as unknown as ArchiveSummary;
    expect(s.sourceErrors).toBe(1);
    expect(s.limits.entries).toBe(3);
    expect(byMetric(r.checks, 'archive read completely').status).toBe('WARNING');
    expect(byMetric(r.checks, 'database consistent').status).toBe('PASS');
  });

  it('E2: an entry over the per-file limit is refused on its own; the others import', async () => {
    const small = strToU8(otherRunGpx(401));
    // Trailing whitespace after the document keeps it valid GPX but makes it larger.
    const big = strToU8(otherRunGpx(400) + ' '.repeat(50_000));
    const zip = zipSync({ 'big.gpx': big, 'small.gpx': small });
    const r = await validateArchive(
      {
        id: 'A2',
        extension: '.zip',
        open: () => bytesSource(zip, 2048),
        expect: { failed: 1 },
        limits: { ...DEFAULT_ARCHIVE_LIMITS, maxEntryBytes: small.length + 1000 },
      },
      new Secrets(),
    );
    const s = r.summary as unknown as ArchiveSummary;
    expect(Object.keys(s.failureReasons).join(' ')).toMatch(/possible ZIP bomb|more than/);
    expect(byMetric(r.checks, 'failed entries').status).toBe('PASS');
    expect(byMetric(r.checks, 'every entry accounted for').status).toBe('PASS');
  });
});
