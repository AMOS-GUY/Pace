import type { Split } from '@pace/domain';
import { ElevationAccumulator } from '@pace/gps-engine';
import { averagePaceMsPerKm, averageSpeedMps } from './pace';

/** A route point expressed against moving time rather than wall-clock time. */
export interface TimedDistancePoint {
  movingTimeMs: number;
  cumulativeDistanceMeters: number;
  altitudeMeters: number | null;
}

/**
 * Splits at fixed distance boundaries. The moving time at each boundary is linearly
 * interpolated between the two surrounding points (this interpolates a *time*, it never
 * creates route points). The final split is partial when the activity ends mid-split.
 */
export function computeSplits(
  points: readonly TimedDistancePoint[],
  splitDistanceMeters: number,
  options: { minPartialMeters?: number; elevationThresholdMeters?: number } = {},
): Split[] {
  if (!(splitDistanceMeters > 0)) throw new Error('Split distance must be positive');
  if (points.length < 2) return [];
  const minPartial = options.minPartialMeters ?? 50;
  const splits: Split[] = [];
  let splitStartTime = points[0]!.movingTimeMs;
  let splitStartDistance = points[0]!.cumulativeDistanceMeters;
  let nextBoundary = splitStartDistance + splitDistanceMeters;
  // Elevation per split uses the same hysteresis as activity totals, never raw fluctuation sums.
  const elevation = new ElevationAccumulator(options.elevationThresholdMeters ?? 3);
  if (points[0]!.altitudeMeters != null) elevation.add(points[0]!.altitudeMeters);
  let gainAtSplitStart = 0;

  const push = (endDistance: number, endTime: number, partial: boolean): void => {
    const distance = endDistance - splitStartDistance;
    const duration = endTime - splitStartTime;
    splits.push({
      index: splits.length,
      distanceMeters: distance,
      movingDurationMs: duration,
      paceMsPerKm: averagePaceMsPerKm(distance, duration, Math.min(minPartial, distance)),
      speedMps: averageSpeedMps(distance, duration),
      elevationGainMeters: elevation.gainMeters - gainAtSplitStart,
      isPartial: partial,
    });
    gainAtSplitStart = elevation.gainMeters;
  };

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (b.altitudeMeters != null) elevation.add(b.altitudeMeters);

    while (b.cumulativeDistanceMeters >= nextBoundary) {
      const span = b.cumulativeDistanceMeters - a.cumulativeDistanceMeters;
      const f = span > 0 ? (nextBoundary - a.cumulativeDistanceMeters) / span : 1;
      const t = a.movingTimeMs + f * (b.movingTimeMs - a.movingTimeMs);
      push(nextBoundary, t, false);
      splitStartDistance = nextBoundary;
      splitStartTime = t;
      nextBoundary += splitDistanceMeters;
    }
  }
  const last = points[points.length - 1]!;
  if (last.cumulativeDistanceMeters - splitStartDistance >= minPartial) {
    push(last.cumulativeDistanceMeters, last.movingTimeMs, true);
  }
  return splits;
}
