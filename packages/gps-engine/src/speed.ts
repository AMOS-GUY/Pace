interface SpeedSample {
  time: number;
  cumulativeDistanceMeters: number;
}

/**
 * Rolling-window speed estimator over accepted track points.
 *
 * Speed is derived from accepted displacement over a time window rather than single-sample
 * deltas, which suppresses spikes. Maximum speed only considers windows covering at least
 * half the configured duration so a single noisy pair cannot set a record.
 */
export class RollingSpeedEstimator {
  private window: SpeedSample[] = [];
  private max = 0;

  constructor(private readonly windowMs: number) {
    if (!(windowMs > 0)) throw new Error('Speed window must be positive');
  }

  add(time: number, cumulativeDistanceMeters: number): void {
    this.window.push({ time, cumulativeDistanceMeters });
    while (this.window.length > 2 && time - this.window[1]!.time >= this.windowMs) {
      this.window.shift();
    }
    const first = this.window[0]!;
    const span = time - first.time;
    if (span >= this.windowMs / 2 && span > 0) {
      const speed = ((cumulativeDistanceMeters - first.cumulativeDistanceMeters) * 1000) / span;
      if (speed > this.max) this.max = speed;
    }
  }

  /** Current speed at `now`, or null if there is no recent movement data. */
  currentSpeedMps(now: number): number | null {
    if (this.window.length < 2) return null;
    const last = this.window[this.window.length - 1]!;
    // Stale data (no fix for a full window) is not a current speed.
    if (now - last.time > this.windowMs) return null;
    const first = this.window[0]!;
    const span = now - first.time;
    if (span <= 0) return null;
    return ((last.cumulativeDistanceMeters - first.cumulativeDistanceMeters) * 1000) / span;
  }

  get maximumSpeedMps(): number | null {
    return this.max > 0 ? this.max : null;
  }

  /** Clear the window (pause / segment break) while retaining the maximum. */
  reset(): void {
    this.window = [];
  }
}
