import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ARCHIVE_LIMITS, bytesSource } from '@pace/formats';
import { gzipSync, strToU8, zipSync } from 'fflate';
import {
  type Check,
  type ArchiveSummary,
  Secrets,
  findRepoRoot,
  runCli,
  validateArchive,
} from './index';
import {
  FIXTURE_SERIAL,
  indoorFit,
  otherRunGpx,
  runFit,
  runGpx,
  runTcx,
} from './test-fixtures/activities';

const byMetric = (checks: Check[], metric: string): Check =>
  checks.find((c) => c.metric === metric)!;

/** A Garmin-style bulk export: file names carry the account email and activity IDs. */
const EMAIL = 'jane.doe@example.com';
function garminExport(): Uint8Array {
  return zipSync({
    [`DI_CONNECT/DI-Connect-Uploaded-Files/${EMAIL}_123456789.fit`]: runFit(),
    // The same activity again as TCX: a duplicate.
    [`DI_CONNECT/DI-Connect-Fitness/${EMAIL}_123456789.tcx`]: strToU8(runTcx()),
    // Strava-style compressed entries.
    'activities/9876543210.gpx.gz': gzipSync(strToU8(otherRunGpx(1))),
    'activities/9876543211.fit.gz': gzipSync(indoorFit()),
    // Not activities.
    [`DI_CONNECT/DI-Connect-User/${EMAIL}-profile.json`]: strToU8('{"email":"x"}'),
    'media/photo.jpg': new Uint8Array([0xff, 0xd8, 0xff]),
    // Unsafe or broken entries.
    '../escape.gpx': strToU8(otherRunGpx(2)),
    'activities/broken.fit.gz': new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3]),
    'nested/inner.zip': zipSync({ 'a.gpx': strToU8(otherRunGpx(3)) }),
  });
}

describe('validation harness: archives', () => {
  it('validates a mixed bulk export with PACE’s archive reader and accounts for every entry', async () => {
    const secrets = new Secrets();
    const zip = garminExport();
    const r = await validateArchive(
      {
        id: 'V16',
        extension: '.zip',
        open: () => bytesSource(zip, 4096),
        expect: { imported: 2, duplicates: 1, failed: 4 },
      },
      secrets,
    );
    const s = r.summary as unknown as ArchiveSummary;
    expect(s).toMatchObject({
      entries: 9,
      imported: 2,
      duplicates: 1,
      failed: 4,
      skipped: 2,
      sourceErrors: 0,
    });
    expect(s.importedByKind).toEqual({ '.fit': 1, '.gpx.gz': 1 });
    expect(s.skippedByExtension).toEqual({ '.jpg': 1, '.json': 1 });
    expect(Object.keys(s.failureReasons).join(' ')).toMatch(/Unsafe file name/);
    expect(Object.keys(s.failureReasons).join(' ')).toMatch(/Archives inside archives/);
    expect(s.limits).toEqual({
      archiveMb: DEFAULT_ARCHIVE_LIMITS.maxArchiveBytes / 1024 / 1024,
      entries: DEFAULT_ARCHIVE_LIMITS.maxArchiveEntries,
      entryMb: DEFAULT_ARCHIVE_LIMITS.maxEntryBytes / 1024 / 1024,
      totalUncompressedMb: DEFAULT_ARCHIVE_LIMITS.maxTotalUncompressedBytes / 1024 / 1024,
    });
    for (const m of [
      'every entry accounted for',
      'database consistent',
      'second import adds nothing',
      'cancel and resume',
    ])
      expect(byMetric(r.checks, m).status).toBe('PASS');
    expect(byMetric(r.checks, 'imported activities').status).toBe('PASS');
    expect(r.status).toBe('PASS');
    // Entry names (email, activity IDs) never appear in the result.
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/jane|example\.com|123456789|9876543210|escape|broken|inner/);
  });

  it('cancels a large archive part-way and completes it on retry', async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 40; i++) files[`activities/${i}.gpx`] = strToU8(otherRunGpx(10 + i));
    const zip = zipSync(files);
    const r = await validateArchive(
      {
        id: 'A1',
        extension: '.zip',
        open: () => bytesSource(zip, 64 * 1024),
        expect: { imported: 40 },
      },
      new Secrets(),
    );
    expect(byMetric(r.checks, 'cancel and resume')).toMatchObject({
      status: 'PASS',
      reference: 40,
    });
    expect(byMetric(r.checks, 'second import adds nothing').status).toBe('PASS');
    const s = r.summary as unknown as ArchiveSummary;
    expect(s.seconds).toBeGreaterThanOrEqual(0);
    expect(s.peakMemoryMb).toBeGreaterThan(0);
  });

  it('keeps the archive limits: an archive over the total size stops with a warning, earlier files kept', async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 6; i++) files[`a/${i}.gpx`] = strToU8(otherRunGpx(100 + i));
    const zip = zipSync(files);
    const one = files['a/0.gpx']!.length;
    const r = await validateArchive(
      {
        id: 'A2',
        extension: '.zip',
        open: () => bytesSource(zip, 1024),
        expect: { sourceErrors: 1 },
        limits: { ...DEFAULT_ARCHIVE_LIMITS, maxTotalUncompressedBytes: one * 2.5 },
      },
      new Secrets(),
    );
    const s = r.summary as unknown as ArchiveSummary;
    expect(s.sourceErrors).toBe(1);
    expect(s.imported).toBe(2);
    expect(byMetric(r.checks, 'every entry accounted for').status).toBe('NOT TESTED');
    expect(byMetric(r.checks, 'archive-level errors').status).toBe('PASS');
    expect(byMetric(r.checks, 'database consistent').status).toBe('PASS');
  });

  it('reports a truncated archive without losing what was readable', async () => {
    const zip = zipSync({ 'a.gpx': strToU8(otherRunGpx(200)), 'b.gpx': strToU8(otherRunGpx(201)) });
    const cut = zip.slice(0, Math.floor(zip.length * 0.7));
    const r = await validateArchive(
      { id: 'V18', extension: '.zip', open: () => bytesSource(cut), expect: {} },
      new Secrets(),
    );
    const s = r.summary as unknown as ArchiveSummary;
    expect(s.imported + s.failed).toBeGreaterThanOrEqual(1);
    expect(s.sourceErrors).toBe(1);
    expect(byMetric(r.checks, 'database consistent').status).toBe('PASS');
    expect(r.status).toBe('WARNING');
  });
});

describe('validation harness: command line', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pace-validate-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('runs a folder of exports and writes anonymised reports outside the repository', async () => {
    mkdirSync(join(dir, 'garmin'));
    writeFileSync(join(dir, 'garmin', `${EMAIL}_123456789.fit`), runFit({ deviceDistance: 1950 }));
    writeFileSync(join(dir, 'garmin', `${EMAIL}_123456789.tcx`), runTcx());
    writeFileSync(join(dir, 'garmin', `${EMAIL}_123456789.gpx.gz`), gzipSync(strToU8(runGpx())));
    writeFileSync(join(dir, 'Zurich lake loop.fit.gz'), gzipSync(indoorFit()));
    writeFileSync(join(dir, 'export.zip'), garminExport());
    const lines: string[] = [];
    const code = await runCli([dir, '--write-key'], { log: (l) => lines.push(l) });
    expect(code).toBe(0);
    const out = join(dir, 'pace-validation-report');
    expect(readdirSync(out).sort()).toEqual(['PRIVATE-file-key.json', 'report.json', 'report.md']);
    const json = readFileSync(join(out, 'report.json'), 'utf8');
    const md = readFileSync(join(out, 'report.md'), 'utf8');
    for (const text of [json, md, lines.join('\n')]) {
      expect(text).not.toMatch(/jane|example\.com|123456789|Zurich|garmin[\\/]|pace-validate-/i);
      expect(text).not.toContain(FIXTURE_SERIAL);
      expect(text).not.toMatch(/\d{8,}/);
      expect(text).not.toMatch(/1\.29\d{2}|103\.85/);
    }
    const report = JSON.parse(json);
    // Sorted by path: "Zurich…" (F1), "export.zip" (A1), "garmin/…" (F2).
    expect(report.scenarios.map((s: { id: string }) => s.id)).toEqual(['F1', 'A1', 'F2']);
    expect(report.scenarios[0]).toMatchObject({ outcome: 'refused', status: 'WARNING' });
    expect(report.scenarios[2].companions).toEqual(['TCX', 'GPX']);
    expect(report.realDeviceFiles).toBe(false);
    expect(md).toMatch(/## F1 — /);
    // The private key is the only place names appear, and it says so.
    const key = JSON.parse(readFileSync(join(out, 'PRIVATE-file-key.json'), 'utf8'));
    expect(key.warning).toMatch(/PRIVATE/);
    expect(key.key.F2).toContain('123456789.fit');
    expect(lines.at(-1)).toMatch(/3 scenario\(s\)/);
  });

  it('checks a manifest of expected results and exits 1 on a FAIL', async () => {
    writeFileSync(join(dir, 'a.fit'), runFit());
    writeFileSync(join(dir, 'a.tcx'), runTcx());
    const manifest = {
      version: 1,
      scenarios: [
        {
          id: 'V1',
          file: 'a.fit',
          companion: 'a.tcx',
          expect: { sport: 'running', laps: 2, pauses: 'unknown' },
        },
        { id: 'V2', file: 'a.fit', expect: { laps: 7 } },
        { id: 'V3', file: 'missing-jane.fit', expect: {} },
      ],
    };
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    const lines: string[] = [];
    const code = await runCli(
      [dir, '--manifest', join(dir, 'manifest.json'), '--out', join(dir, 'out')],
      {
        log: (l) => lines.push(l),
      },
    );
    expect(code).toBe(1);
    const report = JSON.parse(readFileSync(join(dir, 'out', 'report.json'), 'utf8'));
    expect(report.mode).toBe('manifest');
    expect(report.scenarios.map((s: { id: string; status: string }) => [s.id, s.status])).toEqual([
      ['V1', 'PASS'],
      ['V2', 'FAIL'],
      ['V3', 'FAIL'],
    ]);
    expect(JSON.stringify(report)).not.toMatch(/missing-jane/);
    expect(lines.join('\n')).not.toMatch(/missing-jane|a\.fit/);
  });

  it('refuses folders inside the repository and invalid manifests without exposing paths', async () => {
    const lines: string[] = [];
    const repo = findRepoRoot()!;
    expect(await runCli([join(repo, 'packages')], { log: (l) => lines.push(l) })).toBe(2);
    expect(lines.at(-1)).toMatch(/inside the repository/);
    expect(
      await runCli([dir, '--out', join(repo, 'tmp-report')], { log: (l) => lines.push(l) }),
    ).toBe(2);
    writeFileSync(
      join(dir, 'bad.json'),
      '{"version":1,"scenarios":[{"id":"V1","file":"/home/jane/x.fit"}]}',
    );
    expect(
      await runCli([dir, '--manifest', join(dir, 'bad.json')], { log: (l) => lines.push(l) }),
    ).toBe(2);
    expect(lines.at(-1)).toMatch(/relative/);
    expect(await runCli([], { log: (l) => lines.push(l) })).toBe(2);
    expect(lines.join('\n')).not.toMatch(/jane|pace-validate-|StorageFolder/i);
  });
});
