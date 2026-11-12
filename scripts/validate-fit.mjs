#!/usr/bin/env node
/**
 * Validates PACE's FIT import against real device files kept OUTSIDE the repository.
 *
 *   pnpm validate:fit <folder> [--expect-valid]
 *
 * For every .fit / .fit.gz file under <folder> (recursively) it runs the same parser the app
 * uses and checks invariants: strictly increasing point times, valid coordinates, plausible
 * sensor values with the right units, ordered laps and triathlon legs. When a GPX or TCX export
 * of the same activity sits next to the FIT file (same base name), it also compares start and
 * end time, point count and positions at matching times.
 *
 * Output is aggregate only — counts, durations, sports, warnings — and never coordinates, so it
 * can be shared. Nothing is written anywhere. Files the parser refuses on purpose (indoor,
 * damaged, not an activity) are listed with the reason; with --expect-valid they count as
 * failures. Exit code 1 means a violated invariant or an unexpected error.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, relative } from 'node:path';
import { gunzipSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const formats = require('../packages/formats/dist/index.js');
const { FitImportError, SENSOR_BOUNDS, parseFit, parseGpxTrack, parseTcx } = formats;

const args = process.argv.slice(2);
const folder = args.find((a) => !a.startsWith('--'));
const expectValid = args.includes('--expect-valid');
if (!folder || !existsSync(folder)) {
  console.error('Usage: pnpm validate:fit <folder with .fit files> [--expect-valid]');
  process.exit(2);
}

const UNITS = { heart_rate: 'bpm', cadence: 'rpm', power: 'W' };

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.fit(\.gz)?$/i.test(name)) yield p;
  }
}

function haversine(a, b) {
  const r = (d) => (d * Math.PI) / 180;
  const dLat = r(b.latitude - a.latitude);
  const dLon = r(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(r(a.latitude)) * Math.cos(r(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

function checkTrack(t) {
  const problems = [];
  const points = t.segments.flat();
  if (t.segments.some((s) => s.length === 0)) problems.push('empty segment');
  for (let i = 1; i < points.length; i++)
    if (!(points[i].recordedAt > points[i - 1].recordedAt)) {
      problems.push(`point times not increasing at #${i}`);
      break;
    }
  if (points.some((p) => !(Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180)))
    problems.push('invalid coordinate');
  if (points.some((p) => p.altitudeMeters != null && !Number.isFinite(p.altitudeMeters)))
    problems.push('non-finite altitude');
  for (const s of t.sensors) {
    const b = SENSOR_BOUNDS[s.type];
    if (!b || s.value < b.min || s.value > b.max || UNITS[s.type] !== s.unit) {
      problems.push(`sensor value out of range or wrong unit (${s.type} ${s.value} ${s.unit})`);
      break;
    }
  }
  for (let i = 1; i < t.sensors.length; i++)
    if (t.sensors[i].recordedAt < t.sensors[i - 1].recordedAt) {
      problems.push('sensor times not in order');
      break;
    }
  const first = points[0]?.recordedAt ?? 0;
  for (let i = 0; i < t.lapStarts.length; i++)
    if (t.lapStarts[i] <= first || (i > 0 && t.lapStarts[i] <= t.lapStarts[i - 1])) {
      problems.push('laps out of order');
      break;
    }
  if (t.sportType === 'triathlon') {
    const l = t.legStarts ?? [];
    if (l.length !== 4 || l.some((x, i) => i > 0 && x <= l[i - 1]))
      problems.push('triathlon legs invalid');
  }
  return problems;
}

function compareWithCompanion(fitPath, track) {
  const stem = fitPath.replace(/\.fit(\.gz)?$/i, '');
  for (const ext of ['.gpx', '.tcx']) {
    const p = stem + ext;
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    const other = ext === '.gpx' ? parseGpxTrack(text) : parseTcx(text)[0];
    const a = track.segments.flat();
    const b = other.segments.flat();
    const byTime = new Map(b.map((x) => [x.recordedAt, x]));
    let matched = 0;
    let maxDist = 0;
    for (const x of a) {
      const y = byTime.get(x.recordedAt);
      if (!y) continue;
      matched++;
      maxDist = Math.max(maxDist, haversine(x, y));
    }
    const problems = [];
    if (Math.abs(a[0].recordedAt - b[0].recordedAt) > 2000)
      problems.push('start time differs by > 2 s');
    if (Math.abs(a.at(-1).recordedAt - b.at(-1).recordedAt) > 2000)
      problems.push('end time differs by > 2 s');
    if (matched > 0 && maxDist > 5)
      problems.push(`positions differ by up to ${maxDist.toFixed(1)} m`);
    return {
      companion: basename(p),
      points: `${a.length} FIT / ${b.length} ${ext.slice(1).toUpperCase()}`,
      matchedTimes: matched,
      maxPositionDifferenceM: Number(maxDist.toFixed(2)),
      problems,
    };
  }
  return null;
}

let failures = 0;
let files = 0;
for (const path of walk(folder)) {
  files++;
  const name = relative(folder, path);
  let bytes = readFileSync(path);
  try {
    if (/\.gz$/i.test(path)) bytes = gunzipSync(bytes);
    const tracks = parseFit(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length));
    tracks.forEach((t, i) => {
      const pts = t.segments.flat();
      const problems = checkTrack(t);
      const companion = tracks.length === 1 ? compareWithCompanion(path, t) : null;
      if (companion) problems.push(...companion.problems);
      if (problems.length) failures++;
      const sensors = {};
      for (const s of t.sensors) sensors[s.type] = (sensors[s.type] ?? 0) + 1;
      console.log(
        JSON.stringify({
          file: tracks.length > 1 ? `${name}#${i + 1}` : name,
          result: problems.length ? 'FAIL' : 'ok',
          sport: t.sportType,
          points: pts.length,
          pauses: t.segments.length - 1,
          laps: t.lapStarts.length + 1,
          legs: t.legStarts ? t.legStarts.length + 1 : null,
          durationMin: Number(((pts.at(-1).recordedAt - pts[0].recordedAt) / 60000).toFixed(1)),
          sensors,
          warnings: t.warnings,
          ...(companion ? { companion } : {}),
          ...(problems.length ? { problems } : {}),
        }),
      );
    });
  } catch (e) {
    const expected = e instanceof FitImportError;
    if (!expected || expectValid) failures++;
    console.log(
      JSON.stringify({
        file: name,
        result: expected ? 'refused' : 'ERROR',
        reason: String(e?.message ?? e),
      }),
    );
  }
}
console.log(JSON.stringify({ files, failures }));
process.exit(failures > 0 ? 1 : 0);
