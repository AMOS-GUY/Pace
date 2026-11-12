/**
 * `pnpm validate:fit <folder> [--manifest <file>] [--out <folder>] [--expect-valid] [--write-key]`
 *
 * Validates PACE's import against the athlete's own exports in <folder>, which must be outside
 * the repository. Writes report.json and report.md to --out (default: a
 * `pace-validation-report` folder inside <folder>), also outside the repository.
 *
 * Without --manifest every .fit/.fit.gz file becomes scenario F1, F2, … (sorted by path), with a
 * GPX/TCX of the same base name as its companion, and every .zip becomes archive scenario A1, A2, ….
 * With --manifest the scenarios, companions and expectations come from the manifest.
 *
 * Console output and reports never contain file names, paths or personal data; --write-key
 * additionally writes a PRIVATE file mapping F/A IDs to file names, for the athlete only.
 *
 * Exit code: 0 no failures, 1 at least one FAIL, 2 usage, privacy or unexpected error.
 */
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { type ByteSource, type SourceItem, readImportSource } from '@pace/formats';
import { validateArchive } from './archive';
import { type Manifest, ManifestError, type Scenario, parseManifest } from './manifest';
import { PrivacyLeakError, Secrets, assertNoLeak, scrub } from './privacy';
import { buildReport, renderReports } from './report';
import { type CompanionInput, type ScenarioResult, validateActivity } from './scenario';
import { check, overallStatus } from './checks';

export interface CliOptions {
  log?: (line: string) => void;
  /** Overrides repository detection (tests). */
  repoRoot?: string;
  /** Set when the folder holds real device exports; synthetic test runs leave it false. */
  realDeviceFiles?: boolean;
}

const EXT = /(\.(?:fit|gpx|tcx)(?:\.gz)?|\.zip)$/i;

/** The repository root: the nearest folder above this file with pnpm-workspace.yaml. */
export function findRepoRoot(from = __dirname): string | null {
  for (let d = resolve(from); ; d = dirname(d)) {
    if (existsSync(join(d, 'pnpm-workspace.yaml'))) return d;
    if (dirname(d) === d) return null;
  }
}

export function isInside(child: string, parent: string): boolean {
  const r = relative(resolve(parent), resolve(child));
  return (
    r === '' ||
    (!r.startsWith('..') && !/^[a-zA-Z]:/.test(r) && !r.startsWith('/') && !r.startsWith('\\'))
  );
}

const fileSource = (path: string): ByteSource =>
  createReadStream(path, { highWaterMark: 256 * 1024 });

function* walk(dir: string, skip: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (resolve(p) === resolve(skip)) continue;
    if (statSync(p).isDirectory()) yield* walk(p, skip);
    else yield p;
  }
}

/** Reads one picked file through PACE's archive reader (handles .gz, sniffing, UTF-8 checks). */
async function readOne(path: string): Promise<SourceItem> {
  const ext = EXT.exec(path)?.[1] ?? '';
  for await (const item of readImportSource(`picked${ext}`, fileSource(path))) return item;
  return { kind: 'rejected', entry: null, reason: 'The file is empty' };
}

function autoManifest(
  folder: string,
  out: string,
): { manifest: Manifest; key: Record<string, string> } {
  const files = [...walk(folder, out)];
  const set = new Set(files.map((f) => f.toLowerCase()));
  const scenarios: Scenario[] = [];
  const key: Record<string, string> = {};
  let f = 0;
  let a = 0;
  for (const p of files) {
    const rel = relative(folder, p);
    if (/\.fit(\.gz)?$/i.test(p)) {
      const stem = p.replace(/\.fit(\.gz)?$/i, '');
      const companions = ['.tcx', '.tcx.gz', '.gpx', '.gpx.gz']
        .map((e) => stem + e)
        .filter((c) => set.has(c.toLowerCase()))
        .map((c) =>
          relative(
            folder,
            files.find((x) => x.toLowerCase() === c.toLowerCase())!,
          ),
        );
      const id = `F${++f}`;
      key[id] = rel;
      scenarios.push({ kind: 'activity', id, file: rel, companions, expect: {} });
    } else if (/\.zip$/i.test(p)) {
      const id = `A${++a}`;
      key[id] = rel;
      scenarios.push({ kind: 'archive', id, archive: rel, expect: {} });
    }
  }
  return { manifest: { version: 1, scenarios }, key };
}

function refusedResult(id: string, reason: string): ScenarioResult {
  const checks = [
    check({ tier: 'integrity', metric: 'file readable', status: 'FAIL', explanation: reason }),
  ];
  return {
    id,
    kind: 'activity',
    status: overallStatus(checks),
    outcome: 'refused',
    companions: [],
    summary: null,
    warnings: [],
    checks,
  };
}

async function runScenario(
  s: Scenario,
  base: string,
  secrets: Secrets,
  expectValid: boolean,
): Promise<ScenarioResult[]> {
  if (s.kind === 'archive') {
    const path = resolve(base, s.archive);
    secrets.addPath(path);
    secrets.addPath(s.archive);
    if (!existsSync(path))
      return [refusedResult(s.id, 'The archive named in the manifest does not exist')];
    return [
      await validateArchive(
        {
          id: s.id,
          extension: EXT.exec(path)?.[1] ?? '',
          open: () => fileSource(path),
          size: statSync(path).size,
          expect: s.expect,
        },
        secrets,
      ),
    ];
  }
  const path = resolve(base, s.file);
  secrets.addPath(path);
  secrets.addPath(s.file);
  for (const c of s.companions) {
    secrets.addPath(resolve(base, c));
    secrets.addPath(c);
  }
  if (!existsSync(path))
    return [refusedResult(s.id, 'The file named in the manifest does not exist')];
  const item = await readOne(path);
  if (item.kind !== 'file' || item.format !== 'fit') {
    const reason =
      item.kind === 'file'
        ? `Expected a FIT file, found ${item.format.toUpperCase()}`
        : item.reason;
    return [refusedResult(s.id, scrub(reason, secrets))];
  }
  const companions: CompanionInput[] = [];
  for (const c of s.companions) {
    const cp = resolve(base, c);
    if (!existsSync(cp)) continue;
    const ci = await readOne(cp);
    if (ci.kind === 'file' && ci.format !== 'fit')
      companions.push({ format: ci.format, text: ci.text });
  }
  return validateActivity(
    { id: s.id, fit: item.bytes, companions, expect: s.expect, expectValid },
    secrets,
  );
}

const USAGE =
  'Usage: pnpm validate:fit <folder outside the repository> [--manifest <file>] [--out <folder>] [--expect-valid] [--write-key]';

export async function runCli(argv: readonly string[], options: CliOptions = {}): Promise<number> {
  const secrets = new Secrets();
  const log = options.log ?? ((l: string) => console.log(l));
  const emit = (line: string): void => {
    assertNoLeak(line, secrets);
    log(line);
  };
  try {
    const value = (flag: string): string | null => {
      const i = argv.indexOf(flag);
      return i >= 0 ? (argv[i + 1] ?? null) : null;
    };
    const flagsWithValues = new Set(['--manifest', '--out']);
    const positional = argv.filter(
      (a, i) => !a.startsWith('--') && !flagsWithValues.has(argv[i - 1] ?? ''),
    );
    const folderArg = positional[0];
    if (!folderArg || !existsSync(folderArg) || !statSync(folderArg).isDirectory()) {
      log(USAGE);
      return 2;
    }
    const folder = resolve(folderArg);
    secrets.addPath(folder, 'folder');
    const manifestPath = value('--manifest');
    const out = resolve(value('--out') ?? join(folder, 'pace-validation-report'));
    secrets.addPath(out, 'folder');
    if (manifestPath) secrets.addPath(resolve(manifestPath));
    const repo = options.repoRoot ?? findRepoRoot();
    for (const [what, p] of [
      ['The exports folder', folder],
      ['The report folder', out],
      ...(manifestPath ? [['The manifest', resolve(manifestPath)]] : []),
    ] as Array<[string, string]>)
      if (repo && isInside(p, repo)) {
        emit(
          `${what} is inside the repository. Keep recordings, manifests and reports outside it.`,
        );
        return 2;
      }

    let manifest: Manifest;
    let key: Record<string, string> | null = null;
    let base = folder;
    if (manifestPath) {
      if (!existsSync(manifestPath)) {
        emit('The manifest file does not exist');
        return 2;
      }
      manifest = parseManifest(readFileSync(manifestPath, 'utf8'));
      base = dirname(resolve(manifestPath));
    } else ({ manifest, key } = autoManifest(folder, out));

    const results: ScenarioResult[] = [];
    for (const s of manifest.scenarios) {
      const r = await runScenario(s, base, secrets, argv.includes('--expect-valid'));
      for (const x of r) {
        results.push(x);
        emit(`${x.id.padEnd(6)} ${x.status.padEnd(10)} ${x.outcome}`);
      }
    }
    const report = buildReport(results, {
      mode: manifestPath ? 'manifest' : 'folder',
      realDeviceFiles: options.realDeviceFiles ?? false,
    });
    const { json, markdown } = renderReports(report, secrets);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'report.json'), json);
    writeFileSync(join(out, 'report.md'), markdown);
    if (key && argv.includes('--write-key'))
      writeFileSync(
        join(out, 'PRIVATE-file-key.json'),
        `${JSON.stringify({ warning: 'PRIVATE: maps scenario IDs to your file names. Do not share or commit.', key }, null, 2)}\n`,
      );
    const s = report.summary.scenarios;
    emit(
      `${results.length} scenario(s): ${s.PASS} pass, ${s.FAIL} fail, ${s.WARNING} warning, ${s['NOT TESTED']} not tested. Reports: report.json and report.md in the report folder.`,
    );
    return s.FAIL > 0 ? 1 : 0;
  } catch (e) {
    if (e instanceof PrivacyLeakError) {
      log(`Validation stopped. ${e.message}. Nothing was written.`);
      return 2;
    }
    const message =
      e instanceof ManifestError ? e.message : `Unexpected error: ${(e as Error)?.message ?? e}`;
    const safe = scrub(message, secrets);
    try {
      assertNoLeak(safe, secrets);
      log(`Validation stopped. ${safe}`);
    } catch {
      log('Validation stopped by an unexpected error (details withheld for privacy).');
    }
    return 2;
  }
}
