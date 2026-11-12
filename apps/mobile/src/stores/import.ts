import type { BulkImportProgress, BulkImportReport } from '@pace/core';
import type { SportType } from '@pace/domain';
import { create } from 'zustand';
import { deviceTimeZone, getServices } from '@/services/container';
import { type PickedFile, removePickedCopies } from '@/services/portability';

/**
 * One import at a time, held outside the screen so it keeps running (and stays visible) if the
 * athlete navigates away. Imported activities are committed one by one, so leaving the app or
 * cancelling never loses what was already imported; importing the same files again skips them.
 */
interface ImportState {
  status: 'idle' | 'running' | 'done' | 'error';
  progress: BulkImportProgress | null;
  report: BulkImportReport | null;
  error: string | null;
  cancelRequested: boolean;
  start(
    files: PickedFile[],
    options: { fallbackSportType?: SportType; userId: string | null },
    onImported: () => Promise<void>,
  ): Promise<void>;
  cancel(): void;
  reset(): void;
}

export const useImport = create<ImportState>((set, get) => ({
  status: 'idle',
  progress: null,
  report: null,
  error: null,
  cancelRequested: false,
  async start(files, options, onImported) {
    if (get().status === 'running') return;
    set({ status: 'running', progress: null, report: null, error: null, cancelRequested: false });
    try {
      const { bulkImport } = await getServices();
      let lastImported = 0;
      const report = await bulkImport.importFiles(files, {
        timezone: deviceTimeZone(),
        userId: options.userId,
        ...(options.fallbackSportType ? { fallbackSportType: options.fallbackSportType } : {}),
        isCancelled: () => get().cancelRequested,
        onProgress: async (p) => {
          set({ progress: p });
          // Refresh lists now and then so new activities appear during long imports.
          if (p.imported - lastImported >= 25) {
            lastImported = p.imported;
            await onImported();
          }
        },
      });
      set({ status: 'done', report });
      if (report.imported > 0) await onImported();
    } catch (e) {
      set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    } finally {
      removePickedCopies(files);
    }
  },
  cancel() {
    if (get().status === 'running') set({ cancelRequested: true });
  },
  reset() {
    if (get().status !== 'running')
      set({ status: 'idle', progress: null, report: null, error: null, cancelRequested: false });
  },
}));
