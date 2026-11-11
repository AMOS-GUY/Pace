import type { JournalEntry } from '@pace/activity-engine';
import { locationSampleSchema } from '@pace/validation';

/** A journal entry exactly as the Swift module serialises it. */
export interface NativeEntry {
  sequence: number;
  sample: unknown;
}

/**
 * Validates samples crossing the native boundary. Entries are never silently dropped: a dropped
 * entry would leave a hole in the gap-free sequence. Delivery stops at the first malformed entry
 * (a native bug); it and everything after it stay in the native journal and the error is reported.
 */
export function toEntries(
  raw: readonly NativeEntry[],
  onInvalid: (msg: string) => void,
): JournalEntry[] {
  const out: JournalEntry[] = [];
  for (const e of raw) {
    const parsed = locationSampleSchema.safeParse(e.sample);
    if (!parsed.success || !Number.isInteger(e.sequence)) {
      onInvalid(
        `Malformed native sample #${e.sequence}: ${parsed.success ? 'bad sequence' : (parsed.error.issues[0]?.message ?? 'unknown')}. ` +
          'Later samples are kept in the native journal.',
      );
      break;
    }
    out.push({ sequence: e.sequence, sample: parsed.data });
  }
  return out;
}
