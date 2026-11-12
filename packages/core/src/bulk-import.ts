import type { DatabaseContext } from '@pace/database';
import type { SportType } from '@pace/domain';
import {
  type ArchiveLimits,
  ArchiveError,
  type ByteSource,
  DEFAULT_ARCHIVE_LIMITS,
  type ParsedTrack,
  parseGpxTrack,
  parseTcx,
  readImportSource,
} from '@pace/formats';
import { IMPORT_LIMITS } from '@pace/validation';
import { ActivityService, ImportError } from './activity-service';

/** One file the athlete picked (a single activity file or an archive). */
export interface ImportSourceFile {
  name: string;
  /** Size in bytes when known, for progress. */
  size?: number;
  open(): ByteSource;
}

export type ImportStatus = 'imported' | 'duplicate' | 'needs_sport' | 'failed';

/** The result for one activity (a TCX file can hold several). */
export interface ImportOutcome {
  /** The picked file. */
  file: string;
  /** Path inside an archive, plus "#n" for the n-th activity of a multi-activity TCX. */
  entry: string | null;
  status: ImportStatus;
  /** Why it failed / was refused, in plain language. */
  message: string | null;
  /** Notes about skipped points and information that was not imported. */
  warnings: string[];
  activityId: string | null;
  /** For duplicates: the activity already in PACE. */
  existingActivityId: string | null;
}

export interface BulkImportProgress {
  /** The picked file being read (1-based index of `fileCount`). */
  file: string;
  fileIndex: number;
  fileCount: number;
  /** Bytes read of the current picked file, and its size when known. */
  bytesRead: number;
  bytesTotal: number | null;
  /** Running counts across everything picked so far. */
  imported: number;
  duplicates: number;
  needsSport: number;
  failed: number;
  skipped: number;
  /** Entry currently being imported, if any. */
  current: string | null;
}

export interface BulkImportReport {
  outcomes: ImportOutcome[];
  imported: number;
  duplicates: number;
  needsSport: number;
  failed: number;
  /** Non-activity files inside archives (photos, CSVs, …), by extension. */
  skipped: { count: number; byExtension: Record<string, number> };
  /** Picked files that stopped early (damaged archive, global limit). Earlier entries count. */
  sourceErrors: Array<{ file: string; message: string }>;
  cancelled: boolean;
  startedAt: number;
  finishedAt: number;
}

export interface BulkImportOptions {
  timezone: string;
  userId?: string | null;
  /** Used only for files that do not say which sport they are. */
  fallbackSportType?: SportType;
  onProgress?: (p: BulkImportProgress) => void | Promise<void>;
  /** Checked between activity files; already imported activities are kept. */
  isCancelled?: () => boolean;
  limits?: ArchiveLimits;
}

const extensionOf = (entry: string): string => {
  const m = /\.([a-z0-9]{1,8})$/i.exec(entry);
  return m ? `.${m[1]!.toLowerCase()}` : '(none)';
};

/**
 * Imports many activity files and archives. Each activity is imported in its own transaction
 * through `ActivityService.importTrack`, so one bad file never affects another, and a cancelled
 * or interrupted import keeps everything imported so far (re-running it skips those as
 * duplicates). Every input produces either an outcome or a skipped/source-error entry.
 */
export class BulkImportService {
  private readonly activities: ActivityService;

  constructor(ctx: DatabaseContext) {
    this.activities = new ActivityService(ctx);
  }

  async importFiles(
    files: readonly ImportSourceFile[],
    options: BulkImportOptions,
  ): Promise<BulkImportReport> {
    const startedAt = Date.now();
    const report: BulkImportReport = {
      outcomes: [],
      imported: 0,
      duplicates: 0,
      needsSport: 0,
      failed: 0,
      skipped: { count: 0, byExtension: {} },
      sourceErrors: [],
      cancelled: false,
      startedAt,
      finishedAt: startedAt,
    };
    const counts: Record<ImportStatus, keyof BulkImportReport> = {
      imported: 'imported',
      duplicate: 'duplicates',
      needs_sport: 'needsSport',
      failed: 'failed',
    };
    const record = (o: ImportOutcome): void => {
      report.outcomes.push(o);
      (report[counts[o.status]] as number)++;
    };
    let activityFiles = 0;

    for (const [index, file] of files.entries()) {
      if (options.isCancelled?.()) {
        report.cancelled = true;
        break;
      }
      let bytesRead = 0;
      const progress = async (current: string | null): Promise<void> => {
        await options.onProgress?.({
          file: file.name,
          fileIndex: index + 1,
          fileCount: files.length,
          bytesRead,
          bytesTotal: file.size ?? null,
          imported: report.imported,
          duplicates: report.duplicates,
          needsSport: report.needsSport,
          failed: report.failed,
          skipped: report.skipped.count,
          current,
        });
      };
      // Count bytes as the archive reader consumes them.
      const counted: ByteSource = {
        async *[Symbol.asyncIterator]() {
          for await (const chunk of file.open()) {
            bytesRead += chunk.length;
            yield chunk;
          }
        },
      };
      await progress(null);
      try {
        for await (const item of readImportSource(
          file.name,
          counted,
          options.limits ?? DEFAULT_ARCHIVE_LIMITS,
        )) {
          if (item.kind === 'skipped') {
            report.skipped.count++;
            const ext = extensionOf(item.entry);
            report.skipped.byExtension[ext] = (report.skipped.byExtension[ext] ?? 0) + 1;
            continue;
          }
          if (item.kind === 'rejected') {
            record({
              file: file.name,
              entry: item.entry,
              status: 'failed',
              message: item.reason,
              warnings: [],
              activityId: null,
              existingActivityId: null,
            });
            await progress(item.entry);
            continue;
          }
          if (++activityFiles > IMPORT_LIMITS.maxImportFiles) {
            report.sourceErrors.push({
              file: file.name,
              message: `Stopped after ${IMPORT_LIMITS.maxImportFiles} activity files; import the rest separately`,
            });
            break;
          }
          if (options.isCancelled?.()) {
            report.cancelled = true;
            break;
          }
          await progress(item.entry ?? file.name);
          for (const o of await this.importText(
            file.name,
            item.entry,
            item.format,
            item.text,
            options,
          ))
            record(o);
          // Report updated counts right after each file, so the screen never lags by one.
          await progress(item.entry ?? file.name);
        }
      } catch (e) {
        if (!(e instanceof ArchiveError)) throw e;
        report.sourceErrors.push({ file: file.name, message: e.message });
      }
      await progress(null);
      if (report.cancelled) break;
    }
    report.finishedAt = Date.now();
    return report;
  }

  private async importText(
    file: string,
    entry: string | null,
    format: 'gpx' | 'tcx',
    text: string,
    options: BulkImportOptions,
  ): Promise<ImportOutcome[]> {
    const base = { file, warnings: [] as string[], activityId: null, existingActivityId: null };
    let tracks: ParsedTrack[];
    try {
      tracks = format === 'gpx' ? [parseGpxTrack(text)] : parseTcx(text);
    } catch (e) {
      return [{ ...base, entry, status: 'failed', message: (e as Error).message }];
    }
    const out: ImportOutcome[] = [];
    for (const [i, track] of tracks.entries()) {
      const label = tracks.length > 1 ? `${entry ?? file}#${i + 1}` : entry;
      try {
        const sportType = track.sportType ? undefined : options.fallbackSportType;
        const r = await this.activities.importTrack(track, {
          timezone: options.timezone,
          userId: options.userId ?? null,
          ...(sportType ? { sportType } : {}),
        });
        out.push({
          ...base,
          entry: label,
          status: 'imported',
          message: null,
          warnings: r.warnings,
          activityId: r.activityId,
        });
      } catch (e) {
        if (!(e instanceof ImportError)) throw e;
        out.push({
          ...base,
          entry: label,
          status:
            e.code === 'duplicate'
              ? 'duplicate'
              : e.code === 'sport_required'
                ? 'needs_sport'
                : 'failed',
          message:
            e.code === 'sport_required'
              ? 'The file does not say which sport this is. Choose a sport for such files and import again.'
              : e.message,
          warnings: track.warnings,
          existingActivityId: e.existingActivityId ?? null,
        });
      }
    }
    return out;
  }
}
