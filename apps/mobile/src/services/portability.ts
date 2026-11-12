import type { ImportSourceFile, PortableExportSummary } from '@pace/core';
import * as DocumentPicker from 'expo-document-picker';
import { File, FileMode, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { getServices } from './container';

/**
 * Device side of import/export: picked files are read in 1 MB chunks through a FileHandle and
 * the export archive is streamed into a cache file, so neither is ever held in memory whole.
 */
const CHUNK_BYTES = 1024 * 1024;

export interface PickedFile extends ImportSourceFile {
  /** Cache copy made by the document picker; removed after the import. */
  uri: string;
}

export function fileByteSource(uri: string): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      const handle = new File(uri).open(FileMode.ReadOnly);
      try {
        for (;;) {
          const chunk = await handle.readBytes(CHUNK_BYTES);
          if (chunk.length === 0) return;
          yield chunk;
        }
      } finally {
        handle.close();
      }
    },
  };
}

/** Lets the athlete pick any number of GPX, TCX, .gz or ZIP files. Null when cancelled. */
export async function pickImportFiles(): Promise<PickedFile[] | null> {
  const r = await DocumentPicker.getDocumentAsync({
    multiple: true,
    copyToCacheDirectory: true,
    // GPX/TCX have no registered type on every device, so any file can be chosen; the importer
    // recognises the content and explains anything it cannot read.
    type: '*/*',
  });
  if (r.canceled) return null;
  return r.assets.map((a) => ({
    name: a.name,
    uri: a.uri,
    ...(a.size != null ? { size: a.size } : {}),
    open: () => fileByteSource(a.uri),
  }));
}

/** Deletes the picker's cache copies (best effort: the OS also clears the cache). */
export function removePickedCopies(files: readonly PickedFile[]): void {
  for (const f of files) {
    try {
      const file = new File(f.uri);
      if (file.exists) file.delete();
    } catch {
      // Not ours to delete (e.g. opened in place) or already gone.
    }
  }
}

const PARTIAL = 'pace-export.partial.zip';

/** Writes the full export into the cache and returns its location and summary. */
export async function createPortableExport(
  privacyZoneMeters: number,
  onProgress: (done: number, total: number) => void,
): Promise<{ uri: string; summary: PortableExportSummary }> {
  const { portableExport, appVersion } = await getServices();
  for (const f of Paths.cache.list())
    if (f instanceof File && /^pace-export.*\.zip$/.test(f.name)) f.delete();
  const partial = new File(Paths.cache, PARTIAL);
  partial.create();
  const handle = partial.open(FileMode.Truncate);
  let summary: PortableExportSummary;
  try {
    summary = await portableExport.export(
      { write: (chunk) => handle.writeBytes(chunk) },
      { privacyZoneMeters, appVersion, onProgress },
    );
  } catch (e) {
    handle.close();
    partial.delete();
    throw e;
  }
  handle.close();
  const final = new File(Paths.cache, summary.fileName);
  if (final.exists) final.delete();
  await partial.move(final);
  return { uri: final.uri, summary };
}

export async function shareExport(uri: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync()))
    throw new Error('Sharing is not available on this device');
  await Sharing.shareAsync(uri, {
    mimeType: 'application/zip',
    UTI: 'public.zip-archive',
    dialogTitle: 'Save or send your PACE export',
  });
}
