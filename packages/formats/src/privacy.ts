import type { GeoPoint } from '@pace/domain';
import { haversineDistanceMeters } from '@pace/gps-engine';

/**
 * Trims points within `meters` of the route's start and end for export, so a shared file does
 * not reveal a home or work location. Works on copies; stored samples are never modified.
 */
export function trimPrivacyZone<T extends GeoPoint>(
  segments: readonly (readonly T[])[],
  meters: number,
): T[][] {
  if (!(meters > 0)) return segments.map((s) => [...s]);
  const flat = segments.flatMap((s, segmentIndex) => s.map((point) => ({ point, segmentIndex })));
  if (flat.length === 0) return [];
  const first = flat[0]!.point;
  const last = flat[flat.length - 1]!.point;
  let start = 0;
  while (start < flat.length && haversineDistanceMeters(first, flat[start]!.point) < meters)
    start++;
  let end = flat.length - 1;
  while (end >= start && haversineDistanceMeters(last, flat[end]!.point) < meters) end--;

  const out: T[][] = [];
  let currentSegment = -1;
  for (const { point, segmentIndex } of flat.slice(start, end + 1)) {
    if (segmentIndex !== currentSegment) {
      out.push([]);
      currentSegment = segmentIndex;
    }
    out[out.length - 1]!.push(point);
  }
  return out;
}
