import {
  addDaysToDateKey,
  addMonthsToMonthKey,
  formatDistanceValue,
  formatDuration,
  formatPace,
  formatPacePer100m,
  formatSpeed,
  isSportType,
  isUuid,
  localDateKey,
  localMonthKey,
  localWeekKey,
  uuidV4,
} from './index';

describe('formatting', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(59_999)).toBe('0:59');
    expect(formatDuration(61_000)).toBe('1:01');
    expect(formatDuration(3_723_000)).toBe('1:02:03');
    expect(formatDuration(-1)).toBe('—');
    expect(formatDuration(null)).toBe('—');
  });

  it('formats pace per km and per mile without 60-second rollover bugs', () => {
    expect(formatPace(300_000, 'metric')).toBe('5:00');
    expect(formatPace(299_700, 'metric')).toBe('5:00');
    expect(formatPace(300_000, 'imperial')).toBe('8:03');
    expect(formatPace(null, 'metric')).toBe('—');
    expect(formatPace(0, 'metric')).toBe('—');
  });

  it('formats swim pace per 100 m', () => {
    expect(formatPacePer100m(1_200_000)).toBe('2:00');
  });

  it('formats distance and speed in both systems', () => {
    expect(formatDistanceValue(10_000, 'metric')).toBe('10.00');
    expect(formatDistanceValue(1609.344, 'imperial')).toBe('1.00');
    expect(formatSpeed(10, 'metric')).toBe('36.0');
    expect(formatSpeed(10, 'imperial')).toBe('22.4');
  });
});

describe('ids', () => {
  it('generates RFC 4122 v4 UUIDs', () => {
    const id = uuidV4();
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('4');
    expect(uuidV4()).not.toBe(id);
  });

  it('is deterministic with an injected random source', () => {
    expect(uuidV4(() => new Uint8Array(16))).toBe('00000000-0000-4000-8000-000000000000');
  });
});

describe('time zone bucketing', () => {
  // 2026-03-01T23:30Z is Sunday in UTC but Monday 2026-03-02 in Asia/Singapore (UTC+8).
  const t = Date.UTC(2026, 2, 1, 23, 30);

  it('uses the local calendar day', () => {
    expect(localDateKey(t, 'UTC')).toBe('2026-03-01');
    expect(localDateKey(t, 'Asia/Singapore')).toBe('2026-03-02');
  });

  it('keys ISO weeks by their Monday', () => {
    expect(localWeekKey(t, 'UTC')).toBe('2026-02-23');
    expect(localWeekKey(t, 'Asia/Singapore')).toBe('2026-03-02');
  });

  it('keys months', () => {
    expect(localMonthKey(t, 'UTC')).toBe('2026-03');
    expect(localMonthKey(Date.UTC(2026, 0, 31, 20), 'Asia/Singapore')).toBe('2026-02');
  });

  it('does calendar arithmetic across boundaries', () => {
    expect(addDaysToDateKey('2026-02-27', 3)).toBe('2026-03-02');
    expect(addMonthsToMonthKey('2026-11', 3)).toBe('2027-02');
    expect(addMonthsToMonthKey('2026-01', -1)).toBe('2025-12');
  });
});

describe('sport guard', () => {
  it('recognises supported sports only', () => {
    expect(isSportType('running')).toBe(true);
    expect(isSportType('rowing')).toBe(false);
  });
});
