/**
 * Elevation accumulator: time-based smoothing followed by hysteresis.
 *
 * GPS altitude error is large (σ ≈ 3–10 m) and *temporally correlated*: it wanders over tens of
 * seconds. Hysteresis alone (count a change only once it exceeds a threshold) still counts that
 * wander as climbing — the replay suite measured 3× inflation with a 3 m threshold. Smoothing the
 * altitude with an exponential moving average (time constant `smoothingSeconds`, applied against
 * sample timestamps so it is independent of sampling rate) before the hysteresis removes most of
 * the wander while preserving real terrain. Deterministic for a given input sequence.
 */
export class ElevationAccumulator {
  private smoothed: number | null = null;
  private lastTime: number | null = null;
  private reference: number | null = null;
  private gain = 0;
  private loss = 0;
  private min: number | null = null;
  private max: number | null = null;

  constructor(
    private readonly thresholdMeters: number,
    private readonly smoothingSeconds = 0,
  ) {
    if (!(thresholdMeters > 0)) throw new Error('Elevation threshold must be positive');
    if (!(smoothingSeconds >= 0)) throw new Error('Smoothing must be non-negative');
  }

  /**
   * Add an altitude. `timeMs` drives the smoothing; without it (or with smoothing 0) the raw
   * altitude is used directly.
   */
  add(altitudeMeters: number, timeMs?: number): void {
    if (!Number.isFinite(altitudeMeters)) return;
    let value = altitudeMeters;
    if (this.smoothingSeconds > 0 && timeMs != null) {
      if (this.smoothed == null || this.lastTime == null) {
        this.smoothed = altitudeMeters;
      } else {
        const dt = Math.max(0, (timeMs - this.lastTime) / 1000);
        this.smoothed +=
          (1 - Math.exp(-dt / this.smoothingSeconds)) * (altitudeMeters - this.smoothed);
      }
      this.lastTime = timeMs;
      value = this.smoothed;
    }
    this.min = this.min == null ? value : Math.min(this.min, value);
    this.max = this.max == null ? value : Math.max(this.max, value);
    if (this.reference == null) {
      this.reference = value;
      return;
    }
    const delta = value - this.reference;
    if (delta >= this.thresholdMeters) {
      this.gain += delta;
      this.reference = value;
    } else if (delta <= -this.thresholdMeters) {
      this.loss += -delta;
      this.reference = value;
    }
  }

  /** Forget the reference and smoothing state (e.g. after a pause) so no climb is counted across it. */
  resetReference(): void {
    this.reference = null;
    this.smoothed = null;
    this.lastTime = null;
  }

  get gainMeters(): number {
    return this.gain;
  }
  get lossMeters(): number {
    return this.loss;
  }
  get minAltitudeMeters(): number | null {
    return this.min;
  }
  get maxAltitudeMeters(): number | null {
    return this.max;
  }
}
