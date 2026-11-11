import {
  activityEditSchema,
  credentialsSchema,
  goalInputSchema,
  locationSampleSchema,
} from './index';

describe('validation', () => {
  const sample = {
    latitude: 1.29,
    longitude: 103.85,
    altitudeMeters: 12,
    horizontalAccuracyMeters: 5,
    verticalAccuracyMeters: 3,
    speedMps: 2.5,
    courseDegrees: 90,
    recordedAt: Date.UTC(2026, 0, 1),
    source: 'device_gps',
  };

  it('accepts valid location samples', () => {
    expect(locationSampleSchema.safeParse(sample).success).toBe(true);
  });

  it('rejects out-of-range coordinates and timestamps', () => {
    expect(locationSampleSchema.safeParse({ ...sample, latitude: 120 }).success).toBe(false);
    expect(locationSampleSchema.safeParse({ ...sample, recordedAt: 12 }).success).toBe(false);
    expect(locationSampleSchema.safeParse({ ...sample, longitude: Number.NaN }).success).toBe(
      false,
    );
  });

  it('requires at least one field to edit', () => {
    expect(activityEditSchema.safeParse({}).success).toBe(false);
    expect(activityEditSchema.safeParse({ title: '  Long run  ' }).data).toEqual({
      title: 'Long run',
    });
  });

  it('validates credentials and goals', () => {
    expect(credentialsSchema.safeParse({ email: 'a@b.co', password: 'short' }).success).toBe(false);
    expect(
      credentialsSchema.safeParse({ email: 'a@b.co', password: 'long-enough-pw' }).success,
    ).toBe(true);
    expect(
      goalInputSchema.safeParse({
        sportType: null,
        goalType: 'distance',
        targetValue: 0,
        period: 'week',
      }).success,
    ).toBe(false);
  });
});
