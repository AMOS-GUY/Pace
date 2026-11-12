import type { MeasurementSystem, TrainingGoal } from '@pace/domain';
import { formatDistanceValue } from '@pace/domain';
import type { Consistency, GoalProgress, PeriodBucket } from '@pace/metrics-engine';
import type { BarDatum } from './chart';

/**
 * Pure view-model helpers for the Home dashboard. They only reshape and format values computed
 * by the analytics engine; they never produce a number that is not in the input.
 */

/** "Thursday, 12 November" in the device locale (or `locale`). */
export function longDate(now: Date, locale?: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(timeZone ? { timeZone } : {}),
  }).format(now);
}

/** Up to two initials for the avatar; null when there is no usable name. */
export function initials(name: string | null | undefined): string | null {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const letters = parts.length === 1 ? [parts[0]!] : [parts[0]!, parts[parts.length - 1]!];
  return letters.map((p) => Array.from(p)[0]!.toLocaleUpperCase()).join('');
}

export interface ChangeLabel {
  text: string;
  direction: 'up' | 'down' | 'flat';
}

/** "+12 %" / "−8 %" from a relative change; null when there is no baseline to compare with. */
export function formatChange(ratio: number | null): ChangeLabel | null {
  if (ratio == null || !Number.isFinite(ratio)) return null;
  const pct = Math.round(ratio * 100);
  if (pct === 0) return { text: '0%', direction: 'flat' };
  return pct > 0
    ? { text: `+${pct}%`, direction: 'up' }
    : { text: `−${Math.abs(pct)}%`, direction: 'down' };
}

/** Single-letter weekday for a YYYY-MM-DD key ("M", "T", ...), independent of time zone. */
export function weekdayInitial(dateKey: string, locale?: string): string {
  const label = new Intl.DateTimeFormat(locale, { weekday: 'narrow', timeZone: 'UTC' }).format(
    new Date(`${dateKey}T12:00:00Z`),
  );
  return label;
}

/** "9 Nov" for a week bucket key (that week's Monday). */
export function weekLabel(weekKey: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${weekKey}T12:00:00Z`));
}

export function weeklyDistanceChart(
  weeks: readonly PeriodBucket[],
  units: MeasurementSystem,
  locale?: string,
): BarDatum[] {
  return weeks.map((w) => ({
    key: w.key,
    label: weekLabel(w.key, locale),
    value: w.distanceMeters,
    description: `Week of ${weekLabel(w.key, locale)}: ${formatDistanceValue(w.distanceMeters, units, 1)} ${units === 'metric' ? 'km' : 'mi'}, ${w.activityCount} ${w.activityCount === 1 ? 'activity' : 'activities'}`,
  }));
}

export function consistencyText(c: Consistency): { summary: string; streak: string | null } {
  return {
    summary: `Active in ${c.activeWeeks} of the last ${c.windowWeeks} weeks`,
    streak: c.currentStreakWeeks >= 2 ? `${c.currentStreakWeeks}-week streak` : null,
  };
}

/**
 * The goal shown in the weekly overview: the first active weekly goal, preferring one that
 * covers all sports. Null when the athlete has no weekly goal (the UI then offers to set one).
 */
export function primaryWeeklyGoal(
  goals: ReadonlyArray<{ goal: TrainingGoal; progress: GoalProgress }>,
): { goal: TrainingGoal; progress: GoalProgress } | null {
  const weekly = goals.filter((g) => g.goal.period === 'week');
  return weekly.find((g) => g.goal.sportType == null) ?? weekly[0] ?? null;
}
