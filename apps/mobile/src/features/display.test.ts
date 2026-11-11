import { averageMetric, currentMetric, distanceMetric, elevationMetric } from './display';

describe('display helpers', () => {
  const a = { averagePaceMsPerKm: 300_000, averageSpeedMps: 3.333 };

  it('uses pace for running, speed for cycling and /100 m for swimming', () => {
    expect(averageMetric('running', a, 'metric')).toEqual({
      label: 'Avg pace',
      value: '5:00',
      unit: '/km',
    });
    expect(averageMetric('cycling', a, 'metric')).toEqual({
      label: 'Avg speed',
      value: '12.0',
      unit: 'km/h',
    });
    expect(
      averageMetric('swimming', { averagePaceMsPerKm: 1_200_000, averageSpeedMps: null }, 'metric'),
    ).toEqual({
      label: 'Avg pace',
      value: '2:00',
      unit: '/100m',
    });
  });

  it('converts units for imperial users', () => {
    expect(distanceMetric(1609.344, 'imperial')).toEqual({
      label: 'Distance',
      value: '1.00',
      unit: 'mi',
    });
    expect(elevationMetric(100, 'imperial').value).toBe('328');
    expect(currentMetric('running', null, null, 'imperial')).toEqual({
      label: 'Pace',
      value: '—',
      unit: '/mi',
    });
  });
});
