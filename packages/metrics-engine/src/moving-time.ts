/** A closed-open interval [startedAt, endedAt) during which the athlete was recording and moving. */
export interface MovingInterval {
  startedAt: number;
  /** null = still open. */
  endedAt: number | null;
}

/** Total moving time up to `at` (inclusive of open intervals up to `at`). */
export function movingTimeAt(intervals: readonly MovingInterval[], at: number): number {
  let total = 0;
  for (const iv of intervals) {
    if (iv.startedAt >= at) break;
    const end = iv.endedAt == null ? at : Math.min(iv.endedAt, at);
    if (end > iv.startedAt) total += end - iv.startedAt;
  }
  return total;
}

/** Whether `at` falls within a moving interval. */
export function isMovingAt(intervals: readonly MovingInterval[], at: number): boolean {
  return intervals.some((iv) => at >= iv.startedAt && (iv.endedAt == null || at < iv.endedAt));
}
