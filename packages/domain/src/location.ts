/** Where a location sample came from. */
export type LocationSource =
  'device_gps' | 'device_fused' | 'external_device' | 'import' | 'replay';

/**
 * A single raw location sample exactly as reported by the platform location service.
 * Raw samples are never mutated or deleted by processing.
 */
export interface LocationSample {
  latitude: number;
  longitude: number;
  /** Altitude above sea level in metres, or null when unavailable. */
  altitudeMeters: number | null;
  /** Radius of horizontal 68% confidence in metres. Must be >= 0. */
  horizontalAccuracyMeters: number;
  verticalAccuracyMeters: number | null;
  /** Instantaneous speed in m/s reported by the platform; null when invalid/unavailable. */
  speedMps: number | null;
  courseDegrees: number | null;
  /** Unix epoch milliseconds (UTC). */
  recordedAt: number;
  source: LocationSource;
}

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface GeoBounds {
  minLatitude: number;
  minLongitude: number;
  maxLatitude: number;
  maxLongitude: number;
}
