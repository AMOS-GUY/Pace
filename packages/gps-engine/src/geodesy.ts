import type { GeoBounds, GeoPoint } from '@pace/domain';

/** IUGG mean Earth radius in metres. Appropriate for Haversine distance on the WGS84 ellipsoid. */
export const EARTH_MEAN_RADIUS_METERS = 6_371_008.8;

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/**
 * Great-circle distance between two points using the Haversine formula.
 *
 * Error versus the WGS84 ellipsoid is below ~0.5% (typically far below at activity scale),
 * which is well inside consumer GPS accuracy. Uses the numerically stable atan2 form.
 */
export function haversineDistanceMeters(a: GeoPoint, b: GeoPoint): number {
  const phi1 = a.latitude * DEG_TO_RAD;
  const phi2 = b.latitude * DEG_TO_RAD;
  const dPhi = (b.latitude - a.latitude) * DEG_TO_RAD;
  const dLambda = (b.longitude - a.longitude) * DEG_TO_RAD;
  const s = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_MEAN_RADIUS_METERS * Math.atan2(Math.sqrt(s), Math.sqrt(Math.max(0, 1 - s)));
}

/** Initial bearing from a to b in degrees [0, 360). */
export function initialBearingDegrees(a: GeoPoint, b: GeoPoint): number {
  const phi1 = a.latitude * DEG_TO_RAD;
  const phi2 = b.latitude * DEG_TO_RAD;
  const dLambda = (b.longitude - a.longitude) * DEG_TO_RAD;
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return (Math.atan2(y, x) * RAD_TO_DEG + 360) % 360;
}

/** Destination point given a start, bearing (degrees) and distance (metres) on a sphere. */
export function destinationPoint(
  start: GeoPoint,
  bearingDeg: number,
  distanceMeters: number,
): GeoPoint {
  const delta = distanceMeters / EARTH_MEAN_RADIUS_METERS;
  const theta = bearingDeg * DEG_TO_RAD;
  const phi1 = start.latitude * DEG_TO_RAD;
  const lambda1 = start.longitude * DEG_TO_RAD;
  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta),
  );
  const lambda2 =
    lambda1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2),
    );
  return {
    latitude: phi2 * RAD_TO_DEG,
    longitude: ((lambda2 * RAD_TO_DEG + 540) % 360) - 180,
  };
}

/** Bounding box of a set of points, or null when empty. */
export function computeBounds(points: readonly GeoPoint[]): GeoBounds | null {
  if (points.length === 0) return null;
  let minLatitude = Infinity;
  let minLongitude = Infinity;
  let maxLatitude = -Infinity;
  let maxLongitude = -Infinity;
  for (const p of points) {
    if (p.latitude < minLatitude) minLatitude = p.latitude;
    if (p.latitude > maxLatitude) maxLatitude = p.latitude;
    if (p.longitude < minLongitude) minLongitude = p.longitude;
    if (p.longitude > maxLongitude) maxLongitude = p.longitude;
  }
  return { minLatitude, minLongitude, maxLatitude, maxLongitude };
}

/** Perpendicular distance (metres) from p to segment ab using a local equirectangular projection. */
function perpendicularDistanceMeters(p: GeoPoint, a: GeoPoint, b: GeoPoint): number {
  const lat0 = a.latitude * DEG_TO_RAD;
  const kx = Math.cos(lat0) * EARTH_MEAN_RADIUS_METERS * DEG_TO_RAD;
  const ky = EARTH_MEAN_RADIUS_METERS * DEG_TO_RAD;
  const ax = 0;
  const ay = 0;
  const bx = (b.longitude - a.longitude) * kx;
  const by = (b.latitude - a.latitude) * ky;
  const px = (p.longitude - a.longitude) * kx;
  const py = (p.latitude - a.latitude) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px, py);
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
  return Math.hypot(px - t * dx, py - t * dy);
}

/**
 * Douglas–Peucker simplification for display geometry only. Never applied to stored raw samples.
 * Iterative implementation to avoid stack overflow on long activities.
 */
export function simplifyRoute<T extends GeoPoint>(
  points: readonly T[],
  toleranceMeters: number,
): T[] {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let maxDist = -1;
    let index = -1;
    for (let i = start + 1; i < end; i++) {
      const d = perpendicularDistanceMeters(points[i]!, points[start]!, points[end]!);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (index !== -1 && maxDist > toleranceMeters) {
      keep[index] = 1;
      stack.push([start, index], [index, end]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

/** Google encoded polyline (precision 5) — compact representation for processed geometry. */
export function encodePolyline(points: readonly GeoPoint[], precision = 5): string {
  const factor = 10 ** precision;
  let lastLat = 0;
  let lastLng = 0;
  let out = '';
  for (const p of points) {
    const lat = Math.round(p.latitude * factor);
    const lng = Math.round(p.longitude * factor);
    out += encodeSigned(lat - lastLat) + encodeSigned(lng - lastLng);
    lastLat = lat;
    lastLng = lng;
  }
  return out;
}

export function decodePolyline(encoded: string, precision = 5): GeoPoint[] {
  const factor = 10 ** precision;
  const points: GeoPoint[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const next = (): number => {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (index >= encoded.length) throw new Error('Malformed encoded polyline');
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += next();
    lng += next();
    points.push({ latitude: lat / factor, longitude: lng / factor });
  }
  return points;
}

function encodeSigned(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = '';
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  return out + String.fromCharCode(v + 63);
}
