import { IMPORT_LIMITS } from '@pace/validation';
import { Gunzip, Unzip, UnzipInflate, type UnzipFile, strFromU8 } from 'fflate';
import { looksLikeFit } from './fit-decoder';

/**
 * Reads activity files out of what the athlete picked: single GPX/TCX/FIT files, gzip-compressed
 * files (`.gpx.gz`, `.tcx.gz`, `.fit.gz`) and ZIP archives such as account exports from other services.
 *
 * Safety model:
 * - Everything is streamed: the archive is read in chunks and each activity file is handed out
 *   as soon as it is complete, so memory stays bounded by one file (≤ maxEntryBytes).
 * - Limits apply to bytes actually produced by decompression, never to sizes an archive claims,
 *   so a ZIP bomb is stopped after maxEntryBytes per file / maxTotalUncompressedBytes in total.
 * - Nothing is ever written to disk and entry names are never used as paths; names with
 *   traversal segments, absolute paths or control characters are still refused and reported.
 * - Nested archives are not opened (except `.gz` activity files, one level).
 * - Every entry is accounted for: activity files are yielded, everything else is reported as
 *   skipped or rejected with a reason.
 */

export type ByteSource = AsyncIterable<Uint8Array>;

export type ActivityFileFormat = 'gpx' | 'tcx' | 'fit';

export type SourceItem =
  /** A decompressed activity file ready to parse. `entry` is the path inside an archive. */
  | { kind: 'file'; entry: string | null; format: 'gpx' | 'tcx'; text: string }
  /** A decompressed binary FIT file, checked by the FIT decoder when it is parsed. */
  | { kind: 'file'; entry: string | null; format: 'fit'; bytes: Uint8Array }
  /** Not an activity file (photos, CSV, …). Reported in aggregate, not as a failure. */
  | { kind: 'skipped'; entry: string; reason: string }
  /** An activity-like file that cannot be read safely or is not supported. */
  | { kind: 'rejected'; entry: string | null; reason: string };

export interface ArchiveLimits {
  maxArchiveBytes: number;
  maxArchiveEntries: number;
  maxEntryBytes: number;
  maxTotalUncompressedBytes: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxArchiveBytes: IMPORT_LIMITS.maxArchiveBytes,
  maxArchiveEntries: IMPORT_LIMITS.maxArchiveEntries,
  maxEntryBytes: IMPORT_LIMITS.maxEntryBytes,
  maxTotalUncompressedBytes: IMPORT_LIMITS.maxTotalUncompressedBytes,
};

/** Stops the whole source (the archive itself is unusable or exceeds a global limit). */
export class ArchiveError extends Error {}

type Kind =
  | { type: 'activity'; format: ActivityFileFormat; gzip: boolean }
  | { type: 'zip' }
  | { type: 'other' };

/** Classifies by name; `.gz` is only unwrapped around an activity file. */
export function classifyName(name: string): Kind {
  const n = name.toLowerCase();
  const gzip = n.endsWith('.gz');
  const base = gzip ? n.slice(0, -3) : n;
  if (base.endsWith('.gpx')) return { type: 'activity', format: 'gpx', gzip };
  if (base.endsWith('.tcx')) return { type: 'activity', format: 'tcx', gzip };
  if (base.endsWith('.fit')) return { type: 'activity', format: 'fit', gzip };
  if (!gzip && n.endsWith('.zip')) return { type: 'zip' };
  return { type: 'other' };
}

/** Why an archive entry name is refused, or null when it is safe to report and process. */
export function unsafeEntryName(name: string): string | null {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (/[\u0000-\u001f]/.test(name)) return 'name contains control characters';
  if (name.length > 512) return 'name is too long';
  if (/^([a-zA-Z]:)?[\\/]/.test(name)) return 'absolute path';
  if (name.split(/[\\/]+/).some((part) => part === '..')) return 'path leaves the archive (..)';
  return null;
}

/** Detects what a top-level file is from its first bytes when its name is not conclusive. */
function sniff(head: Uint8Array): Kind {
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04)
    return { type: 'zip' };
  if (head[0] === 0x1f && head[1] === 0x8b) return { type: 'other' }; // gzip of unknown content
  if (looksLikeFit(head)) return { type: 'activity', format: 'fit', gzip: false };
  const start = strFromU8(head.slice(0, Math.min(head.length, 512))).replace(/^\uFEFF/, '');
  if (/<gpx[\s>]/i.test(start)) return { type: 'activity', format: 'gpx', gzip: false };
  if (/<TrainingCenterDatabase[\s>]/.test(start))
    return { type: 'activity', format: 'tcx', gzip: false };
  return { type: 'other' };
}

/** The item for a decompressed activity file: bytes for FIT, checked UTF-8 text for XML. */
function fileItem(entry: string | null, format: ActivityFileFormat, bytes: Uint8Array): SourceItem {
  return format === 'fit'
    ? { kind: 'file', entry, format, bytes }
    : { kind: 'file', entry, format, text: decodeText(bytes) };
}

/** UTF-8 text of a decompressed activity file; refuses encodings the XML parsers cannot read. */
function decodeText(bytes: Uint8Array): string {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
    throw new Error('UTF-16 encoded files are not supported; save the file as UTF-8');
  return strFromU8(bytes).replace(/^\uFEFF/, '');
}

class Budget {
  private total = 0;
  constructor(private readonly limits: ArchiveLimits) {}
  /** Adds decompressed bytes; throws once the archive-wide limit is exceeded. */
  add(n: number): void {
    this.total += n;
    if (this.total > this.limits.maxTotalUncompressedBytes)
      throw new ArchiveError(
        `The archive expands to more than ${Math.round(this.limits.maxTotalUncompressedBytes / 1024 / 1024)} MB of activity data; import it in smaller parts`,
      );
  }
}

/** Concatenates chunks, enforcing a per-file limit while they arrive. */
class Collector {
  private chunks: Uint8Array[] = [];
  size = 0;
  overflow = false;
  constructor(private readonly max: number) {}
  push(chunk: Uint8Array): void {
    if (this.overflow) return;
    this.size += chunk.length;
    if (this.size > this.max) {
      this.overflow = true;
      this.chunks = [];
      return;
    }
    this.chunks.push(chunk);
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.size);
    let o = 0;
    for (const c of this.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC-32 as stored in a gzip trailer. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = (c >>> 8) ^ CRC32_TABLE[(c ^ bytes[i]!) & 0xff]!;
  return (c ^ 0xffffffff) >>> 0;
}

const u32le = (b: Uint8Array, p: number): number =>
  (b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16) | (b[p + 3]! << 24)) >>> 0;

/**
 * Decompresses a gzip stream with a size cap. The decompressor does not check the gzip header
 * or trailer, so both are verified here: a damaged or cut-off .gz must never pass as a shorter
 * file. (Only single-member gzip files are accepted, which is what export services write.)
 */
function gunzipCapped(data: Uint8Array, max: number, budget: Budget): Uint8Array {
  if (data[0] !== 0x1f || data[1] !== 0x8b || data[2] !== 8)
    throw new Error('the file is not gzip-compressed data');
  const out = new Collector(max);
  let complete = false;
  const g = new Gunzip((chunk, final) => {
    out.push(chunk);
    budget.add(chunk.length);
    if (final) complete = true;
  });
  // Push in slices so an overflow is noticed early rather than after inflating everything.
  const step = 64 * 1024;
  for (let i = 0; i < data.length && !out.overflow; i += step)
    g.push(data.subarray(i, i + step), i + step >= data.length);
  if (out.overflow)
    throw new Error(`decompresses to more than ${Math.round(max / 1024 / 1024)} MB`);
  const bytes = out.bytes();
  const damaged = new Error('the compressed data is incomplete or damaged');
  if (!complete || data.length < 18) throw damaged;
  const end = data.length - 8;
  if (u32le(data, end) !== crc32(bytes) || u32le(data, end + 4) !== bytes.length % 2 ** 32)
    throw damaged;
  return bytes;
}

const mb = (n: number): string => `${Math.round(n / 1024 / 1024)} MB`;

/**
 * Yields every activity file in a picked file (single file, .gz or .zip), plus a skipped or
 * rejected item for everything else. Throws ArchiveError only when the source as a whole cannot
 * be read further; items yielded before that remain valid.
 */
export async function* readImportSource(
  name: string,
  source: ByteSource,
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): AsyncGenerator<SourceItem> {
  const iterator = source[Symbol.asyncIterator]();
  let read = 0;
  const pending: Uint8Array[] = [];
  const next = async (): Promise<Uint8Array | null> => {
    if (pending.length) return pending.shift()!;
    const r = await iterator.next();
    if (r.done) return null;
    read += r.value.length;
    if (read > limits.maxArchiveBytes)
      throw new ArchiveError(`The file is larger than ${mb(limits.maxArchiveBytes)}`);
    return r.value;
  };
  const first = await next();
  if (!first || first.length === 0) {
    yield { kind: 'rejected', entry: null, reason: 'The file is empty' };
    return;
  }
  pending.push(first);

  let kind = classifyName(name);
  if (kind.type === 'other') kind = sniff(first);
  const budget = new Budget(limits);

  if (kind.type === 'other') {
    yield {
      kind: 'rejected',
      entry: null,
      reason:
        'Not a GPX, TCX, FIT or ZIP file. PACE imports .gpx, .tcx, .fit, their .gz versions and .zip archives.',
    };
    return;
  }
  if (kind.type === 'activity') {
    // A single file: compressed size is bounded too, so a .gz cannot be a bomb.
    const raw = new Collector(limits.maxEntryBytes);
    for (let c = await next(); c; c = await next()) {
      raw.push(c);
      if (raw.overflow) break;
    }
    if (raw.overflow) {
      yield {
        kind: 'rejected',
        entry: null,
        reason: `The file is larger than ${mb(limits.maxEntryBytes)}`,
      };
      return;
    }
    try {
      const bytes = kind.gzip
        ? gunzipCapped(raw.bytes(), limits.maxEntryBytes, budget)
        : raw.bytes();
      yield fileItem(null, kind.format, bytes);
    } catch (e) {
      if (e instanceof ArchiveError) throw e;
      yield {
        kind: 'rejected',
        entry: null,
        reason: `Could not read the file: ${(e as Error).message}`,
      };
    }
    return;
  }

  // ZIP: stream entries.
  const ready: SourceItem[] = [];
  /** Activity entries whose data has started but not finished (a truncated archive). */
  const unfinished = new Set<string>();
  let entries = 0;
  let fatal: ArchiveError | null = null;
  const unzip = new Unzip((file: UnzipFile) => {
    if (fatal) return;
    const entry = file.name;
    if (entry.endsWith('/')) return; // directory record, not a file
    if (++entries > limits.maxArchiveEntries) {
      fatal = new ArchiveError(`The archive has more than ${limits.maxArchiveEntries} files`);
      return;
    }
    const unsafe = unsafeEntryName(entry);
    if (unsafe) {
      ready.push({ kind: 'rejected', entry, reason: `Unsafe file name in archive (${unsafe})` });
      return;
    }
    const k = classifyName(entry);
    if (k.type === 'zip') {
      ready.push({
        kind: 'rejected',
        entry,
        reason: 'Archives inside archives are not opened; import it separately',
      });
      return;
    }
    if (k.type === 'other') {
      ready.push({ kind: 'skipped', entry, reason: 'Not an activity file' });
      return;
    }
    const out = new Collector(limits.maxEntryBytes);
    unfinished.add(entry);
    file.ondata = (err, chunk, final) => {
      if (fatal) return;
      if (err || final || out.overflow) unfinished.delete(entry);
      if (err) {
        ready.push({ kind: 'rejected', entry, reason: `Could not decompress: ${err.message}` });
        return;
      }
      try {
        budget.add(chunk.length);
      } catch (e) {
        fatal = e as ArchiveError;
        file.terminate();
        return;
      }
      out.push(chunk);
      if (out.overflow) {
        unfinished.delete(entry);
        file.terminate();
        ready.push({
          kind: 'rejected',
          entry,
          reason: `Decompresses to more than ${mb(limits.maxEntryBytes)} (possible ZIP bomb)`,
        });
        return;
      }
      if (!final) return;
      try {
        const bytes = k.gzip
          ? gunzipCapped(out.bytes(), limits.maxEntryBytes, budget)
          : out.bytes();
        ready.push(fileItem(entry, k.format, bytes));
      } catch (e) {
        if (e instanceof ArchiveError) fatal = e;
        else
          ready.push({
            kind: 'rejected',
            entry,
            reason: `Could not read: ${(e as Error).message}`,
          });
      }
    };
    try {
      file.start();
    } catch {
      unfinished.delete(entry);
      ready.push({ kind: 'rejected', entry, reason: 'Uses a compression method PACE cannot read' });
    }
  });
  unzip.register(UnzipInflate);

  let sawEnd = false;
  for (let c = await next(); ; c = await next()) {
    try {
      if (c) unzip.push(c, false);
      else {
        unzip.push(new Uint8Array(0), true);
        sawEnd = true;
      }
    } catch (e) {
      // fflate reports a truncated archive as "invalid zip data" on the final push.
      fatal ??= new ArchiveError(
        `The ZIP archive is damaged or incomplete: ${(e as Error).message}`,
      );
    }
    while (ready.length) yield ready.shift()!;
    if (fatal || sawEnd) break;
  }
  // Files whose data never finished are reported before any archive-level error.
  for (const entry of unfinished)
    yield { kind: 'rejected', entry, reason: 'The archive ended before this file was complete' };
  if (fatal) throw fatal;
  if (entries === 0) throw new ArchiveError('The ZIP archive contains no files');
}

/** In-memory byte source (tests, small files), split into chunks of `chunkSize`. */
export async function* bytesSource(
  bytes: Uint8Array,
  chunkSize = 256 * 1024,
): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += chunkSize) yield bytes.subarray(i, i + chunkSize);
}
