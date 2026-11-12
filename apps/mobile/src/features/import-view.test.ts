import type { BulkImportProgress, ImportOutcome } from '@pace/core';
import { groupOutcomes, importProgressRatio, outcomeName, skippedSummary } from './import-view';

const outcome = (status: ImportOutcome['status'], entry: string): ImportOutcome => ({
  file: 'export.zip',
  entry,
  status,
  message: status === 'imported' ? null : 'reason',
  warnings: [],
  activityId: status === 'imported' ? 'a' : null,
  existingActivityId: null,
});

describe('import view model', () => {
  it('groups outcomes with problems first and drops empty groups', () => {
    const g = groupOutcomes([
      outcome('imported', 'a.gpx'),
      outcome('failed', 'b.gpx'),
      outcome('imported', 'c.gpx'),
      outcome('duplicate', 'd.gpx'),
    ]);
    expect(g.map((x) => [x.title, x.items.length])).toEqual([
      ['Could not import', 1],
      ['Already in PACE', 1],
      ['Imported', 2],
    ]);
    expect(groupOutcomes([])).toEqual([]);
  });

  it('shows file names without archive folders, keeping the activity number', () => {
    expect(outcomeName('export/activities/123.tcx.gz#2')).toBe('123.tcx.gz#2');
    expect(outcomeName('run.gpx')).toBe('run.gpx');
    expect(outcomeName('a\\b\\c.gpx')).toBe('c.gpx');
  });

  it('computes overall progress across picked files', () => {
    const p = (fileIndex: number, read: number, total: number | null): BulkImportProgress => ({
      file: 'f',
      fileIndex,
      fileCount: 2,
      bytesRead: read,
      bytesTotal: total,
      imported: 0,
      duplicates: 0,
      needsSport: 0,
      failed: 0,
      skipped: 0,
      current: null,
    });
    expect(importProgressRatio(null)).toBe(0);
    expect(importProgressRatio(p(1, 50, 100))).toBe(0.25);
    expect(importProgressRatio(p(2, 100, 100))).toBe(1);
    // Unknown size: whole files only, never an invented percentage.
    expect(importProgressRatio(p(2, 999, null))).toBe(0.5);
  });

  it('summarises skipped files by extension', () => {
    expect(
      skippedSummary({ count: 1204, byExtension: { '.csv': 14, '.jpg': 1190 } }, 'en-US'),
    ).toBe('Skipped 1,204 files that are not activities: .jpg 1,190, .csv 14.');
    expect(skippedSummary({ count: 1, byExtension: { '.txt': 1 } }, 'en-US')).toBe(
      'Skipped 1 file that is not an activity: .txt 1.',
    );
  });
});
