import { SPORT_TYPES } from '@pace/domain';
import { SPORTS, TRIATHLON_SEGMENTS, gpsPolicyFor } from './index';

describe('sports', () => {
  it('defines every supported sport', () => {
    for (const s of SPORT_TYPES) expect(SPORTS[s].type).toBe(s);
  });

  it('keeps auto-pause hysteresis well-formed', () => {
    for (const s of SPORT_TYPES) {
      const ap = SPORTS[s].autoPause;
      if (ap) expect(ap.resumeSpeedMps).toBeGreaterThan(ap.stopSpeedMps);
    }
  });

  it('never uses GPS for pool swimming', () => {
    expect(gpsPolicyFor('swimming', 'pool')).toBeNull();
    expect(gpsPolicyFor('swimming', 'open_water')?.id).toBe('open_water_swim');
    expect(gpsPolicyFor('cycling')?.id).toBe('ride');
  });

  it('orders triathlon segments swim, T1, bike, T2, run', () => {
    expect(TRIATHLON_SEGMENTS.map((s) => s.type)).toEqual([
      'swim',
      'transition_1',
      'bike',
      'transition_2',
      'run',
    ]);
  });
});
