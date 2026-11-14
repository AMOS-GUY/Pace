import type { RestoreReport } from '@pace/core';
import { restoreSummary } from './restore-summary';

const base: RestoreReport = {
  formatVersion: 2,
  restored: 3,
  skippedExisting: 0,
  failed: [],
  goalsRestored: 1,
  sensorSamplesRestored: 1200,
  settingsRestored: [],
  settingsIgnored: 0,
  otherFailures: [],
};

describe('restore summary', () => {
  it('reports a complete format-2 restore with its sensor data', () => {
    expect(restoreSummary(base)).toEqual({
      tone: 'success',
      text: 'Restored 3 activities with 1200 heart-rate, cadence and power samples.',
    });
  });

  it('says plainly that an older backup has no sensor data, as a warning', () => {
    const r = restoreSummary({ ...base, formatVersion: 1, sensorSamplesRestored: 0 });
    expect(r.tone).toBe('warning');
    expect(r.text).toMatch(/older version of PACE: it contains no heart rate, cadence or power/);
    expect(r.text).not.toMatch(/samples\./);
  });

  it('explains kept duplicates and replaced settings', () => {
    const r = restoreSummary({
      ...base,
      restored: 0,
      skippedExisting: 2,
      sensorSamplesRestored: 0,
      settingsRestored: ['preferences', 'profile'],
    });
    expect(r.text).toBe(
      "Restored 0 activities. 2 activities were already on this phone and kept as they are (not duplicated). Your preferences and profile were replaced with the backup's.",
    );
  });

  it('never reports success when an activity, goals or settings failed', () => {
    const r = restoreSummary({
      ...base,
      failed: [{ activityId: 'a', reason: 'Raw samples are not contiguous' }],
      otherFailures: [{ part: 'settings', reason: 'database is locked' }],
    });
    expect(r.tone).toBe('error');
    expect(r.text).toMatch(/1 activity could not be restored: Raw samples are not contiguous/);
    expect(r.text).toMatch(
      /Your settings could not be restored \(database is locked\)\. Restore the same backup again/,
    );
  });
});
