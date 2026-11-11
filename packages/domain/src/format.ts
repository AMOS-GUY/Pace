import type { MeasurementSystem } from './profile';
import {
  metersToFeet,
  metersToKilometers,
  metersToMiles,
  mpsToKph,
  mpsToMph,
  paceMsPerKmToMsPerMile,
} from './units';

/** Placeholder rendered when a metric is not available or not meaningful. */
export const NO_VALUE = '—';

/** Formats a duration as H:MM:SS, or M:SS when under one hour. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return NO_VALUE;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const ss = String(seconds).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  return `${minutes}:${ss}`;
}

/** Distance value in the user's unit with fixed decimals (no unit suffix). */
export function formatDistanceValue(
  meters: number | null | undefined,
  system: MeasurementSystem,
  decimals = 2,
): string {
  if (meters == null || !Number.isFinite(meters) || meters < 0) return NO_VALUE;
  const value = system === 'metric' ? metersToKilometers(meters) : metersToMiles(meters);
  return value.toFixed(decimals);
}

function formatMinutesSeconds(ms: number): string {
  // Round to whole seconds first so 4:59.7 renders as 5:00, never 4:60.
  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

/** Pace in the user's unit as M:SS (per km or per mile). */
export function formatPace(msPerKm: number | null | undefined, system: MeasurementSystem): string {
  if (msPerKm == null || !Number.isFinite(msPerKm) || msPerKm <= 0) return NO_VALUE;
  return formatMinutesSeconds(system === 'metric' ? msPerKm : paceMsPerKmToMsPerMile(msPerKm));
}

/** Pace per 100 metres (swimming) as M:SS. */
export function formatPacePer100m(msPerKm: number | null | undefined): string {
  if (msPerKm == null || !Number.isFinite(msPerKm) || msPerKm <= 0) return NO_VALUE;
  return formatMinutesSeconds(msPerKm / 10);
}

export function formatSpeed(
  mps: number | null | undefined,
  system: MeasurementSystem,
  decimals = 1,
): string {
  if (mps == null || !Number.isFinite(mps) || mps < 0) return NO_VALUE;
  return (system === 'metric' ? mpsToKph(mps) : mpsToMph(mps)).toFixed(decimals);
}

export function formatElevation(
  meters: number | null | undefined,
  system: MeasurementSystem,
): string {
  if (meters == null || !Number.isFinite(meters)) return NO_VALUE;
  return String(Math.round(system === 'metric' ? meters : metersToFeet(meters)));
}
