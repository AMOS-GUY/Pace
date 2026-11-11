import { toEntries } from './entries';

const sample = (over: Record<string, unknown> = {}) => ({
  latitude: 1.29,
  longitude: 103.85,
  altitudeMeters: null,
  horizontalAccuracyMeters: 5,
  verticalAccuracyMeters: null,
  speedMps: null,
  courseDegrees: null,
  recordedAt: Date.UTC(2026, 0, 1),
  source: 'device_gps',
  ...over,
});

describe('native entry validation', () => {
  it('passes physically implausible but well-typed samples through unchanged', () => {
    const errors: string[] = [];
    const out = toEntries(
      [
        { sequence: 0, sample: sample({ altitudeMeters: 15_000 }) },
        { sequence: 1, sample: sample({ horizontalAccuracyMeters: -1 }) },
      ],
      (m) => errors.push(m),
    );
    expect(out.map((e) => e.sequence)).toEqual([0, 1]);
    expect(errors).toEqual([]);
  });

  it('stops at a malformed entry instead of silently skipping it', () => {
    const errors: string[] = [];
    const out = toEntries(
      [
        { sequence: 0, sample: sample() },
        { sequence: 1, sample: { latitude: 'x' } },
        { sequence: 2, sample: sample() },
      ],
      (m) => errors.push(m),
    );
    // Entry 2 is not delivered past the hole; it stays in the native journal.
    expect(out.map((e) => e.sequence)).toEqual([0]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('#1');
  });
});
