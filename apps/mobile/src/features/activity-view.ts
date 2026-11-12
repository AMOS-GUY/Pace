import type { Activity, ActivitySource, MeasurementSystem, Split } from '@pace/domain';
import { NO_VALUE, formatDuration, localMonthKey } from '@pace/domain';
import { getSport } from '@pace/sports';
import { type DisplayMetric, averageMetric, distanceMetric, elevationMetric } from './display';

/**
 * Pure view-model helpers for activity lists and the activity detail screen. Missing values
 * stay missing: a metric that was not measured is omitted or shown as "—", never estimated.
 */

/** Sports whose elevation comes from a GPS track (pool and open-water swims have none). */
const ELEVATION_SPORTS = new Set(['running', 'cycling', 'walking', 'hiking', 'triathlon']);

export function showsElevation(a: Pick<Activity, 'sportType'>): boolean {
  return ELEVATION_SPORTS.has(a.sportType);
}

export function isPoolSwim(a: Pick<Activity, 'sportType' | 'swimMode'>): boolean {
  return a.sportType === 'swimming' && a.swimMode === 'pool';
}

/** The compact metrics shown on an activity card, in display order. */
export function cardMetrics(
  a: Pick<
    Activity,
    | 'sportType'
    | 'distanceMeters'
    | 'movingDurationMs'
    | 'averagePaceMsPerKm'
    | 'averageSpeedMps'
    | 'elevationGainMeters'
  >,
  units: MeasurementSystem,
): DisplayMetric[] {
  const out: DisplayMetric[] = [];
  if (a.distanceMeters > 0) out.push(distanceMetric(a.distanceMeters, units));
  out.push({ label: 'Time', value: formatDuration(a.movingDurationMs) });
  const avg = averageMetric(a.sportType, a, units);
  if (avg.value !== NO_VALUE) out.push({ ...avg, label: avg.label.replace('Avg ', '') });
  if (showsElevation(a) && a.elevationGainMeters >= 1)
    out.push(elevationMetric(a.elevationGainMeters, units, 'Elev'));
  return out;
}

/** Time spent paused (manual or auto-pause) — elapsed minus moving, never negative. */
export function pausedDurationMs(
  a: Pick<Activity, 'elapsedDurationMs' | 'movingDurationMs'>,
): number {
  return Math.max(0, a.elapsedDurationMs - a.movingDurationMs);
}

export function sourceLabel(source: ActivitySource): string {
  switch (source) {
    case 'recorded':
      return 'Recorded with PACE';
    case 'imported_gpx':
      return 'Imported GPX';
    case 'imported_tcx':
      return 'Imported TCX';
    case 'imported_fit':
      return 'Imported FIT';
    case 'imported_backup':
      return 'Restored from backup';
    case 'manual':
      return 'Manual entry';
    case 'healthkit':
      return 'Apple Health';
  }
}

/** "Wed 11 Nov · 07:42" in the time zone where the activity was recorded. */
export function activityTimeLabel(
  a: Pick<Activity, 'startedAt' | 'timezone'>,
  locale?: string,
): string {
  const date = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: a.timezone,
  }).format(new Date(a.startedAt));
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: a.timezone,
  }).format(new Date(a.startedAt));
  return `${date} · ${time}`;
}

export interface MonthSection<T> {
  key: string;
  title: string;
  data: T[];
}

/**
 * Groups an already-sorted list into consecutive month sections (viewer's time zone), keeping
 * the list's order. Section totals are deliberately not computed here: a paginated list only
 * holds part of a month, so a sum would be wrong.
 */
export function groupByMonth<T extends Pick<Activity, 'startedAt'>>(
  items: readonly T[],
  timeZone: string,
  locale?: string,
): Array<MonthSection<T>> {
  const sections: Array<MonthSection<T>> = [];
  for (const item of items) {
    const key = localMonthKey(item.startedAt, timeZone);
    let last = sections[sections.length - 1];
    if (!last || last.key !== key) {
      last = {
        key,
        title: new Intl.DateTimeFormat(locale, {
          month: 'long',
          year: 'numeric',
          timeZone: 'UTC',
        }).format(new Date(`${key}-15T12:00:00Z`)),
        data: [],
      };
      sections.push(last);
    }
    last.data.push(item);
  }
  return sections;
}

export interface SplitBar {
  index: number;
  /** 0..1 relative to the fastest split; null when the split has no pace/speed. */
  ratio: number | null;
  fastest: boolean;
}

/**
 * Bar lengths for the split chart: the fastest split is 1, slower splits are proportionally
 * shorter (time-based, so a 10 % slower pace gives a ~0.91 bar).
 */
export function splitBars(splits: readonly Split[], sport: Activity['sportType']): SplitBar[] {
  const bySpeed = getSport(sport).primaryMetric === 'speed';
  const value = (s: Split): number | null => {
    if (bySpeed) return s.speedMps != null && s.speedMps > 0 ? s.speedMps : null;
    return s.paceMsPerKm != null && s.paceMsPerKm > 0 ? 1 / s.paceMsPerKm : null;
  };
  const values = splits.map(value);
  const best = Math.max(0, ...values.map((v) => v ?? 0));
  return splits.map((s, i) => {
    const v = values[i] ?? null;
    return {
      index: s.index,
      ratio: v == null || best === 0 ? null : v / best,
      fastest: v != null && v === best,
    };
  });
}

export interface RouteQuality {
  gapCount: number;
  gapDurationMs: number;
  acceptedSamples: number;
  rejectedSamples: number;
  /** Share of GPS samples the engine rejected (0..1); null when no samples were processed. */
  rejectedShare: number | null;
}

export function routeQuality(route: {
  gaps: ReadonlyArray<{ startedAt: number; endedAt: number }>;
  acceptedSampleCount: number;
  rejectedSampleCount: number;
}): RouteQuality {
  const total = route.acceptedSampleCount + route.rejectedSampleCount;
  return {
    gapCount: route.gaps.length,
    gapDurationMs: route.gaps.reduce((s, g) => s + Math.max(0, g.endedAt - g.startedAt), 0),
    acceptedSamples: route.acceptedSampleCount,
    rejectedSamples: route.rejectedSampleCount,
    rejectedShare: total > 0 ? route.rejectedSampleCount / total : null,
  };
}
