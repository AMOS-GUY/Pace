import { strFromU8 } from 'fflate';

/**
 * Independent, read-only decoder for the binary FIT container, written for PACE from the
 * publicly documented file structure. It contains no code or generated profile tables from
 * Garmin's FIT SDK (see docs/DECISIONS.md, D22). It knows nothing about what messages mean;
 * `fit.ts` interprets the few messages PACE imports.
 *
 * Structure handled:
 * - File header of 12 or 14 bytes (`.FIT` signature, declared data size, optional header CRC),
 *   then records, then a 2-byte CRC over header and data. Several FIT files may be chained back
 *   to back in one buffer; each is framed and checked on its own.
 * - Definition messages (little- or big-endian, optional developer fields) and data messages
 *   for local message types 0–15; compressed-timestamp record headers.
 *
 * Safety: the whole input is bounded (`maxBytes`) and every chained file is framed and its CRCs
 * verified BEFORE any message is decoded, so a damaged or truncated file yields no data at all.
 * Every read is bounds-checked against the end of the current file; message, chained-file and
 * definition counts are limited; nothing is allocated from an unchecked length (field sizes are
 * single bytes, so a value is at most 255 bytes).
 */

export type FitErrorCode = 'not_fit' | 'truncated' | 'checksum' | 'malformed' | 'limit';

export class FitDecodeError extends Error {
  constructor(
    message: string,
    readonly code: FitErrorCode,
  ) {
    super(message);
  }
}

export interface FitDecodeLimits {
  /** Size of the whole input (all chained files). */
  maxBytes: number;
  /** Messages of any kind across all chained files. */
  maxMessages: number;
  maxChainedFiles: number;
}

export const DEFAULT_FIT_LIMITS: FitDecodeLimits = {
  maxBytes: 25 * 1024 * 1024,
  maxMessages: 2_000_000,
  maxChainedFiles: 64,
};

/** A decoded field value; invalid ("not set") values are left out of the message entirely. */
export type FitValue = number | string | Array<number | null>;

export interface FitMessage {
  /** Index of the chained file this message belongs to (0 for a normal file). */
  fileIndex: number;
  /** Global message number. */
  global: number;
  /** Field definition number → value. Only valid values are present. */
  fields: Map<number, FitValue>;
  /** Developer fields present in this message (values are not decoded). */
  developerFields: Array<{ developerDataIndex: number; fieldNumber: number; size: number }>;
  /** FIT timestamp in seconds (field 253 or a compressed-timestamp header), if any. */
  timestamp: number | null;
}

export interface FitFileInfo {
  headerSize: number;
  protocolVersion: number;
  profileVersion: number;
  dataSize: number;
  /** Global message number → number of data messages, for every message in the file. */
  messageCounts: Map<number, number>;
  compressedTimestampMessages: number;
  /** Fields skipped because their base type or size could not be interpreted. */
  uninterpretableFields: number;
}

export interface FitDecodeOptions {
  /** Called for every data message whose global number `wants` accepts (default: all). */
  onMessage?: (message: FitMessage) => void;
  /** Which messages to decode fully; others are only counted (their timestamp is still read). */
  wants?: (global: number) => boolean;
  limits?: Partial<FitDecodeLimits>;
}

/** FIT time is seconds since 1989-12-31T00:00:00Z. */
export const FIT_EPOCH_MS = Date.UTC(1989, 11, 31);

/** Timestamps below this are seconds since device power-up, not UTC (the clock was not set). */
export const FIT_MIN_UTC_TIMESTAMP = 0x10000000;

export const fitTimeToMs = (seconds: number): number => FIT_EPOCH_MS + seconds * 1000;

const TIMESTAMP_FIELD = 253;

// ---------------------------------------------------------------- CRC-16 (CRC-16/ARC)

const CRC_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
    t[i] = c;
  }
  return t;
})();

/** CRC-16 used by FIT (reflected polynomial 0xA001, initial value 0 — "CRC-16/ARC"). */
export function fitCrc16(bytes: Uint8Array, start = 0, end = bytes.length, crc = 0): number {
  let c = crc;
  for (let i = start; i < end; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]!) & 0xff]!;
  return c & 0xffff;
}

// ---------------------------------------------------------------- base types

type Kind = 'uint' | 'sint' | 'float' | 'string' | 'byte';

interface BaseType {
  size: number;
  kind: Kind;
  /** Value-less marker: all ones (`max`), signed max (`smax`) or zero (`zero`). */
  invalid: 'max' | 'smax' | 'zero' | 'nul';
}

/** Indexed by the base type number (low five bits of the base type byte). */
const BASE_TYPES: Array<BaseType | undefined> = [
  { size: 1, kind: 'uint', invalid: 'max' }, //  0 enum
  { size: 1, kind: 'sint', invalid: 'smax' }, //  1 sint8
  { size: 1, kind: 'uint', invalid: 'max' }, //  2 uint8
  { size: 2, kind: 'sint', invalid: 'smax' }, //  3 sint16
  { size: 2, kind: 'uint', invalid: 'max' }, //  4 uint16
  { size: 4, kind: 'sint', invalid: 'smax' }, //  5 sint32
  { size: 4, kind: 'uint', invalid: 'max' }, //  6 uint32
  { size: 1, kind: 'string', invalid: 'nul' }, //  7 string
  { size: 4, kind: 'float', invalid: 'max' }, //  8 float32
  { size: 8, kind: 'float', invalid: 'max' }, //  9 float64
  { size: 1, kind: 'uint', invalid: 'zero' }, // 10 uint8z
  { size: 2, kind: 'uint', invalid: 'zero' }, // 11 uint16z
  { size: 4, kind: 'uint', invalid: 'zero' }, // 12 uint32z
  { size: 1, kind: 'byte', invalid: 'max' }, // 13 byte
  { size: 8, kind: 'sint', invalid: 'smax' }, // 14 sint64
  { size: 8, kind: 'uint', invalid: 'max' }, // 15 uint64
  { size: 8, kind: 'uint', invalid: 'zero' }, // 16 uint64z
];

interface FieldDef {
  number: number;
  size: number;
  base: BaseType | undefined;
}

interface Definition {
  global: number;
  littleEndian: boolean;
  fields: FieldDef[];
  developerFields: Array<{ fieldNumber: number; size: number; developerDataIndex: number }>;
  /** Bytes of one data message (excluding its record header). */
  length: number;
  /** Offset of field 253 (uint32) within the message, or -1. */
  timestampOffset: number;
}

/** Unsigned integer of `size` bytes (1, 2, 4 or 8; 8 is exact only up to 2^53). */
function readUint(b: Uint8Array, p: number, size: number, le: boolean): number {
  let v = 0;
  if (size === 8) {
    const lo = readUint(b, le ? p : p + 4, 4, le);
    const hi = readUint(b, le ? p + 4 : p, 4, le);
    return hi * 2 ** 32 + lo;
  }
  for (let i = 0; i < size; i++) v = v * 256 + b[le ? p + size - 1 - i : p + i]!;
  return v;
}

function isAllOnes(b: Uint8Array, p: number, size: number): boolean {
  for (let i = 0; i < size; i++) if (b[p + i] !== 0xff) return false;
  return true;
}

function isZero(b: Uint8Array, p: number, size: number): boolean {
  for (let i = 0; i < size; i++) if (b[p + i] !== 0) return false;
  return true;
}

/** Signed maximum (0x7F…FF) in the message's byte order. */
function isSignedMax(b: Uint8Array, p: number, size: number, le: boolean): boolean {
  for (let i = 0; i < size; i++) {
    const byte = b[le ? p + i : p + size - 1 - i]!;
    if (byte !== (i === size - 1 ? 0x7f : 0xff)) return false;
  }
  return true;
}

/** One element of a field, or null when it holds the type's invalid marker. */
function readElement(b: Uint8Array, p: number, t: BaseType, le: boolean): number | null {
  const n = t.size;
  if (t.invalid === 'max' && isAllOnes(b, p, n)) return null;
  if (t.invalid === 'zero' && isZero(b, p, n)) return null;
  if (t.invalid === 'smax' && isSignedMax(b, p, n, le)) return null;
  if (t.kind === 'float') {
    const view = new DataView(b.buffer, b.byteOffset + p, n);
    const v = n === 4 ? view.getFloat32(0, le) : view.getFloat64(0, le);
    return Number.isFinite(v) ? v : null;
  }
  const u = readUint(b, p, n, le);
  if (t.kind !== 'sint') return u;
  const half = 2 ** (8 * n - 1);
  return u >= half ? u - 2 * half : u;
}

/** Field value, or null when invalid / uninterpretable (`counted` reports the latter). */
function readField(
  b: Uint8Array,
  p: number,
  f: FieldDef,
  le: boolean,
  counted: { uninterpretable: number },
): FitValue | null {
  const t = f.base;
  if (!t || f.size % t.size !== 0) {
    counted.uninterpretable++;
    return null;
  }
  if (t.kind === 'string') {
    let end = p;
    while (end < p + f.size && b[end] !== 0) end++;
    if (end === p) return null;
    try {
      return strFromU8(b.subarray(p, end));
    } catch {
      counted.uninterpretable++;
      return null;
    }
  }
  const count = f.size / t.size;
  if (count === 1) return readElement(b, p, t, le);
  const values: Array<number | null> = [];
  for (let i = 0; i < count; i++) values.push(readElement(b, p + i * t.size, t, le));
  return values.every((v) => v == null) ? null : values;
}

// ---------------------------------------------------------------- framing

interface Frame {
  start: number;
  headerSize: number;
  protocolVersion: number;
  profileVersion: number;
  dataSize: number;
  /** Offset just after the data section (where the file CRC starts). */
  dataEnd: number;
}

const hasSignature = (b: Uint8Array, p: number): boolean =>
  b[p + 8] === 0x2e && b[p + 9] === 0x46 && b[p + 10] === 0x49 && b[p + 11] === 0x54; // ".FIT"

/** True when the bytes start with a FIT file header (cheap check for sniffing). */
export function looksLikeFit(b: Uint8Array): boolean {
  return b.length >= 12 && (b[0] === 12 || b[0] === 14) && hasSignature(b, 0);
}

function frameFiles(b: Uint8Array, limits: FitDecodeLimits): Frame[] {
  const frames: Frame[] = [];
  let p = 0;
  while (p < b.length) {
    const first = frames.length === 0;
    const what = first ? 'This' : 'Data after the first FIT file';
    if (b.length - p < 12)
      throw first
        ? new FitDecodeError('The file is too short to be a FIT file', 'not_fit')
        : new FitDecodeError(`${what} is incomplete or not FIT data`, 'malformed');
    const headerSize = b[p]!;
    if (!hasSignature(b, p) || (headerSize !== 12 && headerSize !== 14))
      throw first
        ? new FitDecodeError('This is not a FIT file', 'not_fit')
        : new FitDecodeError(`${what} is not FIT data`, 'malformed');
    if (frames.length >= limits.maxChainedFiles)
      throw new FitDecodeError(
        `The file chains more than ${limits.maxChainedFiles} FIT files`,
        'limit',
      );
    if (b.length - p < headerSize)
      throw new FitDecodeError('The FIT file ends inside its header', 'truncated');
    if (headerSize === 14) {
      const stored = readUint(b, p + 12, 2, true);
      if (stored !== 0 && stored !== fitCrc16(b, p, p + 12))
        throw new FitDecodeError('The FIT file header is damaged (checksum mismatch)', 'checksum');
    }
    const dataSize = readUint(b, p + 4, 4, true);
    const dataEnd = p + headerSize + dataSize;
    if (dataEnd + 2 > b.length)
      throw new FitDecodeError(
        'The FIT file is incomplete: it is shorter than its header says (it may have been cut off while copying or when the device stopped)',
        'truncated',
      );
    if (readUint(b, dataEnd, 2, true) !== fitCrc16(b, p, dataEnd))
      throw new FitDecodeError(
        'The FIT file is damaged: its checksum does not match the contents',
        'checksum',
      );
    frames.push({
      start: p,
      headerSize,
      protocolVersion: b[p + 1]!,
      profileVersion: readUint(b, p + 2, 2, true),
      dataSize,
      dataEnd,
    });
    p = dataEnd + 2;
  }
  if (frames.length === 0) throw new FitDecodeError('The file is empty', 'not_fit');
  return frames;
}

// ---------------------------------------------------------------- records

/**
 * Decodes every chained FIT file in `bytes`. Throws FitDecodeError (before calling
 * `onMessage` at all) if any file is truncated or fails its checksum, and stops with an error
 * on the first malformed record. Callers must therefore discard partial results on error.
 */
export function decodeFit(bytes: Uint8Array, options: FitDecodeOptions = {}): FitFileInfo[] {
  const limits = { ...DEFAULT_FIT_LIMITS, ...options.limits };
  if (bytes.length > limits.maxBytes)
    throw new FitDecodeError(
      `The FIT file is larger than ${Math.round(limits.maxBytes / 1024 / 1024)} MB`,
      'limit',
    );
  const frames = frameFiles(bytes, limits);
  const wants = options.wants ?? (() => true);
  let messages = 0;
  return frames.map((frame, fileIndex) => {
    const info: FitFileInfo = {
      headerSize: frame.headerSize,
      protocolVersion: frame.protocolVersion,
      profileVersion: frame.profileVersion,
      dataSize: frame.dataSize,
      messageCounts: new Map(),
      compressedTimestampMessages: 0,
      uninterpretableFields: 0,
    };
    const counted = { uninterpretable: 0 };
    const defs: Array<Definition | undefined> = new Array(16);
    let lastTimestamp: number | null = null;
    const end = frame.dataEnd;
    let p = frame.start + frame.headerSize;
    const need = (n: number, what: string): void => {
      if (p + n > end)
        throw new FitDecodeError(
          `The FIT file is malformed: ${what} runs past the end`,
          'malformed',
        );
    };

    while (p < end) {
      const header = bytes[p++]!;
      if ((header & 0x40) !== 0 && (header & 0x80) === 0) {
        // Definition message.
        const local = header & 0x0f;
        const hasDev = (header & 0x20) !== 0;
        need(5, 'a message definition');
        const arch = bytes[p + 1]!;
        if (arch > 1)
          throw new FitDecodeError(
            'The FIT file is malformed: unknown byte order in a definition',
            'malformed',
          );
        const le = arch === 0;
        const global = readUint(bytes, p + 2, 2, le);
        const fieldCount = bytes[p + 4]!;
        p += 5;
        need(fieldCount * 3, 'a message definition');
        const fields: FieldDef[] = [];
        let length = 0;
        let timestampOffset = -1;
        for (let i = 0; i < fieldCount; i++, p += 3) {
          const number = bytes[p]!;
          const size = bytes[p + 1]!;
          const baseByte = bytes[p + 2]!;
          if (size === 0)
            throw new FitDecodeError(
              'The FIT file is malformed: a field has size zero',
              'malformed',
            );
          const base = (baseByte & 0x60) === 0 ? BASE_TYPES[baseByte & 0x1f] : undefined;
          if (number === TIMESTAMP_FIELD && size === 4 && base?.kind === 'uint' && base.size === 4)
            timestampOffset = length;
          fields.push({ number, size, base });
          length += size;
        }
        const developerFields: Definition['developerFields'] = [];
        if (hasDev) {
          need(1, 'a message definition');
          const devCount = bytes[p++]!;
          need(devCount * 3, 'a message definition');
          for (let i = 0; i < devCount; i++, p += 3) {
            const size = bytes[p + 1]!;
            if (size === 0)
              throw new FitDecodeError(
                'The FIT file is malformed: a developer field has size zero',
                'malformed',
              );
            developerFields.push({
              fieldNumber: bytes[p]!,
              size,
              developerDataIndex: bytes[p + 2]!,
            });
            length += size;
          }
        }
        defs[local] = {
          global,
          littleEndian: le,
          fields,
          developerFields,
          length,
          timestampOffset,
        };
        continue;
      }

      // Data message: normal header (local type in bits 0–3) or compressed timestamp header
      // (local type in bits 5–6, seconds offset in bits 0–4).
      const compressed = (header & 0x80) !== 0;
      const local = compressed ? (header >> 5) & 0x03 : header & 0x0f;
      const def = defs[local];
      if (!def)
        throw new FitDecodeError(
          `The FIT file is malformed: data for local message ${local} has no definition`,
          'malformed',
        );
      need(def.length, 'a data message');
      if (++messages > limits.maxMessages)
        throw new FitDecodeError(
          `The FIT file has more than ${limits.maxMessages} messages`,
          'limit',
        );
      info.messageCounts.set(def.global, (info.messageCounts.get(def.global) ?? 0) + 1);

      let timestamp: number | null = null;
      if (compressed) {
        if (lastTimestamp == null)
          throw new FitDecodeError(
            'The FIT file is malformed: a compressed timestamp appears before any full timestamp',
            'malformed',
          );
        const offset = header & 0x1f;
        const low: number = lastTimestamp % 32;
        timestamp = lastTimestamp - low + offset + (offset < low ? 32 : 0);
        lastTimestamp = timestamp;
        info.compressedTimestampMessages++;
      } else if (def.timestampOffset >= 0) {
        const at = p + def.timestampOffset;
        if (!isAllOnes(bytes, at, 4)) {
          timestamp = readUint(bytes, at, 4, def.littleEndian);
          lastTimestamp = timestamp;
        }
      }

      if (wants(def.global) && options.onMessage) {
        const fields = new Map<number, FitValue>();
        let q = p;
        for (const f of def.fields) {
          const v = readField(bytes, q, f, def.littleEndian, counted);
          if (v != null) fields.set(f.number, v);
          q += f.size;
        }
        if (timestamp != null && !fields.has(TIMESTAMP_FIELD))
          fields.set(TIMESTAMP_FIELD, timestamp);
        options.onMessage({
          fileIndex,
          global: def.global,
          fields,
          developerFields: def.developerFields.map((d) => ({ ...d })),
          timestamp,
        });
      }
      p += def.length;
    }
    info.uninterpretableFields = counted.uninterpretable;
    return info;
  });
}
