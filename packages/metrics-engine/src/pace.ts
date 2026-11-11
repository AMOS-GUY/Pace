/**
 * Average moving pace in ms per km.
 *   pace_ms_per_km = moving_ms / (distance_m / 1000)
 * Returns null when distance is below `minDistanceMeters` or moving time is not positive,
 * because a pace over a few metres is noise, not information.
 */
export function averagePaceMsPerKm(
  distanceMeters: number,
  movingDurationMs: number,
  minDistanceMeters = 100,
): number | null {
  if (!(distanceMeters >= minDistanceMeters) || !(movingDurationMs > 0)) return null;
  return movingDurationMs / (distanceMeters / 1000);
}

/**
 * Average moving speed in m/s.
 *   speed_mps = distance_m / moving_s
 */
export function averageSpeedMps(
  distanceMeters: number,
  movingDurationMs: number,
  minDistanceMeters = 0,
): number | null {
  if (!(distanceMeters > 0) || distanceMeters < minDistanceMeters || !(movingDurationMs > 0)) {
    return null;
  }
  return distanceMeters / (movingDurationMs / 1000);
}

export function speedToPaceMsPerKm(speedMps: number | null): number | null {
  if (speedMps == null || !(speedMps > 0)) return null;
  return 1_000_000 / speedMps;
}
