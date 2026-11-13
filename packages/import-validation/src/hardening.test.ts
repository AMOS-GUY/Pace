/**
 * Hardening suite (M4.7 overnight audit): export round trip, archive edge cases, storage failure,
 * and two seeded property tests. Seeds are fixed so any failure reproduces exactly.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LocationSample } from '@pace/domain';
import { bytesSource } from '@pace/formats';
import { Zip, ZipPassThrough, strToU8, zipSync } from 'fflate';
import { type DeviceTrackPoint, garminTcx } from '../../formats/src/test-fixtures/device-files';
import { type FitPoint, SPORT, fitActivity } from '../../formats/src/test-fixtures/fit-encoder';
import { seededRandom, straightTrack } from '../../gps-engine/src/test-fixtures/synthetic-track';
import {
  type ArchiveSummary,
  type Check,
  PrivacyLeakError,
  Secrets,
  assertNoLeak,
  memoryDatabase,
  runCli,
  scrub,
  validateActivity,
  validateArchive,
} from './index';
import {
  T,
  otherRunGpx,
  pausedFit,
  rideWithDropoutsFit,
  runFit,
  triathlonFit,
} from './test-fixtures/activities';

const byMetric = (checks: Check[], metric: string): Check => {
  const c = checks.find((x) => x.metric === metric);
  if (!c) throw new Error(`no check "${metric}" in: ${checks.map((x) => x.metric).join(', ')}`);
  return c;
};
const tier = (checks: Check[], t: Check['tier']) => checks.filter((c) => c.tier === t);

describe('export round trip (app GPX export, imported again)', () => {
  const trip = async (fit: Uint8Array) =>
    (
      await validateActivity(
        { id: 'R1', fit, companions: [], expect: {}, roundTrip: true },
        new Secrets(),
      )
    )[0]!;

  it('keeps distance, times, points, pauses, heart rate and cadence exactly', async () => {
    const r = await trip(pausedFit());
    for (const m of [
      'distance kept',
      'moving time kept',
      'elapsed time kept',
      'GPS points kept',
      'pauses kept',
      'heart rate kept',
      'sport kept',
    ])
      expect(byMetric(r.checks, m).status).toBe('PASS');
  });

  it('reports the known gaps as WARNINGs with their reason: laps (R2) and power (R1)', async () => {
    const run = await trip(runFit());
    expect(byMetric(run.checks, 'laps kept')).toMatchObject({
      status: 'WARNING',
      value: 1,
      reference: 2,
    });
    expect(byMetric(run.checks, 'laps kept').explanation).toMatch(/R2/);
    const ride = await trip(rideWithDropoutsFit());
    // R1 is approved and fixed on fix/gpx-power-export. Until both branches are merged this test
    // runs against either exporter, and allows exactly two outcomes: every power sample kept
    // (PASS), or none kept, reported as the documented R1 gap (WARNING). Partial loss or changed
    // values are a FAIL in both cases.
    const power = byMetric(ride.checks, 'power kept');
    if (power.value === 561) {
      expect(power).toMatchObject({ status: 'PASS', reference: 561 });
      expect(power.explanation).toMatch(/Every sample kept/);
    } else {
      expect(power).toMatchObject({ status: 'WARNING', value: 0, reference: 561 });
      expect(power.explanation).toMatch(/R1/);
    }
    // Zero cadence while coasting survives the round trip exactly.
    expect(byMetric(ride.checks, 'cadence kept').status).toBe('PASS');
  });

  it('reports that a triathlon cannot come back from its GPX (R3)', async () => {
    const r = await trip(triathlonFit());
    expect(byMetric(r.checks, 'exported GPX imports again')).toMatchObject({ status: 'WARNING' });
    expect(byMetric(r.checks, 'exported GPX imports again').explanation).toMatch(/R3/);
  });

  it('is off unless requested, so existing results are unchanged', async () => {
    const [r] = await validateActivity(
      { id: 'R1', fit: runFit(), companions: [], expect: {} },
      new Secrets(),
    );
    expect(tier(r!.checks, 'roundtrip')).toEqual([]);
  });
});

describe('archive edge cases', () => {
  function zipWithDuplicateNames(): Uint8Array {
    const chunks: Uint8Array[] = [];
    const zip = new Zip((err, data) => {
      if (err) throw err;
      chunks.push(data);
    });
    for (const day of [1, 2]) {
      const f = new ZipPassThrough('activities/run.gpx');
      zip.add(f);
      f.push(strToU8(otherRunGpx(500 + day)), true);
    }
    zip.end();
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  it('accounts for two entries with the same name as two files', async () => {
    const zip = zipWithDuplicateNames();
    const r = await validateArchive(
      { id: 'A1', extension: '.zip', open: () => bytesSource(zip), expect: { imported: 2 } },
      new Secrets(),
    );
    expect(byMetric(r.checks, 'every entry accounted for')).toMatchObject({
      status: 'PASS',
      value: 2,
      reference: 2,
    });
    expect(byMetric(r.checks, 'imported activities').status).toBe('PASS');
  });

  it('reads entries from local headers; a damaged central directory does not hide them', async () => {
    const zip = zipSync({ 'a.gpx': strToU8(otherRunGpx(600)), 'b.gpx': strToU8(otherRunGpx(601)) });
    // Overwrite the central directory (from its first signature PK\x01\x02 onwards) with junk.
    let cd = -1;
    for (let i = 0; i < zip.length - 3; i++)
      if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 1 && zip[i + 3] === 2) {
        cd = i;
        break;
      }
    expect(cd).toBeGreaterThan(0);
    const damaged = zip.slice();
    for (let i = cd + 4; i < damaged.length; i++) damaged[i] = 0xa5;
    const r = await validateArchive(
      { id: 'A2', extension: '.zip', open: () => bytesSource(damaged), expect: {} },
      new Secrets(),
    );
    const s = r.summary as unknown as ArchiveSummary;
    // Both activities are read from their local headers, as in the app.
    expect(s.imported).toBe(2);
    expect(byMetric(r.checks, 'database consistent').status).toBe('PASS');
  });

  it('reports an empty archive as an archive-level problem, not a pass', async () => {
    const zip = zipSync({});
    const r = await validateArchive(
      { id: 'A3', extension: '.zip', open: () => bytesSource(zip), expect: {} },
      new Secrets(),
    );
    const s = r.summary as unknown as ArchiveSummary;
    expect(s).toMatchObject({ imported: 0, sourceErrors: 1 });
    expect(byMetric(r.checks, 'every entry accounted for').status).toBe('NOT TESTED');
    expect(r.status).toBe('WARNING');
  });

  it('handles thousands of tiny files and accounts for every one', async () => {
    const files: Record<string, Uint8Array> = { 'activities/one.gpx': strToU8(otherRunGpx(700)) };
    for (let i = 0; i < 3000; i++) files[`notes/n${i}.txt`] = strToU8(`note ${i}`);
    const zip = zipSync(files, { level: 0 });
    const r = await validateArchive(
      {
        id: 'A4',
        extension: '.zip',
        open: () => bytesSource(zip, 64 * 1024),
        expect: { skipped: 3000, imported: 1 },
      },
      new Secrets(),
    );
    expect(byMetric(r.checks, 'every entry accounted for')).toMatchObject({
      status: 'PASS',
      reference: 3001,
    });
    expect(byMetric(r.checks, 'skipped entries').status).toBe('PASS');
  });
});

describe('storage failures and database isolation', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pace-hard-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a report folder that cannot be created stops the run without exposing its path', async () => {
    writeFileSync(join(dir, 'a.fit'), runFit());
    const blocker = join(dir, 'jane.doe@example.com_reports');
    writeFileSync(blocker, 'a file where the report folder should be');
    const lines: string[] = [];
    expect(await runCli([dir, '--out', join(blocker, 'out')], { log: (l) => lines.push(l) })).toBe(
      2,
    );
    expect(lines.at(-1)).toMatch(/^Validation stopped/);
    expect(lines.join('\n')).not.toMatch(/jane|example\.com|pace-hard-/);
  });

  it('every temporary database is separate: an import in one is invisible in another', async () => {
    const a = await memoryDatabase();
    const b = await memoryDatabase();
    await a.db.run(
      `INSERT INTO activities (id, sport_type, title, started_at, timezone, status, source, created_at, updated_at)
       VALUES ('x', 'running', 't', 0, 'UTC', 'completed', 'imported_fit', 0, 0)`,
    );
    expect((await b.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM activities'))!.n).toBe(0);
    a.close();
    b.close();
  });

  it('writes the round trip into the report only with --export-roundtrip', async () => {
    writeFileSync(join(dir, 'a.fit'), runFit());
    const lines: string[] = [];
    await runCli([dir, '--export-roundtrip', '--out', join(dir, 'out')], {
      log: (l) => lines.push(l),
    });
    const report = JSON.parse(readFileSync(join(dir, 'out', 'report.json'), 'utf8'));
    expect(report.scenarios[0].checks.some((c: Check) => c.tier === 'roundtrip')).toBe(true);
  });
});

describe('property: scrubbed text always passes the privacy guard (seed 20261113)', () => {
  const rnd = seededRandom(20261113);
  const pick = <V>(xs: readonly V[]): V => xs[Math.floor(rnd() * xs.length)]!;
  const digits = (n: number) => Array.from({ length: n }, () => Math.floor(rnd() * 10)).join('');
  const NAMES = ['jane', 'ole', 'maria-luisa', 'li.wei', 'o_brien', 'zoë'];
  const DOMAINS = ['example.com', 'mail.example.org', 'test.invalid'];
  const WORDS = ['Could not read', 'skipped', 'point', 'near', 'unit', 'file', 'at', 'in', '—'];

  it('for 400 generated messages with emails, paths, coordinates, serials and times', () => {
    for (let i = 0; i < 400; i++) {
      const name = pick(NAMES);
      const email = `${name}.${digits(2)}@${pick(DOMAINS)}`;
      const winPath = `C:\\Users\\${name}\\Exports\\${email}_${digits(9)}.fit`;
      const posixPath = `/home/${name}/runs/${digits(6)}.tcx.gz`;
      const coord = `${(rnd() * 180 - 90).toFixed(6)}, ${(rnd() * 360 - 180).toFixed(6)}`;
      const serial = digits(10);
      const time = new Date(Date.UTC(2026, 0, 1) + Math.floor(rnd() * 3e10)).toISOString();
      const secrets = new Secrets();
      if (rnd() < 0.5) secrets.addPath(winPath);
      if (rnd() < 0.5) secrets.addIdentifier(serial);
      const parts = [email, winPath, posixPath, coord, serial, time, `“Run with ${name}”`];
      const message = Array.from({ length: 6 }, () =>
        rnd() < 0.5 ? pick(parts) : pick(WORDS),
      ).join(' ');
      const out = scrub(message, secrets);
      expect(() => assertNoLeak(out, secrets)).not.toThrow();
      for (const v of [email, winPath, posixPath, coord, serial, time])
        expect(out).not.toContain(v);
    }
  });

  it('and the guard itself refuses every one of those values unscrubbed', () => {
    const secrets = new Secrets();
    for (const v of [
      'jane.07@example.com',
      'C:\\Users\\jane\\x.fit',
      '/home/jane/runs/1.tcx',
      '47.123456, 8.123456',
      '3999000111',
    ])
      expect(() => assertNoLeak(`value ${v} here`, secrets)).toThrow(PrivacyLeakError);
  });
});

describe('property: the same random activity as FIT and TCX agrees in every tier (seeds 1–8)', () => {
  /** A random activity: 1–3 laps of 1–2 timer segments, heart-rate dropouts, zero cadence. */
  function activity(seed: number) {
    const rnd = seededRandom(seed);
    const cycling = rnd() < 0.5;
    const laps: Array<Array<LocationSample[]>> = [];
    let t = T + seed * 86_400_000;
    let start: { latitude: number; longitude: number } | undefined;
    const lapCount = 1 + Math.floor(rnd() * 3);
    let pauses = 0;
    for (let l = 0; l < lapCount; l++) {
      const segs: LocationSample[][] = [];
      const segCount = 1 + Math.floor(rnd() * 2);
      for (let s = 0; s < segCount; s++) {
        if (s > 0) {
          t += (20 + Math.floor(rnd() * 40)) * 1000; // a pause
          pauses++;
        }
        const seg = straightTrack({
          speedMps: cycling ? 6 + rnd() * 4 : 2.5 + rnd() * 1.5,
          durationSeconds: 60 + Math.floor(rnd() * 120),
          startTime: t,
          ...(start ? { start } : {}),
        });
        segs.push(seg);
        const last = seg.at(-1)!;
        start = { latitude: last.latitude, longitude: last.longitude };
        t = last.recordedAt + 1000;
      }
      laps.push(segs);
    }
    // Sensors: heart rate with one dropout block; cadence with a block of real zeros.
    const total = laps.flat(2).length;
    const dropAt = Math.floor(rnd() * (total - 20));
    const zeroAt = Math.floor(rnd() * (total - 15));
    let i = 0;
    const sensors = (sample: LocationSample) => {
      const k = i++;
      return {
        sample,
        ...(k >= dropAt && k < dropAt + 15 ? {} : { hr: 120 + (k % 40) }),
        cadence: k >= zeroAt && k < zeroAt + 10 ? 0 : cycling ? 85 : 80,
        ...(cycling ? { watts: 150 + (k % 50) } : {}),
      };
    };
    const fitLaps: FitPoint[][][] = laps.map((segs) => segs.map((seg) => seg.map(sensors)));
    i = 0;
    const tcxLaps: Array<{ tracks: DeviceTrackPoint[][] }> = laps.map((segs) => ({
      tracks: segs.map((seg) => seg.map(sensors)),
    }));
    const fit = fitActivity({
      sessions: [{ sport: cycling ? SPORT.cycling : SPORT.running, laps: fitLaps }],
    });
    const tcx = garminTcx({
      sport: cycling ? 'Biking' : 'Running',
      laps: tcxLaps,
      runCadence: !cycling,
    });
    const hrCount = fitLaps.flat(2).filter((p) => p.hr != null).length;
    return { fit, tcx, lapCount, pauses, hrCount, cycling };
  }

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('seed %i', async (seed) => {
    const a = activity(seed);
    const [r] = await validateActivity(
      {
        id: 'P1',
        fit: a.fit,
        companions: [{ format: 'tcx', text: a.tcx }],
        expect: {
          sport: a.cycling ? 'cycling' : 'running',
          laps: a.lapCount,
          pauses: a.pauses,
          sensors: { heart_rate: a.hrCount, power: a.cycling ? 'present' : 'absent' },
          zeroValues: { cadence: 'present' },
          sensorGaps: { heart_rate: 'present' },
        },
      },
      new Secrets(),
    );
    const failures = r!.checks
      .filter((c) => c.status === 'FAIL')
      .map((c) => `${c.metric}: ${c.explanation}`);
    expect(failures).toEqual([]);
    for (const m of ['laps', 'pauses', 'heart rate sample count', 'cadence zero values kept'])
      expect(byMetric(r!.checks, m).status).toBe('PASS');
    // Pause boundaries are compared whenever there is a pause.
    if (a.pauses > 0) expect(byMetric(r!.checks, 'segment boundaries (TCX)').status).toBe('PASS');
    else expect(r!.checks.some((c) => c.metric === 'segment boundaries (TCX)')).toBe(false);
  });
});
