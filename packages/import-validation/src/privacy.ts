/**
 * Privacy controls for validation output. Reports must be shareable: they never contain file or
 * folder names, account emails, coordinates, device serial numbers, activity titles, absolute
 * times or raw sensor series.
 *
 * Three layers:
 * 1. The harness only ever writes aggregates keyed by anonymous scenario IDs (V1, F2, A1, …).
 * 2. Every free-text string that came from a parser, the import pipeline or the file system
 *    (warnings, refusal reasons, error messages) goes through `scrub()`.
 * 3. Before anything is printed or written, `assertNoLeak()` checks the complete serialised
 *    output against every secret collected while reading the files, and against patterns for
 *    emails, paths and coordinates. A hit stops the run without printing the offending value.
 */
import { homedir, userInfo } from 'node:os';
import { basename } from 'node:path';

/** Thrown when output would contain personal data. Its message names the kind, never the value. */
export class PrivacyLeakError extends Error {}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
/** Absolute Windows paths, UNC paths and POSIX paths with at least two components. */
const PATH =
  /(?:[A-Za-z]:[\\/]|\\\\)[^\s'"`<>|]*|(?:^|[\s('"`=])(?:~|\.{1,2})?(?:\/[^\s/'"`<>|]+){2,}/g;
/** A decimal with four or more decimals is at least 11 m of coordinate precision. */
const COORDINATE = /-?\d{1,3}\.\d{4,}/g;
/** Serial numbers, unit IDs, activity IDs and millisecond timestamps. */
const LONG_NUMBER = /\d{8,}/g;
const DATE_TIME = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?(?: UTC)?)?\b/g;
const QUOTED_TITLE = /“[^”]*”|"[^"]{1,200}"/g;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Secrets collected while reading the input; nothing here is ever printed. */
export class Secrets {
  /** Values that must never appear in output (paths, file names, serials, emails). */
  private readonly strict = new Set<string>();
  /** Values that are scrubbed from text but may be ordinary words (titles, short stems). */
  private readonly soft = new Set<string>();

  constructor() {
    try {
      const home = homedir();
      if (home.length >= 4) this.strict.add(home);
      const user = userInfo().username;
      if (user.length >= 4) this.soft.add(user);
    } catch {
      // No home directory or user (sandboxed environments): nothing to protect.
    }
  }

  /**
   * A file or folder path: the path itself, its file name and its stem. A folder's own name
   * ("exports", "report") is often an ordinary word that fixed report text uses too, so it is
   * scrubbed from messages but does not block output; its full path always does.
   */
  addPath(path: string, kind: 'file' | 'folder' = 'file'): void {
    if (path.length >= 4) this.strict.add(path);
    for (const m of path.match(EMAIL) ?? []) this.strict.add(m);
    const name = basename(path.replace(/\\/g, '/'));
    if (kind === 'folder') {
      if (name.length >= 4) (/[\d@._-]/.test(name) ? this.strict : this.soft).add(name);
      return;
    }
    if (name.length >= 4) this.strict.add(name);
    const stem = name.replace(/(\.(fit|gpx|tcx|zip|gz|json))+$/i, '');
    if (stem.length >= 4) (/[\d@._-]/.test(stem) ? this.strict : this.soft).add(stem);
  }

  /** A device identifier (serial number, unit ID). */
  addIdentifier(value: string | number): void {
    const s = String(value);
    if (s.length >= 4) this.strict.add(s);
  }

  /** Free text written by a person (activity title, notes). */
  addText(value: string | null | undefined): void {
    if (!value) return;
    const t = value.trim();
    if (t.length >= 6) this.soft.add(t);
    for (const m of t.match(EMAIL) ?? []) this.strict.add(m);
  }

  /** Every protected value, longest first so a path is replaced before its file name. */
  all(): string[] {
    return [...new Set([...this.strict, ...this.soft])].sort((a, b) => b.length - a.length);
  }

  strictValues(): string[] {
    return [...this.strict].sort((a, b) => b.length - a.length);
  }
}

/**
 * Removes personal data from a message: known secrets, emails, paths, coordinates, long numbers,
 * date-times and quoted titles. The result is capped in length.
 */
export function scrub(text: string, secrets?: Secrets): string {
  let out = String(text);
  for (const s of secrets?.all() ?? [])
    out = out.replace(new RegExp(escapeRegExp(s), 'gi'), '[redacted]');
  out = out
    .replace(EMAIL, '[email]')
    .replace(PATH, (m) => `${/^[\s('"`=]/.test(m) ? m[0] : ''}[path]`)
    .replace(DATE_TIME, '[time]')
    .replace(COORDINATE, '[number]')
    .replace(LONG_NUMBER, '[id]')
    .replace(QUOTED_TITLE, '“[title]”');
  return out.length > 400 ? `${out.slice(0, 400)}…` : out;
}

/**
 * Refuses output that contains a secret or anything shaped like an email, a path or a
 * coordinate. The error says what kind of data it found, never the data.
 */
export function assertNoLeak(output: string, secrets: Secrets): void {
  const lower = output.toLowerCase();
  for (const s of secrets.strictValues())
    if (lower.includes(s.toLowerCase()))
      throw new PrivacyLeakError(
        'Output withheld: it would contain a file name, path or device identifier',
      );
  const checks: Array<[RegExp, string]> = [
    [EMAIL, 'an email address'],
    [PATH, 'a file path'],
    [COORDINATE, 'a coordinate-like number'],
    [LONG_NUMBER, 'a long identifier-like number'],
  ];
  for (const [re, kind] of checks) {
    re.lastIndex = 0;
    if (re.test(output)) {
      re.lastIndex = 0;
      throw new PrivacyLeakError(`Output withheld: it would contain ${kind}`);
    }
  }
}

/** Rounds numbers for reports so no value carries coordinate-level precision. */
export const round = (n: number, digits = 1): number => {
  const f = 10 ** Math.min(digits, 3);
  return Math.round(n * f) / f;
};
