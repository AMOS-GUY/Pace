import type { Activity, MeasurementSystem, SportType } from '@pace/domain';
import {
  distanceUnitLabel,
  elevationUnitLabel,
  formatDistanceValue,
  formatDuration,
  formatElevation,
  formatPace,
  formatPacePer100m,
  formatSpeed,
  paceUnitLabel,
  speedUnitLabel,
} from '@pace/domain';
import { getSport } from '@pace/sports';

export interface DisplayMetric {
  label: string;
  value: string;
  unit?: string;
}

export function sportLabel(s: SportType): string {
  return getSport(s).label;
}

export function sportIcon(s: SportType): string {
  return getSport(s).icon;
}

export function distanceMetric(
  meters: number,
  units: MeasurementSystem,
  label = 'Distance',
): DisplayMetric {
  return { label, value: formatDistanceValue(meters, units), unit: distanceUnitLabel(units) };
}

/** The sport-appropriate average: pace for running/walking, speed for cycling/hiking, /100 m for swims. */
export function averageMetric(
  sport: SportType,
  a: Pick<Activity, 'averagePaceMsPerKm' | 'averageSpeedMps'>,
  units: MeasurementSystem,
): DisplayMetric {
  switch (getSport(sport).primaryMetric) {
    case 'pace':
      return {
        label: 'Avg pace',
        value: formatPace(a.averagePaceMsPerKm, units),
        unit: paceUnitLabel(units),
      };
    case 'pace_per_100m':
      return { label: 'Avg pace', value: formatPacePer100m(a.averagePaceMsPerKm), unit: '/100m' };
    case 'speed':
      return {
        label: 'Avg speed',
        value: formatSpeed(a.averageSpeedMps, units),
        unit: speedUnitLabel(units),
      };
  }
}

export function currentMetric(
  sport: SportType,
  paceMsPerKm: number | null,
  speedMps: number | null,
  units: MeasurementSystem,
): DisplayMetric {
  switch (getSport(sport).primaryMetric) {
    case 'pace':
      return { label: 'Pace', value: formatPace(paceMsPerKm, units), unit: paceUnitLabel(units) };
    case 'pace_per_100m':
      return { label: 'Pace', value: formatPacePer100m(paceMsPerKm), unit: '/100m' };
    case 'speed':
      return { label: 'Speed', value: formatSpeed(speedMps, units), unit: speedUnitLabel(units) };
  }
}

export function elevationMetric(
  meters: number,
  units: MeasurementSystem,
  label = 'Elevation',
): DisplayMetric {
  return { label, value: formatElevation(meters, units), unit: elevationUnitLabel(units) };
}

export const durationMetric = (ms: number, label = 'Time'): DisplayMetric => ({
  label,
  value: formatDuration(ms),
});

export function formatDate(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(ms));
}

export function formatDateTime(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(ms));
}

export function greeting(now: Date = new Date()): string {
  const h = now.getHours();
  return h < 5
    ? 'Good night'
    : h < 12
      ? 'Good morning'
      : h < 18
        ? 'Good afternoon'
        : 'Good evening';
}
