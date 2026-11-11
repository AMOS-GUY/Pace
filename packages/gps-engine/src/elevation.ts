/**
 * Hysteresis-based elevation accumulator.
 *
 * GPS altitude is noisy (often +/- 5-15 m). Summing every fluctuation massively inflates
 * elevation gain. Instead, a reference altitude is kept and gain/loss is only accrued once
 * altitude moves beyond `thresholdMeters` from that reference, after which the reference moves.
 * This is deterministic and order-dependent only on the input sequence.
 */
export class ElevationAccumulator {
  private reference: number | null = null;
  private gain = 0;
  private loss = 0;
  private min: number | null = null;
  private max: number | null = null;

  constructor(private readonly thresholdMeters: number) {
    if (!(thresholdMeters > 0)) throw new Error('Elevation threshold must be positive');
  }

  add(altitudeMeters: number): void {
    if (!Number.isFinite(altitudeMeters)) return;
    this.min = this.min == null ? altitudeMeters : Math.min(this.min, altitudeMeters);
    this.max = this.max == null ? altitudeMeters : Math.max(this.max, altitudeMeters);
    if (this.reference == null) {
      this.reference = altitudeMeters;
      return;
    }
    const delta = altitudeMeters - this.reference;
    if (delta >= this.thresholdMeters) {
      this.gain += delta;
      this.reference = altitudeMeters;
    } else if (delta <= -this.thresholdMeters) {
      this.loss += -delta;
      this.reference = altitudeMeters;
    }
  }

  /** Forget the reference altitude (e.g. after a pause) so no climb is counted across it. */
  resetReference(): void {
    this.reference = null;
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
