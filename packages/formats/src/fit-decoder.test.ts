import { seededRandom } from '../../gps-engine/src/test-fixtures/synthetic-track';
import {
  FIT_EPOCH_MS,
  FitDecodeError,
  type FitMessage,
  decodeFit,
  fitCrc16,
  fitTimeToMs,
  looksLikeFit,
} from './fit-decoder';
import { BT, FitWriter, concatBytes, crc16Bitwise, fitFile } from './test-fixtures/fit-encoder';

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

function decodeAll(bytes: Uint8Array, limits = {}): { messages: FitMessage[]; files: number } {
  const messages: FitMessage[] = [];
  const files = decodeFit(bytes, { onMessage: (m) => messages.push(m), limits }).length;
  return { messages, files };
}

function expectFitError(bytes: Uint8Array, code?: string, limits = {}): FitDecodeError {
  let emitted = 0;
  try {
    decodeFit(bytes, { onMessage: () => emitted++, limits });
  } catch (e) {
    expect(e).toBeInstanceOf(FitDecodeError);
    if (code) expect((e as FitDecodeError).code).toBe(code);
    return e as FitDecodeError;
  }
  throw new Error(`expected a FitDecodeError, decoded ${emitted} messages`);
}

/**
 * Hand-assembled from the published FIT file structure, byte by byte, without the test encoder.
 * Values were chosen so the expected results are exact: 0x20000000 semicircles = 45°,
 * 0x10000000 = 22.5°, FIT time 1 000 000 000 s = 2021-09-08T01:46:40Z, altitude raw 3000 =
 * 3000 / 5 − 500 = 100 m.
 */
const HAND_RECORDS = [
  // Definition, local 0: file_id (global 0), little-endian, 3 fields.
  0x40,
  0x00,
  0x00,
  0x00,
  0x00,
  0x03,
  0x00,
  0x01,
  0x00, // type: enum
  0x01,
  0x02,
  0x84, // manufacturer: uint16
  0x04,
  0x04,
  0x86, // time_created: uint32
  // Data, local 0: type 4 (activity), manufacturer 0xFFFF (invalid), time 1e9.
  0x00,
  0x04,
  0xff,
  0xff,
  0x00,
  0xca,
  0x9a,
  0x3b,
  // Definition, local 1: record (global 20), 5 fields.
  0x41,
  0x00,
  0x00,
  0x14,
  0x00,
  0x05,
  0xfd,
  0x04,
  0x86, // timestamp: uint32
  0x00,
  0x04,
  0x85, // position_lat: sint32
  0x01,
  0x04,
  0x85, // position_long: sint32
  0x02,
  0x02,
  0x84, // altitude: uint16
  0x03,
  0x01,
  0x02, // heart_rate: uint8
  // Data, local 1: t = 1e9, 45°, 22.5°, 100 m, 150 bpm.
  0x01,
  0x00,
  0xca,
  0x9a,
  0x3b,
  0x00,
  0x00,
  0x00,
  0x20,
  0x00,
  0x00,
  0x00,
  0x10,
  0xb8,
  0x0b,
  0x96,
  // Definition, local 2: record without timestamp (for compressed headers).
  0x42,
  0x00,
  0x00,
  0x14,
  0x00,
  0x04,
  0x00,
  0x04,
  0x85,
  0x01,
  0x04,
  0x85,
  0x02,
  0x02,
  0x84,
  0x03,
  0x01,
  0x02,
  // Compressed timestamp header: local 2, offset 5 → t = 1e9 + 5. Longitude 0x10000100.
  0xc5,
  0x00,
  0x00,
  0x00,
  0x20,
  0x00,
  0x01,
  0x00,
  0x10,
  0xb8,
  0x0b,
  0x9b,
];

function handFile(): Uint8Array {
  const data = Uint8Array.from(HAND_RECORDS);
  const header = [14, 0x20, 0x34, 0x08, data.length, 0, 0, 0, 0x2e, 0x46, 0x49, 0x54];
  const hcrc = crc16Bitwise(header);
  const body = [...header, hcrc & 0xff, hcrc >> 8, ...data];
  const crc = crc16Bitwise(body);
  return Uint8Array.from([...body, crc & 0xff, crc >> 8]);
}

/** A small valid file with several message kinds, for corruption tests. */
function smallFile(): Uint8Array {
  const w = new FitWriter();
  w.define(0, 0, [
    [0, BT.enum],
    [4, BT.uint32],
  ]).data(0, [4, 1_000_000_000]);
  w.define(1, 20, [
    [253, BT.uint32],
    [0, BT.sint32],
    [1, BT.sint32],
    [3, BT.uint8],
  ]);
  for (let i = 0; i < 6; i++) w.data(1, [1_000_000_000 + i, 536870912 + i, 268435456, 140 + i]);
  return fitFile(w.bytes());
}

describe('FIT decoder: checksums and framing', () => {
  it('uses CRC-16/ARC (published check value 0xBB3D) and agrees with an independent version', () => {
    expect(fitCrc16(ascii('123456789'))).toBe(0xbb3d);
    expect(crc16Bitwise(ascii('123456789'))).toBe(0xbb3d);
    const r = seededRandom(3);
    const bytes = Uint8Array.from({ length: 4096 }, () => Math.floor(r() * 256));
    expect(fitCrc16(bytes)).toBe(crc16Bitwise(bytes));
  });

  it('decodes a hand-assembled file exactly', () => {
    const bytes = handFile();
    expect(looksLikeFit(bytes)).toBe(true);
    const infos = decodeFit(bytes);
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({ headerSize: 14, profileVersion: 2100, protocolVersion: 0x20 });
    const { messages } = decodeAll(bytes);
    expect(messages.map((m) => m.global)).toEqual([0, 20, 20]);
    const [fileId, r1, r2] = messages;
    expect(fileId!.fields.get(0)).toBe(4);
    expect(fileId!.fields.has(1)).toBe(false); // 0xFFFF is "not set", never a value
    expect(fitTimeToMs(fileId!.fields.get(4) as number)).toBe(Date.parse('2021-09-08T01:46:40Z'));
    expect(r1!.timestamp).toBe(1_000_000_000);
    expect([r1!.fields.get(0), r1!.fields.get(1), r1!.fields.get(2), r1!.fields.get(3)]).toEqual([
      0x20000000, 0x10000000, 3000, 150,
    ]);
    expect(r2!.timestamp).toBe(1_000_000_005);
    expect(r2!.fields.get(253)).toBe(1_000_000_005);
    expect(r2!.fields.get(1)).toBe(0x10000100);
    expect(r2!.fields.get(3)).toBe(155);
    expect(infos[0]!.compressedTimestampMessages).toBe(1);
    expect(FIT_EPOCH_MS).toBe(Date.parse('1989-12-31T00:00:00Z'));
  });

  it('accepts 12-byte headers and a 14-byte header with checksum 0', () => {
    const data = new FitWriter()
      .define(0, 0, [[0, BT.enum]])
      .data(0, [4])
      .bytes();
    expect(decodeAll(fitFile(data, { headerSize: 12 })).messages).toHaveLength(1);
    expect(decodeAll(fitFile(data, { headerCrc: false })).messages).toHaveLength(1);
  });

  it('decodes every chained file separately, with its own definitions and timestamps', () => {
    const one = smallFile();
    const { messages, files } = decodeAll(concatBytes(one, one, one));
    expect(files).toBe(3);
    expect(messages.filter((m) => m.global === 20).map((m) => m.fileIndex)).toEqual([
      ...Array<number>(6).fill(0),
      ...Array<number>(6).fill(1),
      ...Array<number>(6).fill(2),
    ]);
    // A compressed timestamp may not borrow the previous file's last timestamp.
    const w = new FitWriter();
    w.define(0, 20, [[3, BT.uint8]]);
    w.lastTimestamp = 1_000_000_000;
    w.compressed(0, 1_000_000_001, [150]);
    expectFitError(concatBytes(one, fitFile(w.bytes())), 'malformed');
  });

  it('rejects data that is not FIT', () => {
    expectFitError(new Uint8Array(0), 'not_fit');
    expectFitError(ascii('<?xml version="1.0"?><gpx>'), 'not_fit');
    const wrongSize = smallFile();
    wrongSize[0] = 13;
    expectFitError(wrongSize, 'not_fit');
  });
});

describe('FIT decoder: values', () => {
  it('reads every base type, both byte orders, arrays, strings and invalid markers', () => {
    for (const bigEndian of [false, true]) {
      const w = new FitWriter({ bigEndian });
      const fields: Array<[number, number, number?]> = [
        [0, BT.enum],
        [1, BT.sint8],
        [2, BT.uint8],
        [3, BT.sint16],
        [4, BT.uint16],
        [5, BT.sint32],
        [6, BT.uint32],
        [7, BT.string, 12],
        [8, BT.float32],
        [10, BT.uint8z],
        [11, BT.uint16z],
        [12, BT.uint32z],
        [13, BT.byte],
        [14, BT.uint16, 6], // array of three
      ];
      w.define(0, 999, fields);
      w.data(0, [
        3,
        -5,
        200,
        -30000,
        65000,
        -2_000_000_000,
        4_000_000_000,
        'Zürich ✓',
        1.5,
        7,
        9,
        11,
        0x42,
        [1, null, 3],
      ]);
      w.data(0, Array<null>(fields.length).fill(null));
      const { messages } = decodeAll(fitFile(w.bytes()));
      const m = messages[0]!.fields;
      expect([...m.entries()]).toEqual([
        [0, 3],
        [1, -5],
        [2, 200],
        [3, -30000],
        [4, 65000],
        [5, -2_000_000_000],
        [6, 4_000_000_000],
        [7, 'Zürich ✓'],
        [8, 1.5],
        [10, 7],
        [11, 9],
        [12, 11],
        [13, 0x42],
        [14, [1, null, 3]],
      ]);
      // Every "not set" marker is dropped rather than turned into a number.
      expect(messages[1]!.fields.size).toBe(0);
    }
  });

  it('skips fields it cannot interpret instead of guessing', () => {
    const w = new FitWriter();
    w.define(0, 20, [
      [3, BT.uint16, 3], // size is not a multiple of the type size
      [4, 0x1f, 2], // unknown base type
      [7, BT.uint16],
    ]);
    w.raw([0, 1, 2, 3, 4, 5, 200, 0]);
    const messages: FitMessage[] = [];
    const [info] = decodeFit(fitFile(w.bytes()), { onMessage: (m) => messages.push(m) });
    expect([...messages[0]!.fields.entries()]).toEqual([[7, 200]]);
    expect(info!.uninterpretableFields).toBe(2);
  });

  it('reconstructs compressed timestamps, including the 32-second rollover', () => {
    const w = new FitWriter();
    w.define(0, 20, [[3, BT.uint8]]);
    w.define(1, 20, [
      [253, BT.uint32],
      [3, BT.uint8],
    ]);
    const base = 1_000_000_030; // low five bits = 30
    w.data(1, [base, 100]);
    w.compressed(0, base + 1, [101]); // 31
    w.compressed(0, base + 2, [102]); // wraps to 0 → +32
    w.compressed(0, base + 20, [103]);
    const { messages } = decodeAll(fitFile(w.bytes()));
    expect(messages.map((m) => m.timestamp)).toEqual([base, base + 1, base + 2, base + 20]);
  });

  it('lists developer fields and skips their bytes correctly', () => {
    const w = new FitWriter();
    w.define(
      0,
      20,
      [[3, BT.uint8]],
      [
        [0, 2, 0],
        [5, 4, 1],
      ],
    );
    w.data(0, [150], [1, 2, 3, 4, 5, 6]);
    w.data(0, [151], [1, 2, 3, 4, 5, 6]);
    const { messages } = decodeAll(fitFile(w.bytes()));
    expect(messages.map((m) => m.fields.get(3))).toEqual([150, 151]);
    expect(messages[0]!.developerFields).toEqual([
      { fieldNumber: 0, size: 2, developerDataIndex: 0 },
      { fieldNumber: 5, size: 4, developerDataIndex: 1 },
    ]);
  });

  it('counts messages it is not asked to decode but still follows their timestamps', () => {
    const w = new FitWriter();
    w.define(0, 21, [[253, BT.uint32]]).data(0, [1_000_000_000]);
    w.define(1, 20, [[3, BT.uint8]]);
    w.compressed(1, 1_000_000_004, [150]);
    const messages: FitMessage[] = [];
    const [info] = decodeFit(fitFile(w.bytes()), {
      onMessage: (m) => messages.push(m),
      wants: (g) => g === 20,
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.timestamp).toBe(1_000_000_004);
    expect([...info!.messageCounts.entries()]).toEqual([
      [21, 1],
      [20, 1],
    ]);
  });
});

describe('FIT decoder: damaged and hostile files', () => {
  it('rejects a file truncated at any byte, before emitting anything', () => {
    const bytes = smallFile();
    for (let n = 0; n < bytes.length; n++) expectFitError(bytes.subarray(0, n));
    expect(expectFitError(bytes.subarray(0, bytes.length - 1)).code).toBe('truncated');
  });

  it('rejects any single corrupted byte, before emitting anything', () => {
    const bytes = smallFile();
    for (let i = 0; i < bytes.length; i++) {
      const copy = bytes.slice();
      copy[i] = copy[i]! ^ 0x01;
      expectFitError(copy);
    }
    const header = smallFile();
    header[4] = header[4]! ^ 0x01; // declared size → header checksum fails first
    expect(expectFitError(header).code).toBe('checksum');
  });

  it('rejects structurally broken files even when their checksum is right', () => {
    const wrap = (records: number[]) => fitFile(Uint8Array.from(records));
    // Data for a local message that was never defined.
    expect(expectFitError(wrap([0x03, 0x01])).message).toMatch(/no definition/);
    // A data message running past the end of the data section.
    expect(expectFitError(wrap([0x40, 0, 0, 0x14, 0, 1, 3, 4, 0x86, 0x00, 1, 2])).message).toMatch(
      /past the end/,
    );
    // A definition cut short.
    expectFitError(wrap([0x40, 0, 0, 0x14, 0, 5, 3, 4]), 'malformed');
    // Unknown byte order.
    expectFitError(wrap([0x40, 0, 7, 0x14, 0, 1, 3, 1, 2, 0x00, 9]), 'malformed');
    // A field of size zero.
    expectFitError(wrap([0x40, 0, 0, 0x14, 0, 1, 3, 0, 2]), 'malformed');
    // A compressed timestamp before any full timestamp.
    expectFitError(wrap([0x40, 0, 0, 0x14, 0, 1, 3, 1, 2, 0x81, 150]), 'malformed');
    // Bytes after the last file that are not another FIT file.
    expectFitError(concatBytes(smallFile(), ascii('garbage-after-file')), 'malformed');
    expectFitError(concatBytes(smallFile(), new Uint8Array(4)), 'malformed');
  });

  it('enforces size, message and chained-file limits', () => {
    const one = smallFile();
    expectFitError(one, 'limit', { maxBytes: one.length - 1 });
    expectFitError(one, 'limit', { maxMessages: 6 });
    expect(decodeAll(one, { maxMessages: 7 }).messages).toHaveLength(7);
    const chain = concatBytes(...Array<Uint8Array>(5).fill(one));
    expectFitError(chain, 'limit', { maxChainedFiles: 4 });
    expect(decodeAll(chain, { maxChainedFiles: 5 }).files).toBe(5);
  });

  it('never fails with anything but a FitDecodeError on random content (fuzz)', () => {
    const r = seededRandom(42);
    let decoded = 0;
    for (let i = 0; i < 3000; i++) {
      const len = Math.floor(r() * 200);
      const data = Uint8Array.from({ length: len }, () => {
        // Bias towards header-like bytes so definitions and data messages actually occur.
        const x = r();
        return x < 0.15
          ? 0x40 | Math.floor(r() * 16)
          : x < 0.3
            ? Math.floor(r() * 16)
            : Math.floor(r() * 256);
      });
      try {
        decodeFit(fitFile(data), { onMessage: () => undefined });
        decoded++;
      } catch (e) {
        if (!(e instanceof FitDecodeError)) throw e;
      }
    }
    expect(decoded).toBeGreaterThan(0);
  });
});
