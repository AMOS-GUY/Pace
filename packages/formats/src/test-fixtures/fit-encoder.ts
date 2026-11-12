/**
 * TEST FIXTURES ONLY. A small FIT *writer* used to build test files: activities shaped like
 * real device recordings (laps, timer pauses, multisport sessions, sensors, developer fields,
 * compressed timestamps, big-endian messages, chained files) and deliberately broken files.
 *
 * It is written independently of the decoder under test (own CRC implementation, own value
 * encoding) so the two do not share mistakes. Because it is still our own code, decoding is
 * additionally checked against a hand-assembled byte fixture and, when available, real device
 * files (see docs/TESTING.md, "FIT validation").
 */
import type { LocationSample } from '@pace/domain';

/** Base type bytes as they appear in definition messages. */
export const BT = {
  enum: 0x00,
  sint8: 0x01,
  uint8: 0x02,
  sint16: 0x83,
  uint16: 0x84,
  sint32: 0x85,
  uint32: 0x86,
  string: 0x07,
  float32: 0x88,
  uint8z: 0x0a,
  uint16z: 0x8b,
  uint32z: 0x8c,
  byte: 0x0d,
} as const;

const SIZE: Record<number, number> = {
  0: 1,
  1: 1,
  2: 1,
  3: 2,
  4: 2,
  5: 4,
  6: 4,
  7: 1,
  8: 4,
  9: 8,
  10: 1,
  11: 2,
  12: 4,
  13: 1,
  14: 8,
  15: 8,
  16: 8,
};
const baseSize = (base: number): number => SIZE[base & 0x1f] ?? 1;

/** Bit-by-bit CRC-16/ARC (independent of the decoder's table-driven version). */
export function crc16Bitwise(bytes: ArrayLike<number>): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i]!;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc & 0xffff;
}

export type FieldSpec = [fieldNumber: number, baseType: number, size?: number];
export type FieldValue = number | string | Array<number | null> | null;

const FIT_EPOCH = Date.UTC(1989, 11, 31);
export const fitSeconds = (ms: number): number => Math.round((ms - FIT_EPOCH) / 1000);
export const semicircles = (deg: number): number => Math.round((deg * 2 ** 31) / 180);

/** Writes the record section of a FIT file. */
export class FitWriter {
  private readonly out: number[] = [];
  private readonly defs = new Map<
    number,
    { fields: FieldSpec[]; dev: Array<[number, number, number]>; le: boolean }
  >();
  lastTimestamp: number | null = null;

  constructor(private readonly options: { bigEndian?: boolean } = {}) {}

  get length(): number {
    return this.out.length;
  }

  raw(bytes: ArrayLike<number>): this {
    for (let i = 0; i < bytes.length; i++) this.out.push(bytes[i]!);
    return this;
  }

  define(
    local: number,
    global: number,
    fields: FieldSpec[],
    dev: Array<[fieldNumber: number, size: number, developerDataIndex: number]> = [],
    bigEndian = this.options.bigEndian ?? false,
  ): this {
    const le = !bigEndian;
    this.out.push(0x40 | (dev.length ? 0x20 : 0) | local, 0, le ? 0 : 1);
    this.int(global, 2, le);
    this.out.push(fields.length);
    for (const [n, b, s] of fields) this.out.push(n, s ?? baseSize(b), b);
    if (dev.length) {
      this.out.push(dev.length);
      for (const [n, s, i] of dev) this.out.push(n, s, i);
    }
    this.defs.set(local, { fields, dev, le });
    return this;
  }

  data(local: number, values: FieldValue[], devBytes: number[] = []): this {
    this.out.push(local);
    return this.body(local, values, devBytes);
  }

  /** Data message with a compressed-timestamp header (local 0–3, definition without field 253). */
  compressed(
    local: number,
    timestamp: number,
    values: FieldValue[],
    devBytes: number[] = [],
  ): this {
    const last = this.lastTimestamp;
    if (last == null || timestamp <= last || timestamp - last >= 32)
      throw new Error('compressed timestamp needs a previous timestamp less than 32 s earlier');
    this.out.push(0x80 | (local << 5) | (timestamp & 0x1f));
    this.lastTimestamp = timestamp;
    return this.body(local, values, devBytes);
  }

  bytes(): Uint8Array {
    return Uint8Array.from(this.out);
  }

  private body(local: number, values: FieldValue[], devBytes: number[]): this {
    const def = this.defs.get(local);
    if (!def) throw new Error(`local ${local} not defined`);
    def.fields.forEach(([n, base, s], i) => {
      const size = s ?? baseSize(base);
      const v = values[i] ?? null;
      if (n === 253 && typeof v === 'number') this.lastTimestamp = v;
      this.value(base, size, v, def.le);
    });
    const devSize = def.dev.reduce((t, d) => t + d[1], 0);
    if (devBytes.length !== devSize) throw new Error('developer bytes do not match definition');
    this.out.push(...devBytes);
    return this;
  }

  private value(base: number, size: number, v: FieldValue, le: boolean): void {
    const t = base & 0x1f;
    if (t === 7) {
      const bytes = typeof v === 'string' ? Array.from(new TextEncoder().encode(v)) : [];
      for (let i = 0; i < size; i++)
        this.out.push(i < bytes.length && i < size - 1 ? bytes[i]! : 0);
      return;
    }
    const el = baseSize(base);
    const items = Array.isArray(v) ? v : [v];
    for (let k = 0; k < size / el; k++) this.element(t, el, items[k] ?? null, le);
  }

  private element(t: number, size: number, v: number | null, le: boolean): void {
    const signed = t === 1 || t === 3 || t === 5 || t === 14;
    const zeroInvalid = t === 10 || t === 11 || t === 12 || t === 16;
    if (v == null) {
      const bytes = new Array<number>(size).fill(zeroInvalid ? 0 : 0xff);
      if (signed) bytes[le ? size - 1 : 0] = 0x7f;
      this.out.push(...bytes);
      return;
    }
    if (t === 8) {
      const dv = new DataView(new ArrayBuffer(4));
      dv.setFloat32(0, v, le);
      this.out.push(...new Uint8Array(dv.buffer));
      return;
    }
    const value = signed && v < 0 ? 2 ** (8 * size) + v : v;
    this.int(value, size, le);
  }

  private int(value: number, size: number, le: boolean): void {
    const bytes: number[] = [];
    let x = value;
    for (let i = 0; i < size; i++) {
      bytes.push(x % 256);
      x = Math.floor(x / 256);
    }
    this.out.push(...(le ? bytes : bytes.reverse()));
  }
}

/** Wraps a record section in a header and CRC. */
export function fitFile(
  data: Uint8Array,
  o: { headerSize?: 12 | 14; headerCrc?: boolean; profileVersion?: number } = {},
): Uint8Array {
  const hs = o.headerSize ?? 14;
  const header = [hs, 0x20, 0, 0, 0, 0, 0, 0, 0x2e, 0x46, 0x49, 0x54];
  const profile = o.profileVersion ?? 2132;
  header[2] = profile & 0xff;
  header[3] = profile >> 8;
  for (let i = 0; i < 4; i++) header[4 + i] = Math.floor(data.length / 256 ** i) % 256;
  if (hs === 14) {
    const c = o.headerCrc === false ? 0 : crc16Bitwise(header);
    header.push(c & 0xff, c >> 8);
  }
  const body = [...header, ...data];
  const crc = crc16Bitwise(body);
  return Uint8Array.from([...body, crc & 0xff, crc >> 8]);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------------------------------------------------------------- activity builder

/** FIT sport / sub-sport numbers used in fixtures. */
export const SPORT = {
  generic: 0,
  running: 1,
  cycling: 2,
  transition: 3,
  swimming: 5,
  walking: 11,
  hiking: 17,
  multisport: 18,
  rowing: 15,
} as const;
export const SUB_SPORT = { generic: 0, treadmill: 1, lapSwimming: 17, openWater: 18 } as const;

export interface FitPoint {
  sample: LocationSample;
  hr?: number;
  /** May be fractional (written as cadence + fractional_cadence/128). */
  cadence?: number;
  watts?: number;
  noPosition?: boolean;
  /** Device-measured extras that PACE does not import. */
  distance?: number;
  temperature?: number;
  /** Two raw bytes for the developer field, when the activity defines one. */
  developer?: [number, number];
}

export interface FitSessionInput {
  sport: number;
  subSport?: number;
  /** Laps; each lap is a list of timer-running segments (a gap between them is a pause). */
  laps: FitPoint[][][];
}

export interface FitActivityOptions {
  sessions: FitSessionInput[];
  bigEndian?: boolean;
  /** Write records after the first with compressed timestamp headers where possible. */
  compressTimestamps?: boolean;
  headerSize?: 12 | 14;
  developerField?: { name: string; units: string };
  /** Extra data the decoder must count and report, e.g. HRV (78) or device info (23). */
  extraMessages?: number[];
  /** Write a sport message (12) instead of relying on sessions only. */
  sportMessage?: { sport: number; subSport?: number };
  /** Omit session messages (some files have only records). */
  omitSessions?: boolean;
  calories?: boolean;
  /**
   * Device totals in each session (total_timer_time 8, total_distance 9, num_laps 26), as a
   * device writes them. Off by default so existing fixtures stay byte-identical.
   */
  sessionTotals?: (
    session: FitSessionInput,
    index: number,
  ) => {
    timerSeconds: number | null;
    distanceMeters: number | null;
    numLaps: number | null;
  };
}

const RECORD_FIELDS: FieldSpec[] = [
  [253, BT.uint32],
  [0, BT.sint32],
  [1, BT.sint32],
  [78, BT.uint32],
  [3, BT.uint8],
  [4, BT.uint8],
  [53, BT.uint8],
  [7, BT.uint16],
  [5, BT.uint32],
  [13, BT.sint8],
];

/** Builds a complete activity file (header, messages, CRC). */
export function fitActivity(o: FitActivityOptions): Uint8Array {
  const w = new FitWriter({ bigEndian: o.bigEndian ?? false });
  const all = o.sessions.flatMap((s) => s.laps.flat(2));
  const start = fitSeconds(all[0]!.sample.recordedAt);
  const end = fitSeconds(all[all.length - 1]!.sample.recordedAt);

  w.define(0, 0, [
    [0, BT.enum],
    [1, BT.uint16],
    [2, BT.uint16],
    [3, BT.uint32z],
    [4, BT.uint32],
  ]).data(0, [4, 1, 3122, 3_999_000_111, start]);

  const dev = o.developerField;
  if (dev) {
    w.define(1, 207, [[3, BT.uint8]]).data(1, [0]);
    w.define(1, 206, [
      [0, BT.uint8],
      [1, BT.uint8],
      [2, BT.uint8],
      [3, BT.string, 16],
      [8, BT.string, 8],
    ]).data(1, [0, 0, BT.uint16, dev.name, dev.units]);
  }
  if (o.sportMessage) {
    w.define(1, 12, [
      [0, BT.enum],
      [1, BT.enum],
    ]).data(1, [o.sportMessage.sport, o.sportMessage.subSport ?? 0]);
  }
  for (const g of o.extraMessages ?? []) w.define(1, g, [[0, BT.uint16]]).data(1, [1]);

  // Local 2: records with a full timestamp; local 3: records for compressed headers.
  const devDef: Array<[number, number, number]> = dev ? [[0, 2, 0]] : [];
  w.define(2, 20, RECORD_FIELDS, devDef);
  w.define(3, 20, RECORD_FIELDS.slice(1), devDef);
  w.define(4, 21, [
    [253, BT.uint32],
    [0, BT.enum],
    [1, BT.enum],
    [4, BT.uint8],
  ]);
  w.define(5, 19, [
    [253, BT.uint32],
    [2, BT.uint32],
    [0, BT.enum],
    [1, BT.enum],
    [7, BT.uint32],
    [11, BT.uint16],
  ]);
  w.define(6, 18, [
    [253, BT.uint32],
    [2, BT.uint32],
    [5, BT.enum],
    [6, BT.enum],
    [7, BT.uint32],
    [11, BT.uint16],
    ...(o.sessionTotals
      ? ([
          [8, BT.uint32],
          [9, BT.uint32],
          [26, BT.uint16],
        ] as FieldSpec[])
      : []),
  ]);

  const timer = (t: number, type: number): void => void w.data(4, [t, 0, type, 0]);
  timer(start, 0);

  for (const [sessionIndex, session] of o.sessions.entries()) {
    const sPts = session.laps.flat(2);
    const sStart = fitSeconds(sPts[0]!.sample.recordedAt);
    for (const lap of session.laps) {
      const lPts = lap.flat();
      const lStart = fitSeconds(lPts[0]!.sample.recordedAt);
      lap.forEach((segment, si) => {
        if (si > 0) timer(fitSeconds(segment[0]!.sample.recordedAt), 0);
        for (const p of segment) {
          const t = fitSeconds(p.sample.recordedAt);
          const cad = p.cadence == null ? null : Math.floor(p.cadence);
          const frac =
            p.cadence == null ? null : Math.round((p.cadence - Math.floor(p.cadence)) * 128);
          const values: FieldValue[] = [
            p.noPosition ? null : semicircles(p.sample.latitude),
            p.noPosition ? null : semicircles(p.sample.longitude),
            p.sample.altitudeMeters == null
              ? null
              : Math.round((p.sample.altitudeMeters + 500) * 5),
            p.hr ?? null,
            cad,
            frac === 0 && cad != null ? null : frac,
            p.watts ?? null,
            p.distance == null ? null : Math.round(p.distance * 100),
            p.temperature ?? null,
          ];
          const devBytes = dev ? (p.developer ?? [0xff, 0xff]) : [];
          const last = w.lastTimestamp;
          if (o.compressTimestamps && last != null && t > last && t - last < 32)
            w.compressed(3, t, values, devBytes);
          else w.data(2, [t, ...values], devBytes);
        }
        if (si < lap.length - 1)
          timer(fitSeconds(segment[segment.length - 1]!.sample.recordedAt), 4);
      });
      const lEnd = fitSeconds(lPts[lPts.length - 1]!.sample.recordedAt);
      w.data(5, [lEnd, lStart, 9, 1, (lEnd - lStart) * 1000, o.calories ? 50 : null]);
    }
    if (!o.omitSessions) {
      const sEnd = fitSeconds(sPts[sPts.length - 1]!.sample.recordedAt);
      w.data(6, [
        sEnd,
        sStart,
        session.sport,
        session.subSport ?? 0,
        (sEnd - sStart) * 1000,
        o.calories ? 400 : null,
        ...(o.sessionTotals
          ? (() => {
              const t = o.sessionTotals(session, sessionIndex);
              return [
                t.timerSeconds == null ? null : Math.round(t.timerSeconds * 1000),
                t.distanceMeters == null ? null : Math.round(t.distanceMeters * 100),
                t.numLaps,
              ];
            })()
          : []),
      ]);
    }
  }
  timer(end, 4);
  w.define(7, 34, [
    [253, BT.uint32],
    [1, BT.uint16],
    [2, BT.enum],
  ]).data(7, [end, o.sessions.length, 0]);
  return fitFile(w.bytes(), { headerSize: o.headerSize ?? 14 });
}

/** One timer-running segment of points with optional sensors. */
export function fitPoints(
  samples: readonly LocationSample[],
  o: { hr?: boolean; cadence?: number; watts?: number } = {},
): FitPoint[] {
  return samples.map((sample, i) => ({
    sample,
    ...(o.hr ? { hr: 130 + (i % 20) } : {}),
    ...(o.cadence != null ? { cadence: o.cadence } : {}),
    ...(o.watts != null ? { watts: o.watts + (i % 10) } : {}),
  }));
}
