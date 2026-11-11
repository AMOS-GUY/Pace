import type {
  Activity,
  PersonalRecord,
  RecordBasis,
  RecordMetricType,
  SportType,
} from '@pace/domain';
import { bestEffort } from './best-effort';
import type { TimedDistancePoint } from './splits';

export interface RecordRule {
  metric: RecordMetricType;
  kind: 'fastest_distance' | 'longest_distance' | 'longest_duration' | 'highest_elevation_gain';
  distanceMeters?: number;
}

export interface RecordCandidate {
  sportType: SportType;
  metricType: RecordMetricType;
  value: number;
  unit: 'ms' | 'meters';
  basis: RecordBasis;
  activityId: string;
  achievedAt: number;
}

export interface RecordQuality {
  /** Only GPS-derived activities with dense, low-gap tracks qualify for segment records. */
  hasReliableTrack: boolean;
}

/**
 * Computes record candidates for one activity. Segment ("fastest X") records are only produced
 * when the track is reliable; they are labelled `estimated_segment` so they are never confused
 * with official race results.
 */
export function recordCandidatesForActivity(
  activity: Pick<
    Activity,
    | 'id'
    | 'sportType'
    | 'startedAt'
    | 'distanceMeters'
    | 'movingDurationMs'
    | 'elevationGainMeters'
    | 'status'
    | 'deletedAt'
  >,
  points: readonly TimedDistancePoint[],
  rules: readonly RecordRule[],
  quality: RecordQuality,
): RecordCandidate[] {
  if (activity.status !== 'completed' || activity.deletedAt != null) return [];
  const out: RecordCandidate[] = [];
  const base = {
    sportType: activity.sportType,
    activityId: activity.id,
    achievedAt: activity.startedAt,
  };
  for (const rule of rules) {
    switch (rule.kind) {
      case 'fastest_distance': {
        if (!quality.hasReliableTrack || rule.distanceMeters == null) break;
        const effort = bestEffort(points, rule.distanceMeters);
        if (effort) {
          out.push({
            ...base,
            metricType: rule.metric,
            value: Math.round(effort.durationMs),
            unit: 'ms',
            basis: 'estimated_segment',
          });
        }
        break;
      }
      case 'longest_distance':
        if (activity.distanceMeters > 0) {
          out.push({
            ...base,
            metricType: rule.metric,
            value: activity.distanceMeters,
            unit: 'meters',
            basis: 'whole_activity',
          });
        }
        break;
      case 'longest_duration':
        if (activity.movingDurationMs > 0) {
          out.push({
            ...base,
            metricType: rule.metric,
            value: activity.movingDurationMs,
            unit: 'ms',
            basis: 'whole_activity',
          });
        }
        break;
      case 'highest_elevation_gain':
        if (activity.elevationGainMeters > 0) {
          out.push({
            ...base,
            metricType: rule.metric,
            value: activity.elevationGainMeters,
            unit: 'meters',
            basis: 'whole_activity',
          });
        }
        break;
    }
  }
  return out;
}

/** Lower is better for "fastest" metrics; higher is better for everything else. */
export function isBetter(metric: RecordMetricType, candidate: number, current: number): boolean {
  return metric.startsWith('fastest_') ? candidate < current : candidate > current;
}

/**
 * Recomputes the best record per (sport, metric) from all candidates. Deterministic: ties are
 * broken by the earliest achievement, so re-running never changes an existing record.
 */
export function bestRecords(candidates: readonly RecordCandidate[]): RecordCandidate[] {
  const best = new Map<string, RecordCandidate>();
  for (const c of candidates) {
    const key = `${c.sportType}:${c.metricType}`;
    const cur = best.get(key);
    if (
      !cur ||
      isBetter(c.metricType, c.value, cur.value) ||
      (c.value === cur.value && c.achievedAt < cur.achievedAt)
    ) {
      best.set(key, c);
    }
  }
  return [...best.values()];
}

/** Records in `next` that are new or improved relative to `previous`. */
export function improvedRecords(
  previous: readonly Pick<PersonalRecord, 'sportType' | 'metricType' | 'value'>[],
  next: readonly RecordCandidate[],
): RecordCandidate[] {
  const prev = new Map(previous.map((r) => [`${r.sportType}:${r.metricType}`, r.value]));
  return next.filter((c) => {
    const p = prev.get(`${c.sportType}:${c.metricType}`);
    return p == null || isBetter(c.metricType, c.value, p);
  });
}
