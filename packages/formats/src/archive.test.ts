import { gzipSync, strToU8, zipSync } from 'fflate';
import { straightTrack } from '../../gps-engine/src/test-fixtures/synthetic-track';
import {
  type ArchiveLimits,
  ArchiveError,
  DEFAULT_ARCHIVE_LIMITS,
  type SourceItem,
  bytesSource,
  classifyName,
  crc32,
  readImportSource,
  unsafeEntryName,
} from './index';
import { garminTcx, stravaGpx, withSensors } from './test-fixtures/device-files';
import { SPORT, fitActivity, fitPoints } from './test-fixtures/fit-encoder';

const T = Date.UTC(2026, 9, 4, 6, 30);
const gpx = stravaGpx({
  name: 'Run',
  type: 'running',
  points: withSensors(straightTrack({ speedMps: 3, durationSeconds: 60, startTime: T })),
});
const fit = fitActivity({
  sessions: [
    {
      sport: SPORT.cycling,
      laps: [[fitPoints(straightTrack({ speedMps: 8, durationSeconds: 60, startTime: T }))]],
    },
  ],
});
const tcx = garminTcx({
  sport: 'Biking',
  laps: [
    { tracks: [withSensors(straightTrack({ speedMps: 8, durationSeconds: 60, startTime: T }))] },
  ],
});

async function collect(
  name: string,
  bytes: Uint8Array,
  limits?: ArchiveLimits,
  chunk = 1024,
): Promise<{ items: SourceItem[]; error: Error | null }> {
  const items: SourceItem[] = [];
  try {
    for await (const item of readImportSource(name, bytesSource(bytes, chunk), limits))
      items.push(item);
    return { items, error: null };
  } catch (e) {
    return { items, error: e as Error };
  }
}

const summary = (items: SourceItem[]) =>
  items.map((i) => `${i.kind}:${i.entry ?? '-'}${i.kind === 'file' ? `:${i.format}` : ''}`);

describe('archive reading', () => {
  it('classifies names and refuses unsafe entry paths', () => {
    expect(classifyName('Activities/123.GPX.gz')).toEqual({
      type: 'activity',
      format: 'gpx',
      gzip: true,
    });
    expect(classifyName('a.tcx')).toEqual({ type: 'activity', format: 'tcx', gzip: false });
    expect(classifyName('a.fit.gz')).toEqual({ type: 'activity', format: 'fit', gzip: true });
    expect(classifyName('A.FIT')).toEqual({ type: 'activity', format: 'fit', gzip: false });
    expect(classifyName('export.zip').type).toBe('zip');
    expect(classifyName('photo.jpg').type).toBe('other');
    expect(unsafeEntryName('activities/run.gpx')).toBeNull();
    expect(unsafeEntryName('../evil.gpx')).toMatch(/leaves the archive/);
    expect(unsafeEntryName('a/../../b.gpx')).toMatch(/leaves the archive/);
    expect(unsafeEntryName('a\\..\\b.gpx')).toMatch(/leaves the archive/);
    expect(unsafeEntryName('/etc/run.gpx')).toMatch(/absolute/);
    expect(unsafeEntryName('C:\\run.gpx')).toMatch(/absolute/);
    expect(unsafeEntryName('run\u0000.gpx')).toMatch(/control/);
    expect(unsafeEntryName('..hidden.gpx')).toBeNull(); // a name, not a traversal
  });

  it('reads single GPX, TCX and gzip files, sniffing content when the name is unhelpful', async () => {
    expect(summary((await collect('run.gpx', strToU8(gpx))).items)).toEqual(['file:-:gpx']);
    expect(summary((await collect('ride.TCX', strToU8(tcx))).items)).toEqual(['file:-:tcx']);
    expect(summary((await collect('ride.tcx.gz', gzipSync(strToU8(tcx)))).items)).toEqual([
      'file:-:tcx',
    ]);
    // iOS document providers sometimes hand over generic names.
    expect(summary((await collect('document', strToU8(gpx))).items)).toEqual(['file:-:gpx']);
    expect(summary((await collect('download', zipSync({ 'a.gpx': strToU8(gpx) }))).items)).toEqual([
      'file:a.gpx:gpx',
    ]);
    const r = await collect('run.gpx', strToU8(gpx));
    expect((r.items[0] as { text: string }).text).toBe(gpx);
  });

  it('streams a mixed export archive and accounts for every entry', async () => {
    const zip = zipSync({
      'activities/1.gpx': strToU8(gpx),
      'activities/2.tcx.gz': gzipSync(strToU8(tcx)),
      'activities/3.fit.gz': new Uint8Array([1, 2, 3]),
      'activities/4.gpx': strToU8('<gpx><trk>broken'),
      'activities/5.fit': fit,
      'activities/6.fit.gz': gzipSync(fit),
      'media/photo.jpg': new Uint8Array(500).fill(7),
      'activities.csv': strToU8('id,name\n1,Run'),
      'nested.zip': zipSync({ 'x.gpx': strToU8(gpx) }),
      '../escape.gpx': strToU8(gpx),
      'empty-dir/': new Uint8Array(0),
    });
    const r = await collect('export.zip', zip, undefined, 333);
    expect(r.error).toBeNull();
    expect(summary(r.items).sort()).toEqual(
      [
        'file:activities/1.gpx:gpx',
        'file:activities/2.tcx.gz:tcx',
        'rejected:activities/3.fit.gz',
        // Malformed XML is still yielded: the parser reports it per file.
        'file:activities/4.gpx:gpx',
        'file:activities/5.fit:fit',
        'file:activities/6.fit.gz:fit',
        'skipped:media/photo.jpg',
        'skipped:activities.csv',
        'rejected:nested.zip',
        'rejected:../escape.gpx',
      ].sort(),
    );
    const reasons = Object.fromEntries(
      r.items
        .filter((i) => i.kind !== 'file')
        .map((i) => [i.entry, (i as { reason: string }).reason]),
    );
    // Not valid gzip: refused while reading, before the FIT decoder sees it.
    expect(reasons['activities/3.fit.gz']).toMatch(/Could not read/);
    // FIT stays binary: the exact bytes reach the decoder.
    for (const entry of ['activities/5.fit', 'activities/6.fit.gz'])
      expect(r.items.find((i) => i.entry === entry)).toMatchObject({ format: 'fit', bytes: fit });
    expect(reasons['nested.zip']).toMatch(/not opened/);
    expect(reasons['../escape.gpx']).toMatch(/Unsafe file name/);
  });

  it('stops a ZIP bomb by the bytes it actually produces, per file and in total', async () => {
    const zeros = new Uint8Array(3 * 1024 * 1024); // compresses to a few KB
    const bomb = zipSync({ 'bomb.gpx': zeros, 'ok.gpx': strToU8(gpx) }, { level: 9 });
    expect(bomb.length).toBeLessThan(20_000);
    const limits = { ...DEFAULT_ARCHIVE_LIMITS, maxEntryBytes: 1024 * 1024 };
    const r = await collect('bomb.zip', bomb, limits);
    expect(r.error).toBeNull();
    const bombItem = r.items.find((i) => i.entry === 'bomb.gpx')!;
    expect(bombItem).toMatchObject({ kind: 'rejected' });
    expect((bombItem as { reason: string }).reason).toMatch(/possible ZIP bomb/);
    expect(summary(r.items)).toContain('file:ok.gpx:gpx');

    // Many entries that are each small but together exceed the archive-wide budget.
    const many = zipSync(
      Object.fromEntries(
        Array.from({ length: 6 }, (_, i) => [`${i}.gpx`, new Uint8Array(400_000)]),
      ),
      { level: 9 },
    );
    const total = await collect('many.zip', many, {
      ...DEFAULT_ARCHIVE_LIMITS,
      maxTotalUncompressedBytes: 1_000_000,
    });
    expect(total.error).toBeInstanceOf(ArchiveError);
    expect(total.error!.message).toMatch(/expands to more than/);
    expect(total.items.filter((i) => i.kind === 'file').length).toBeLessThanOrEqual(2);

    // A gzip bomb as a single file.
    const gz = await collect('bomb.gpx.gz', gzipSync(zeros), limits);
    expect(gz.items[0]).toMatchObject({ kind: 'rejected' });
  });

  it('enforces the entry count and archive size limits', async () => {
    const entries = zipSync(
      Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`${i}.txt`, strToU8('x')])),
    );
    const r = await collect('n.zip', entries, { ...DEFAULT_ARCHIVE_LIMITS, maxArchiveEntries: 3 });
    expect(r.error!.message).toMatch(/more than 3 files/);
    const big = await collect(
      'big.zip',
      entries,
      { ...DEFAULT_ARCHIVE_LIMITS, maxArchiveBytes: 100 },
      50,
    );
    expect(big.error).toBeInstanceOf(ArchiveError);
    expect(big.error!.message).toMatch(/larger than/);
    const file = await collect('big.gpx', strToU8(gpx), {
      ...DEFAULT_ARCHIVE_LIMITS,
      maxEntryBytes: 100,
    });
    expect(file.items[0]).toMatchObject({ kind: 'rejected' });
  });

  it('reports truncated, corrupt and empty archives instead of losing files silently', async () => {
    const zip = zipSync({ 'a.gpx': strToU8(gpx), 'b.gpx': strToU8(gpx.repeat(20)) }, { level: 0 });
    const cut = await collect('cut.zip', zip.subarray(0, Math.floor(zip.length * 0.75)));
    const items = summary(cut.items);
    expect(items).toContain('file:a.gpx:gpx');
    expect(cut.items.find((i) => i.entry === 'b.gpx')).toMatchObject({
      kind: 'rejected',
      reason: 'The archive ended before this file was complete',
    });

    const garbage = new Uint8Array(4096).map((_, i) => (i * 7919) % 251);
    garbage.set([0x50, 0x4b, 0x03, 0x04]);
    const bad = await collect('bad.zip', garbage);
    expect(bad.error === null ? bad.items.every((i) => i.kind !== 'file') : bad.error).toBeTruthy();

    expect((await collect('empty.gpx', new Uint8Array(0))).items).toEqual([
      { kind: 'rejected', entry: null, reason: 'The file is empty' },
    ]);
    expect((await collect('notes.txt', strToU8('hello'))).items[0]).toMatchObject({
      kind: 'rejected',
    });
    // A .fit name is handed to the FIT decoder, which checks the content (see fit.test.ts).
    expect((await collect('ride.fit', new Uint8Array(20))).items[0]).toMatchObject({
      kind: 'file',
      format: 'fit',
    });
    // A FIT file without a recognisable name is detected by its header.
    expect((await collect('download', fit)).items[0]).toMatchObject({
      kind: 'file',
      format: 'fit',
    });
  });

  it('refuses a damaged or cut-off .gz instead of passing on partial content', async () => {
    const gz = gzipSync(strToU8(gpx));
    for (const bytes of [
      gz.subarray(0, gz.length - 12),
      gz.subarray(0, 30),
      new Uint8Array([1, 2, 3]),
    ])
      expect((await collect('run.gpx.gz', bytes)).items).toEqual([
        {
          kind: 'rejected',
          entry: null,
          reason: expect.stringMatching(/^Could not read the file: /),
        },
      ]);
    // Truncated inside the trailer: all content decompresses, only the checksum shows the damage.
    expect((await collect('run.gpx.gz', gz.subarray(0, gz.length - 3))).items[0]).toMatchObject({
      kind: 'rejected',
      reason: expect.stringMatching(/incomplete or damaged/),
    });
    const corrupt = gz.slice();
    corrupt[corrupt.length - 6] = corrupt[corrupt.length - 6]! ^ 1;
    expect((await collect('run.gpx.gz', corrupt)).items[0]).toMatchObject({ kind: 'rejected' });
    expect(crc32(strToU8('123456789'))).toBe(0xcbf43926); // published CRC-32 check value
    const zip = zipSync({ 'a.fit.gz': gzipSync(fit).subarray(0, 40) });
    expect((await collect('x.zip', zip)).items).toEqual([
      {
        kind: 'rejected',
        entry: 'a.fit.gz',
        reason: expect.stringMatching(/^Could not read: /),
      },
    ]);
  });

  it('refuses UTF-16 files with an explanation and strips a UTF-8 BOM', async () => {
    const utf16 = new Uint8Array([0xff, 0xfe, ...strToU8('<gpx>')]);
    expect((await collect('a.gpx', utf16)).items[0]).toMatchObject({
      kind: 'rejected',
      reason: expect.stringMatching(/UTF-16/),
    });
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...strToU8(gpx)]);
    expect(
      ((await collect('a.gpx', bom)).items[0] as { text: string }).text.startsWith('<?xml'),
    ).toBe(true);
  });
});
