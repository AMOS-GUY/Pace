import type { Activity } from '@pace/domain';
import { destinationPoint, haversineDistanceMeters } from '@pace/gps-engine';
import { ORIGIN, straightTrack } from '../../gps-engine/src/test-fixtures/synthetic-track';
import {
  GpxImportError,
  activitiesToCsv,
  csvField,
  escapeXml,
  parseGpx,
  toGpx,
  trimPrivacyZone,
} from './index';

describe('GPX', () => {
  const track = straightTrack({ speedMps: 3, durationSeconds: 60, altitude: (t) => 10 + t / 10 });

  it('round-trips export and import', () => {
    const xml = toGpx({
      name: 'Morning <Run> & "friends"',
      description: 'Easy',
      sportType: 'running',
      startedAt: track[0]!.recordedAt,
      segments: [track.slice(0, 30), track.slice(30)],
      heartRate: [{ recordedAt: track[0]!.recordedAt, bpm: 141 }],
    });
    expect(xml).toContain('Morning &lt;Run&gt; &amp; &quot;friends&quot;');
    expect(xml).toContain('<gpxtpx:hr>141</gpxtpx:hr>');
    const parsed = parseGpx(xml);
    expect(parsed.name).toBe('Morning <Run> & "friends"');
    expect(parsed.sportType).toBe('running');
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments.flat()).toHaveLength(track.length);
    const p0 = parsed.segments[0]![0]!;
    expect(p0.latitude).toBeCloseTo(track[0]!.latitude, 6);
    expect(p0.altitudeMeters).toBeCloseTo(10, 1);
    expect(p0.recordedAt).toBe(track[0]!.recordedAt);
    // A heart-rate reading applies to track points up to 5 s after it.
    expect(parsed.heartRate[0]).toEqual({ recordedAt: track[0]!.recordedAt, bpm: 141 });
    expect(parsed.heartRate).toHaveLength(6);
  });

  it('imports third-party GPX with namespaces and skips invalid points', () => {
    const xml = `<?xml version="1.0"?>
<gpx xmlns="http://www.topografix.com/GPX/1/1" version="1.1" creator="Other">
 <trk><name>Ride</name><type>cycling</type><trkseg>
  <trkpt lat="47.1" lon="8.5"><ele>400</ele><time>2026-05-01T07:00:00Z</time></trkpt>
  <trkpt lat="999" lon="8.5"><time>2026-05-01T07:00:01Z</time></trkpt>
  <trkpt lat="47.1001" lon="8.5"><time>2026-05-01T07:00:02Z</time></trkpt>
  <trkpt lat="47.1002" lon="8.5"><time>2026-05-01T07:00:01Z</time></trkpt>
 </trkseg></trk></gpx>`;
    const r = parseGpx(xml);
    expect(r.sportType).toBe('cycling');
    expect(r.segments[0]).toHaveLength(2);
    expect(r.warnings).toHaveLength(2);
  });

  it('rejects malicious or unusable files', () => {
    expect(() => parseGpx('<!DOCTYPE x [<!ENTITY a "aaaa">]><gpx/>')).toThrow(GpxImportError);
    expect(() => parseGpx('not xml at all <')).toThrow(GpxImportError);
    expect(() => parseGpx('<gpx version="1.1"></gpx>')).toThrow('no tracks');
    expect(() =>
      parseGpx('<gpx><trk><trkseg><trkpt lat="1" lon="1"/></trkseg></trk></gpx>'),
    ).toThrow('fewer than two');
  });

  it('escapes illegal XML characters', () => {
    expect(escapeXml('a\u0001b<')).toBe('ab&lt;');
  });
});

describe('CSV', () => {
  it('escapes fields and neutralises formula injection', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvField(null)).toBe('');
  });

  it('exports activity summaries with unit-explicit headers', () => {
    const a = {
      id: 'id-1',
      sportType: 'running',
      title: 'Run',
      startedAt: Date.UTC(2026, 0, 1),
      timezone: 'UTC',
      elapsedDurationMs: 1000,
      movingDurationMs: 900,
      distanceMeters: 5000,
      elevationGainMeters: 10,
      averageSpeedMps: 3,
      maximumSpeedMps: 4,
      averagePaceMsPerKm: 300000,
      source: 'recorded',
      description: null,
    } as unknown as Activity;
    const csv = activitiesToCsv([a]);
    expect(csv.split('\r\n')[0]).toContain('distance_meters');
    expect(csv).toContain('id-1,running,Run,2026-01-01T00:00:00.000Z,UTC,1000,900,5000.0');
  });
});

describe('privacy zone', () => {
  it('trims the start and end of a route', () => {
    const pts = Array.from({ length: 101 }, (_, i) => destinationPoint(ORIGIN, 90, i * 10));
    const trimmed = trimPrivacyZone([pts.slice(0, 50), pts.slice(50)], 195).flat();
    expect(haversineDistanceMeters(ORIGIN, trimmed[0]!)).toBeGreaterThanOrEqual(195);
    expect(haversineDistanceMeters(pts[100]!, trimmed[trimmed.length - 1]!)).toBeGreaterThanOrEqual(
      195,
    );
    expect(trimmed.length).toBe(61);
    expect(trimPrivacyZone([pts], 0)[0]).toHaveLength(101);
  });
});
