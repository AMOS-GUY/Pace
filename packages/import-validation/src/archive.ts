/**
 * Validates an archive (Garmin or Strava bulk export, any ZIP, or a single activity file) with
 * PACE's own archive reader and bulk importer, exactly as the app runs them, with the app's
 * archive security limits (the CLI never relaxes them; tests may pass smaller ones).
 *
 * Checks: every entry is accounted for, imported activities are complete, the database stays
 * consistent, a second import adds nothing (duplicates), and a cancelled import keeps what it
 * imported and completes on retry. Entry names never leave this module: outcomes are reported as
 * counts by extension and reason.
 */
import {
  type BulkImportOptions,
  type BulkImportReport,
  BulkImportService,
  type ImportSourceFile,
} from '@pace/core';
import { type ArchiveLimits, type ByteSource, DEFAULT_ARCHIVE_LIMITS } from '@pace/formats';
import { Unzip, type UnzipFile } from 'fflate';
import { type Check, check, expectNumber, notTested, overallStatus } from './checks';
import type { ArchiveExpectations } from './manifest';
import { memoryDatabase } from './pipeline';
import { type Secrets, scrub } from './privacy';
import type { ScenarioResult } from './scenario';

export interface ArchiveInput {
  id: string;
  /**
   * File extension(s) of the picked file (".zip", ".fit.gz", …). The real name is never passed to
   * the importer, so it cannot reach any outcome or message.
   */
  extension: string;
  open(): ByteSource;
  size?: number;
  expect: ArchiveExpectations;
  /** Tests only; the CLI always uses the app's limits. */
  limits?: ArchiveLimits;
}

export interface ArchiveSummary {
  entries: number | null;
  imported: number;
  duplicates: number;
  needsSport: number;
  failed: number;
  skipped: number;
  sourceErrors: number;
  /** Imported activity entries by file kind (".fit", ".tcx.gz", …). */
  importedByKind: Record<string, number>;
  /** Failed entries grouped by (scrubbed) reason. */
  failureReasons: Record<string, number>;
  skippedByExtension: Record<string, number>;
  seconds: number;
  peakMemoryMb: number;
  /** The archive security limits in effect (the app's own unless a test overrides them). */
  limits: { archiveMb: number; entries: number; entryMb: number; totalUncompressedMb: number };
}

const mb = (n: number): number => Math.round((n / 1024 / 1024) * 10) / 10;

const kindOf = (entry: string | null, fallback: string): string => {
  const m = /(\.(?:fit|gpx|tcx)(?:\.gz)?)(?:#\d+)?$/i.exec(entry ?? '');
  return m ? m[1]!.toLowerCase() : fallback;
};

/** Number of file entries in a ZIP, read from local headers without decompressing anything. */
async function countZipEntries(source: ByteSource): Promise<number | null> {
  let n = 0;
  const unzip = new Unzip((f: UnzipFile) => {
    if (!f.name.endsWith('/')) n++;
  });
  try {
    for await (const chunk of source) unzip.push(chunk, false);
    unzip.push(new Uint8Array(0), true);
  } catch {
    return null;
  }
  return n;
}

async function run(
  service: BulkImportService,
  input: ArchiveInput,
  options: Partial<BulkImportOptions> = {},
): Promise<BulkImportReport> {
  const file: ImportSourceFile = {
    name: `picked${input.extension}`,
    open: () => input.open(),
    ...(input.size != null ? { size: input.size } : {}),
  };
  return service.importFiles([file], {
    timezone: 'UTC',
    userId: null,
    limits: input.limits ?? DEFAULT_ARCHIVE_LIMITS,
    ...options,
  });
}

export async function validateArchive(
  input: ArchiveInput,
  secrets: Secrets,
): Promise<ScenarioResult> {
  const checks: Check[] = [];
  const started = Date.now();
  let peak = process.memoryUsage().rss;
  const sample = (): void => {
    peak = Math.max(peak, process.memoryUsage().rss);
  };

  const ctx = await memoryDatabase();
  let report: BulkImportReport;
  try {
    const service = new BulkImportService(ctx);
    report = await run(service, input, { onProgress: sample });
    for (const o of report.outcomes) if (o.entry) secrets.addPath(o.entry.replace(/#\d+$/, ''));

    // Accounting: every file entry produced an outcome or a skip.
    const isZip = /\.zip$/i.test(input.extension);
    const entries = isZip ? await countZipEntries(input.open()) : 1;
    // One outcome per file, except a file with several activities, whose outcomes are labelled
    // "#1", "#2", …: count those once (at "#1"). Names are not deduplicated, because a ZIP may
    // legally contain two entries with the same name, and each is a file of its own.
    const accounted =
      report.outcomes.filter((o) => !/#\d+$/.test(o.entry ?? '') || /#1$/.test(o.entry ?? ''))
        .length + report.skipped.count;
    if (entries == null || report.sourceErrors.length > 0)
      checks.push(
        notTested(
          'archive',
          'every entry accounted for',
          report.sourceErrors.length > 0
            ? 'The archive stopped early (see source errors); entries after that point are not counted'
            : 'The archive could not be listed',
        ),
      );
    else
      checks.push(
        check({
          tier: 'archive',
          metric: 'every entry accounted for',
          status: accounted === entries ? 'PASS' : 'FAIL',
          value: accounted,
          reference: entries,
          tolerance: 'exact',
          explanation:
            accounted === entries
              ? 'Every file in the archive was imported, reported as a duplicate or failure, or skipped as not an activity'
              : 'Some files in the archive produced no outcome',
        }),
      );

    // Database consistency after the import.
    const fk = await ctx.db.all('PRAGMA foreign_key_check');
    const integrity = await ctx.db.all<{ integrity_check: string }>('PRAGMA integrity_check');
    const incomplete = (await ctx.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM activities a WHERE a.status <> 'completed'
         OR NOT EXISTS (SELECT 1 FROM route_points r WHERE r.activity_id = a.id)`,
    ))!.n;
    const stored = (await ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM activities'))!.n;
    const consistent =
      fk.length === 0 &&
      integrity[0]?.integrity_check === 'ok' &&
      incomplete === 0 &&
      stored === report.imported;
    checks.push(
      check({
        tier: 'archive',
        metric: 'database consistent',
        status: consistent ? 'PASS' : 'FAIL',
        value: stored,
        reference: report.imported,
        explanation: consistent
          ? 'One complete activity with its points per imported entry; foreign keys and integrity check clean'
          : 'Stored activities do not match the import report, or the database failed its checks',
      }),
    );

    // Repeat: importing the same archive again adds nothing.
    const again = await run(service, input);
    const repeatOk =
      again.imported === 0 && again.duplicates === report.imported + report.duplicates;
    checks.push(
      check({
        tier: 'archive',
        metric: 'second import adds nothing',
        status: repeatOk ? 'PASS' : 'FAIL',
        value: again.imported,
        reference: 0,
        explanation: repeatOk
          ? 'Every activity is recognised as already imported on the second run'
          : 'The second import added activities or did not report them as duplicates',
      }),
    );
  } finally {
    ctx.close();
  }

  // Cancellation: stop after the first imported activity, then complete on retry.
  if (report.imported >= 2) {
    const c = await memoryDatabase();
    try {
      const service = new BulkImportService(c);
      let stop = false;
      const cancelled = await run(service, input, {
        onProgress: (p) => {
          sample();
          if (p.imported >= 1) stop = true;
        },
        isCancelled: () => stop,
      });
      const resumed = await run(service, input);
      const ok =
        cancelled.cancelled &&
        cancelled.imported >= 1 &&
        cancelled.imported < report.imported &&
        cancelled.imported + resumed.imported === report.imported;
      checks.push(
        check({
          tier: 'archive',
          metric: 'cancel and resume',
          status: ok ? 'PASS' : 'FAIL',
          value: `${cancelled.imported} + ${resumed.imported}`,
          reference: report.imported,
          explanation: ok
            ? 'A cancelled import keeps what it imported, and importing again completes the rest without duplicates'
            : 'Cancelling and re-importing did not give the same activities as one complete import',
        }),
      );
    } finally {
      c.close();
    }
  } else
    checks.push(
      notTested('archive', 'cancel and resume', 'Fewer than two activities were imported'),
    );

  if (report.sourceErrors.length > 0)
    checks.push(
      check({
        tier: 'archive',
        metric: 'archive read completely',
        status:
          input.expect.sourceErrors != null && input.expect.sourceErrors !== 'unknown'
            ? 'NOT TESTED'
            : 'WARNING',
        value: report.sourceErrors.length,
        explanation: `The archive stopped early: ${report.sourceErrors.map((s) => scrub(s.message, secrets)).join('; ')}`,
      }),
    );

  const failureReasons: Record<string, number> = {};
  const importedByKind: Record<string, number> = {};
  for (const o of report.outcomes) {
    if (o.status === 'failed') {
      const r = scrub(o.message ?? 'unknown', secrets);
      failureReasons[r] = (failureReasons[r] ?? 0) + 1;
    } else if (o.status === 'imported') {
      const k = kindOf(o.entry, input.extension.toLowerCase());
      importedByKind[k] = (importedByKind[k] ?? 0) + 1;
    }
  }

  const e = input.expect;
  const expectations: Array<[keyof ArchiveExpectations, string, number]> = [
    ['imported', 'imported activities', report.imported],
    ['duplicates', 'duplicates', report.duplicates],
    ['needsSport', 'activities needing a sport', report.needsSport],
    ['failed', 'failed entries', report.failed],
    ['skipped', 'skipped entries', report.skipped.count],
    ['sourceErrors', 'archive-level errors', report.sourceErrors.length],
  ];
  const given = expectations.filter(([k]) => k in e);
  if (given.length === 0)
    checks.push(notTested('expectation', 'expectations', 'No expectations given for this archive'));
  for (const [k, metric, actual] of given) checks.push(expectNumber(metric, actual, e[k]));

  const summary: ArchiveSummary = {
    entries: null,
    imported: report.imported,
    duplicates: report.duplicates,
    needsSport: report.needsSport,
    failed: report.failed,
    skipped: report.skipped.count,
    sourceErrors: report.sourceErrors.length,
    importedByKind,
    failureReasons,
    skippedByExtension: report.skipped.byExtension,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    peakMemoryMb: Math.round(peak / 1024 / 1024),
    limits: (() => {
      const l = input.limits ?? DEFAULT_ARCHIVE_LIMITS;
      return {
        archiveMb: mb(l.maxArchiveBytes),
        entries: l.maxArchiveEntries,
        entryMb: mb(l.maxEntryBytes),
        totalUncompressedMb: mb(l.maxTotalUncompressedBytes),
      };
    })(),
  };
  const entriesCheck = checks.find((c) => c.metric === 'every entry accounted for');
  summary.entries = typeof entriesCheck?.reference === 'number' ? entriesCheck.reference : null;

  // Skipped extensions come from entry names; keep only plain short extensions.
  summary.skippedByExtension = Object.fromEntries(
    Object.entries(summary.skippedByExtension).map(([k, v]) => [
      /^\.[a-z0-9]{1,8}$|^\(none\)$/.test(k) ? k : '(other)',
      v,
    ]),
  );

  return {
    id: input.id,
    kind: 'archive',
    status: overallStatus(checks),
    outcome: 'archive',
    companions: [],
    summary: summary as unknown as Record<string, unknown>,
    warnings: [],
    checks,
  };
}
