import type { LocationSample } from '@pace/domain';

export type SampleValidationFailure =
  'invalid_coordinates' | 'invalid_timestamp' | 'invalid_accuracy';

/** Earliest plausible timestamp (2000-01-01) — guards against epoch-zero / unit mistakes. */
const MIN_PLAUSIBLE_EPOCH_MS = 946_684_800_000;

/**
 * Structural validation of a single raw sample, independent of any other sample.
 * Returns null when the sample is structurally valid.
 */
export function validateSample(sample: LocationSample): SampleValidationFailure | null {
  const { latitude, longitude, recordedAt, horizontalAccuracyMeters } = sample;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return 'invalid_coordinates';
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return 'invalid_coordinates';
  }
  // (0,0) "Null Island" is the canonical uninitialised-fix value from many location stacks.
  if (latitude === 0 && longitude === 0) return 'invalid_coordinates';
  if (!Number.isFinite(recordedAt) || recordedAt < MIN_PLAUSIBLE_EPOCH_MS) {
    return 'invalid_timestamp';
  }
  // Core Location reports a negative accuracy for an invalid fix.
  if (!Number.isFinite(horizontalAccuracyMeters) || horizontalAccuracyMeters < 0) {
    return 'invalid_accuracy';
  }
  return null;
}

/** Altitude usable for elevation calculations, or null. */
export function usableAltitude(
  sample: LocationSample,
  maxVerticalAccuracyMeters: number,
): number | null {
  if (sample.altitudeMeters == null || !Number.isFinite(sample.altitudeMeters)) return null;
  const va = sample.verticalAccuracyMeters;
  if (va != null && (!Number.isFinite(va) || va < 0 || va > maxVerticalAccuracyMeters)) return null;
  return sample.altitudeMeters;
}
