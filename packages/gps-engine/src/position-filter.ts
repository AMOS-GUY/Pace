import type { GeoPoint } from '@pace/domain';

/**
 * Minimal accuracy-weighted Kalman filter for 2D position.
 *
 * State is a position with an isotropic variance (m^2). Each step the variance grows by
 * `processNoiseMps^2 * dt` (how far the athlete can plausibly have moved) and is then fused
 * with the new fix weighted by its reported accuracy. Good fixes pull hard; poor fixes pull
 * gently. Jitter while stationary is strongly damped, which prevents drift from inflating
 * distance, while genuine movement is followed with a small, bounded lag.
 *
 * The filter only produces *processed* coordinates; raw samples are never altered.
 */
export class PositionFilter {
  private lat = 0;
  private lng = 0;
  private variance = -1;
  private time = 0;

  constructor(private readonly processNoiseMps: number) {
    if (!(processNoiseMps > 0)) throw new Error('Process noise must be positive');
  }

  get initialized(): boolean {
    return this.variance >= 0;
  }

  reset(p: GeoPoint, accuracyMeters: number, time: number): GeoPoint {
    this.lat = p.latitude;
    this.lng = p.longitude;
    this.variance = Math.max(1, accuracyMeters) ** 2;
    this.time = time;
    return { latitude: this.lat, longitude: this.lng };
  }

  update(p: GeoPoint, accuracyMeters: number, time: number): GeoPoint {
    // Uninitialised, or a longitude wrap across the antimeridian: restart from the fix.
    if (!this.initialized || Math.abs(p.longitude - this.lng) > 180) {
      return this.reset(p, accuracyMeters, time);
    }
    const dt = Math.max(0, (time - this.time) / 1000);
    this.time = time;
    this.variance += dt * this.processNoiseMps ** 2;
    const measurementVariance = Math.max(1, accuracyMeters) ** 2;
    const k = this.variance / (this.variance + measurementVariance);
    this.lat += k * (p.latitude - this.lat);
    this.lng += k * (p.longitude - this.lng);
    this.variance = (1 - k) * this.variance;
    return { latitude: this.lat, longitude: this.lng };
  }
}
