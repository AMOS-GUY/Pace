import type { TimedDistancePoint } from './splits';

export interface BestEffort {
  distanceMeters: number;
  durationMs: number;
  /** Moving time at which the effort started. */
  startMovingTimeMs: number;
}

/**
 * Fastest moving time to cover `targetDistanceMeters` anywhere within the activity.
 *
 * O(n) sliding window. For each end point j the start is the moving time at which the athlete
 * was exactly `target` metres earlier, interpolated between the bracketing points. Returns null
 * when the activity is shorter than the target. Results are *estimated segment efforts*, not
 * official race results.
 */
export function bestEffort(
  points: readonly Pick<TimedDistancePoint, 'movingTimeMs' | 'cumulativeDistanceMeters'>[],
  targetDistanceMeters: number,
): BestEffort | null {
  if (!(targetDistanceMeters > 0) || points.length < 2) return null;
  const total =
    points[points.length - 1]!.cumulativeDistanceMeters - points[0]!.cumulativeDistanceMeters;
  if (total < targetDistanceMeters) return null;

  let best: BestEffort | null = null;
  let i = 0;
  for (let j = 1; j < points.length; j++) {
    const end = points[j]!;
    const startDistance = end.cumulativeDistanceMeters - targetDistanceMeters;
    if (startDistance < points[0]!.cumulativeDistanceMeters) continue;
    // Advance i so that points[i] <= startDistance < points[i+1].
    while (i + 1 < j && points[i + 1]!.cumulativeDistanceMeters <= startDistance) i++;
    const a = points[i]!;
    const b = points[i + 1]!;
    const span = b.cumulativeDistanceMeters - a.cumulativeDistanceMeters;
    const f = span > 0 ? (startDistance - a.cumulativeDistanceMeters) / span : 0;
    const startTime = a.movingTimeMs + f * (b.movingTimeMs - a.movingTimeMs);
    const duration = end.movingTimeMs - startTime;
    if (duration > 0 && (best == null || duration < best.durationMs)) {
      best = {
        distanceMeters: targetDistanceMeters,
        durationMs: duration,
        startMovingTimeMs: startTime,
      };
    }
  }
  return best;
}
