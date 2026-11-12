/**
 * Reads the totals a device wrote into a FIT file (session and lap summaries) for the
 * informational "device" comparison. Uses PACE's own decoder unchanged; nothing here affects
 * what PACE imports.
 *
 * Field numbers follow the published FIT profile (session/lap: 2 start_time, 7 total_elapsed_time
 * and 8 total_timer_time in ms, 9 total_distance in cm; session 26 num_laps). Like the importer's
 * own mappings, these must be confirmed against real device files (see the M4.7 matrix).
 *
 * Device identifiers (file_id and device_info serial numbers) are read only to add them to the
 * privacy secrets so they can never appear in output; they are not returned.
 */
import { FIT_MIN_UTC_TIMESTAMP, type FitValue, decodeFit, fitTimeToMs } from '@pace/formats';
import type { Secrets } from './privacy';

export interface DeviceSummary {
  startedAt: number | null;
  elapsedSeconds: number | null;
  timerSeconds: number | null;
  distanceMeters: number | null;
}

export interface DeviceTotals {
  /** Number of chained FIT files; device comparisons are only made for a single file. */
  files: number;
  sessions: Array<DeviceSummary & { numLaps: number | null }>;
  laps: DeviceSummary[];
}

const FILE_ID = 0;
const SESSION = 18;
const LAP = 19;
const DEVICE_INFO = 23;
const SERIAL_NUMBER = 3;

const num = (v: FitValue | undefined): number | null => (typeof v === 'number' ? v : null);
const time = (v: FitValue | undefined): number | null => {
  const n = num(v);
  return n != null && n >= FIT_MIN_UTC_TIMESTAMP ? fitTimeToMs(n) : null;
};
const scaled = (v: FitValue | undefined, scale: number): number | null => {
  const n = num(v);
  return n == null ? null : n / scale;
};

function summary(fields: Map<number, FitValue>): DeviceSummary {
  return {
    startedAt: time(fields.get(2)),
    elapsedSeconds: scaled(fields.get(7), 1000),
    timerSeconds: scaled(fields.get(8), 1000),
    distanceMeters: scaled(fields.get(9), 100),
  };
}

export function readDeviceTotals(bytes: Uint8Array, secrets: Secrets): DeviceTotals {
  const sessions: DeviceTotals['sessions'] = [];
  const laps: DeviceSummary[] = [];
  const infos = decodeFit(bytes, {
    wants: (g) => g === FILE_ID || g === SESSION || g === LAP || g === DEVICE_INFO,
    onMessage: (m) => {
      if (m.global === FILE_ID || m.global === DEVICE_INFO) {
        const serial = num(m.fields.get(SERIAL_NUMBER));
        if (serial != null) secrets.addIdentifier(serial);
      } else if (m.global === SESSION)
        sessions.push({ ...summary(m.fields), numLaps: num(m.fields.get(26)) });
      else laps.push(summary(m.fields));
    },
  });
  return { files: infos.length, sessions, laps };
}

/** Sum of a session field, or null when any session lacks it. */
export function sessionTotal(
  t: DeviceTotals,
  key: 'elapsedSeconds' | 'timerSeconds' | 'distanceMeters' | 'numLaps',
): number | null {
  if (t.sessions.length === 0) return null;
  let sum = 0;
  for (const s of t.sessions) {
    const v = s[key];
    if (v == null) return null;
    sum += v;
  }
  return sum;
}
