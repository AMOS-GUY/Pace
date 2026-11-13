/**
 * Characterisation of how GPX `<type>` and TCX `Sport` values map to PACE sports. The validation
 * harness relies on this (a companion that names no sport is compared using the FIT's sport),
 * and the device-compatibility matrix in docs/M4_7_RELEASE_READINESS.md cites it. These tests
 * describe the current behaviour; they do not change it.
 */
import { garminTcx, stravaGpx, withSensors } from './test-fixtures/device-files';
import { straightTrack } from '../../gps-engine/src/test-fixtures/synthetic-track';
import { parseGpxTrack, parseTcx } from './index';

const pts = withSensors(straightTrack({ speedMps: 3, durationSeconds: 30 }));

describe('GPX <type> to PACE sport', () => {
  it.each([
    // Garmin Connect / generic names
    ['running', 'running'],
    ['trail_running', 'running'],
    ['cycling', 'cycling'],
    ['road_biking', 'cycling'],
    ['mountain_biking', 'cycling'],
    ['walking', 'walking'],
    ['hiking', 'hiking'],
    ['swimming', 'swimming'],
    ['open_water_swimming', 'swimming'],
    // Strava's numeric activity types
    ['9', 'running'],
    ['1', 'cycling'],
    ['10', 'walking'],
    ['4', 'hiking'],
  ])('maps %s to %s', (type, sport) => {
    expect(parseGpxTrack(stravaGpx({ name: 'x', type, points: pts })).sportType).toBe(sport);
  });

  it.each([
    'virtual_ride',
    'indoor_cycling',
    'gravel_cycling',
    'treadmill_running',
    'triathlon',
    'multi_sport',
    'other',
    '',
  ])('leaves "%s" without a sport (the athlete chooses one)', (type) => {
    expect(parseGpxTrack(stravaGpx({ name: 'x', type, points: pts })).sportType).toBeNull();
  });
});

describe('TCX Sport to PACE sport', () => {
  it.each([
    ['Running', 'running'],
    ['Biking', 'cycling'],
    ['Other', null],
  ] as const)('maps Sport="%s" to %s', (sport, expected) => {
    const [t] = parseTcx(garminTcx({ sport, laps: [{ tracks: [pts] }] }));
    expect(t!.sportType).toBe(expected);
  });
});
