import type { MeasurementSystem } from './profile';

export const METERS_PER_KILOMETER = 1000;
export const METERS_PER_MILE = 1609.344;
export const FEET_PER_METER = 3.280839895;
export const POUNDS_PER_KILOGRAM = 2.2046226218;
export const MS_PER_SECOND = 1000;
export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;

export function metersToKilometers(m: number): number {
  return m / METERS_PER_KILOMETER;
}
export function metersToMiles(m: number): number {
  return m / METERS_PER_MILE;
}
export function metersToFeet(m: number): number {
  return m * FEET_PER_METER;
}
export function mpsToKph(mps: number): number {
  return mps * 3.6;
}
export function mpsToMph(mps: number): number {
  return (mps * 3600) / METERS_PER_MILE;
}
export function kilogramsToPounds(kg: number): number {
  return kg * POUNDS_PER_KILOGRAM;
}

/** Convert a pace expressed per kilometre to the same pace per mile. */
export function paceMsPerKmToMsPerMile(msPerKm: number): number {
  return (msPerKm * METERS_PER_MILE) / METERS_PER_KILOMETER;
}

export function distanceUnitLabel(system: MeasurementSystem): 'km' | 'mi' {
  return system === 'metric' ? 'km' : 'mi';
}
export function speedUnitLabel(system: MeasurementSystem): 'km/h' | 'mph' {
  return system === 'metric' ? 'km/h' : 'mph';
}
export function paceUnitLabel(system: MeasurementSystem): '/km' | '/mi' {
  return system === 'metric' ? '/km' : '/mi';
}
export function elevationUnitLabel(system: MeasurementSystem): 'm' | 'ft' {
  return system === 'metric' ? 'm' : 'ft';
}
