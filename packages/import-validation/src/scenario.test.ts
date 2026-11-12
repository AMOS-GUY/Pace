import {
  type Check,
  type Status,
  Secrets,
  buildReport,
  renderReports,
  validateActivity,
} from './index';
import {
  FIXTURE_SERIAL,
  indoorFit,
  pausedFit,
  pausedTcx,
  rideWithDropoutsFit,
  runFit,
  runGpx,
  runTcx,
  triathlonFit,
} from './test-fixtures/activities';

const byMetric = (checks: Check[], metric: string): Check => {
  const c = checks.find((x) => x.metric === metric);
  if (!c) throw new Error(`no check "${metric}" in: ${checks.map((x) => x.metric).join(', ')}`);
  return c;
};
const statuses = (checks: Check[], tier: Check['tier']): Status[] =>
  checks.filter((c) => c.tier === tier).map((c) => c.status);

describe('validation harness: activity scenarios', () => {
  it('V1: compares FIT, TCX and GPX three ways and passes when they agree', async () => {
    const [r] = await validateActivity(
      {
        id: 'V1',
        fit: runFit(),
        companions: [
          { format: 'tcx', text: runTcx() },
          { format: 'gpx', text: runGpx() },
        ],
        expect: {
          outcome: 'imported',
          sport: 'running',
          laps: 2,
          pauses: 0,
          sensors: { heart_rate: 'present', cadence: 'present', power: 'absent' },
          distanceMeters: { approx: 1950, tolerance: 100 },
          movingTimeSeconds: 'unknown',
        },
      },
      new Secrets(),
    );
    const checks = r!.checks;
    expect(r!.outcome).toBe('imported');
    expect(statuses(checks, 'integrity').every((s) => s === 'PASS')).toBe(true);
    // Direct format comparison.
    expect(byMetric(checks, 'start time (TCX)').status).toBe('PASS');
    expect(byMetric(checks, 'lap count (TCX)').status).toBe('PASS');
    expect(byMetric(checks, 'positions at matching times (TCX)').status).toBe('PASS');
    expect(byMetric(checks, 'heart rate samples (TCX)').status).toBe('PASS');
    expect(byMetric(checks, 'cadence samples (GPX)').status).toBe('PASS');
    expect(byMetric(checks, 'laps (GPX)').status).toBe('NOT TESTED');
    // PACE processing comparison.
    expect(byMetric(checks, 'distance (TCX)').status).toBe('PASS');
    expect(byMetric(checks, 'moving time (TCX)').status).toBe('PASS');
    expect(byMetric(checks, 'elapsed time (TCX)').status).toBe('PASS');
    expect(byMetric(checks, 'stored laps (TCX)').status).toBe('PASS');
    expect(byMetric(checks, 'duplicate detection (FIT then TCX)').status).toBe('PASS');
    expect(byMetric(checks, 'duplicate detection (FIT then GPX)').status).toBe('PASS');
    // Expectations: given ones pass, unknown ones are NOT TESTED, never assumed to pass.
    expect(byMetric(checks, 'laps').status).toBe('PASS');
    expect(byMetric(checks, 'power samples').status).toBe('PASS');
    expect(byMetric(checks, 'moving time').status).toBe('NOT TESTED');
    // No device totals in this file.
    expect(byMetric(checks, 'distance vs device total').status).toBe('NOT TESTED');
    expect(r!.status).toBe('PASS');
    expect(r!.companions).toEqual(['TCX', 'GPX']);
  });

  it('records device totals as informational: a different device distance is a WARNING, never a FAIL', async () => {
    const [agree] = await validateActivity(
      { id: 'V1', fit: runFit({ deviceDistance: 1950 }), companions: [], expect: {} },
      new Secrets(),
    );
    const pace = byMetric(agree!.checks, 'distance vs device total');
    expect(pace.reference).toBe(1950);
    const [differs] = await validateActivity(
      { id: 'V1', fit: runFit({ deviceDistance: 2300 }), companions: [], expect: {} },
      new Secrets(),
    );
    const c = byMetric(differs!.checks, 'distance vs device total');
    expect(c.status).toBe('WARNING');
    expect(c.reference).toBe(2300);
    expect(c.explanation).toMatch(/not ground truth/);
    expect(byMetric(differs!.checks, 'laps vs device').status).toBe('PASS');
    expect(differs!.status).toBe('WARNING');
    // PACE's own distance is the same in both runs: device totals never change the import.
    expect(byMetric(differs!.checks, 'distance vs device total').value).toBe(pace.value);
  });

  it('detects real discrepancies between formats instead of hiding them', async () => {
    const [r] = await validateActivity(
      {
        id: 'V1',
        fit: runFit(),
        companions: [{ format: 'tcx', text: runTcx({ hrOffset: 5, shiftDegrees: 0.0002 }) }],
        expect: {},
      },
      new Secrets(),
    );
    const pos = byMetric(r!.checks, 'positions at matching times (TCX)');
    expect(pos.status).toBe('FAIL');
    expect(pos.difference).toBeGreaterThan(20);
    const hr = byMetric(r!.checks, 'heart rate samples (TCX)');
    expect(hr.status).toBe('FAIL');
    expect(hr.difference).toBe(5);
    expect(r!.status).toBe('FAIL');
  });

  it('V2: pauses and laps are compared by count and duration', async () => {
    const [r] = await validateActivity(
      {
        id: 'V2',
        fit: pausedFit(),
        companions: [{ format: 'tcx', text: pausedTcx() }],
        expect: { pauses: 1, pauseSeconds: { approx: 61, tolerance: 1 }, laps: 2 },
      },
      new Secrets(),
    );
    expect(byMetric(r!.checks, 'pauses at segment boundaries').status).toBe('PASS');
    expect(byMetric(r!.checks, 'segments (pause structure) (TCX)').status).toBe('PASS');
    expect(byMetric(r!.checks, 'pause durations (TCX)').status).toBe('PASS');
    expect(byMetric(r!.checks, 'pauses').status).toBe('PASS');
    expect(byMetric(r!.checks, 'total pause time').status).toBe('PASS');
    expect(byMetric(r!.checks, 'laps').status).toBe('PASS');
    expect(r!.summary).toMatchObject({ pauses: 1, segments: 2, laps: 2 });
  });

  it('V5: missing measurements stay missing and zero values are kept', async () => {
    const [r] = await validateActivity(
      {
        id: 'V5',
        fit: rideWithDropoutsFit(),
        companions: [],
        expect: {
          sport: 'cycling',
          sensors: { power: 561, cadence: 'present' },
          zeroValues: { cadence: 'present', power: 'present', heart_rate: 'absent' },
          sensorGaps: { power: 'present', heart_rate: 'absent' },
        },
      },
      new Secrets(),
    );
    expect(byMetric(r!.checks, 'sensor samples stored as recorded').status).toBe('PASS');
    expect(byMetric(r!.checks, 'power sample count').status).toBe('PASS');
    expect(byMetric(r!.checks, 'cadence zero values kept').status).toBe('PASS');
    expect(byMetric(r!.checks, 'power zero values kept').status).toBe('PASS');
    expect(byMetric(r!.checks, 'power dropouts (gaps ≥ 10 s) left as gaps').status).toBe('PASS');
    expect(byMetric(r!.checks, 'heart rate dropouts (gaps ≥ 10 s) left as gaps').status).toBe(
      'PASS',
    );
    // No lap changes: PACE stores no lap rows; the harness counts that as one lap, explicitly.
    expect(r!.summary).toMatchObject({ laps: 1 });
    expect(r!.status).toBe('PASS');
  });

  it('a wrong expectation is a FAIL', async () => {
    const [r] = await validateActivity(
      {
        id: 'V5',
        fit: rideWithDropoutsFit(),
        companions: [],
        expect: { sensorGaps: { power: 'absent' }, laps: 3 },
      },
      new Secrets(),
    );
    expect(byMetric(r!.checks, 'power dropouts (gaps ≥ 10 s) left as gaps').status).toBe('FAIL');
    expect(byMetric(r!.checks, 'laps').status).toBe('FAIL');
    expect(r!.status).toBe('FAIL');
  });

  it('V8: a triathlon keeps its five legs', async () => {
    const [r] = await validateActivity(
      { id: 'V8', fit: triathlonFit(), companions: [], expect: { sport: 'triathlon', legs: 5 } },
      new Secrets(),
    );
    expect(byMetric(r!.checks, 'triathlon legs stored').status).toBe('PASS');
    expect(byMetric(r!.checks, 'legs').status).toBe('PASS');
    expect(r!.summary).toMatchObject({ legs: 5 });
    // The device writes one lap per leg; PACE records legs. Both count as lap boundaries.
    expect(byMetric(r!.checks, 'laps vs device')).toMatchObject({
      status: 'PASS',
      value: 5,
      reference: 5,
    });
    expect(byMetric(r!.checks, 'lap starts vs device').status).toBe('PASS');
  });

  it('V11/V18: refused files are reported with the reason; expected refusals pass', async () => {
    const indoor = await validateActivity(
      { id: 'V11', fit: indoorFit(), companions: [], expect: {} },
      new Secrets(),
    );
    expect(indoor[0]!.outcome).toBe('refused');
    expect(indoor[0]!.status).toBe('WARNING');
    const expected = await validateActivity(
      { id: 'V11', fit: indoorFit(), companions: [], expect: { outcome: 'refused' } },
      new Secrets(),
    );
    expect(expected[0]!.status).toBe('PASS');
    const strict = await validateActivity(
      { id: 'V11', fit: indoorFit(), companions: [], expect: {}, expectValid: true },
      new Secrets(),
    );
    expect(strict[0]!.status).toBe('FAIL');

    const damaged = runFit();
    damaged[200] = damaged[200]! ^ 0xff;
    const [d] = await validateActivity(
      { id: 'V18', fit: damaged, companions: [], expect: { outcome: 'refused' } },
      new Secrets(),
    );
    expect(d!.outcome).toBe('refused');
    expect(d!.status).toBe('PASS');
    expect(byMetric(d!.checks, 'file accepted').explanation).toMatch(/damaged|checksum/i);
  });

  it('an unreadable companion is a WARNING, not a crash', async () => {
    const [r] = await validateActivity(
      { id: 'V1', fit: runFit(), companions: [{ format: 'tcx', text: '<nope' }], expect: {} },
      new Secrets(),
    );
    expect(byMetric(r!.checks, 'TCX companion readable').status).toBe('WARNING');
  });
});

describe('validation harness: report privacy', () => {
  it('reports contain no serials, coordinates, titles or absolute times', async () => {
    const secrets = new Secrets();
    const results = await validateActivity(
      {
        id: 'V1',
        fit: runFit({ deviceDistance: 1950 }),
        companions: [
          { format: 'tcx', text: runTcx() },
          { format: 'gpx', text: runGpx() },
        ],
        expect: {},
      },
      secrets,
    );
    const { json, markdown } = renderReports(
      buildReport(results, { mode: 'folder', realDeviceFiles: false }),
      secrets,
    );
    for (const out of [json, markdown]) {
      expect(out).not.toContain(FIXTURE_SERIAL);
      expect(out).not.toMatch(/Jane Doe|Morning run/);
      expect(out).not.toMatch(/1\.29\d|103\.85/);
      expect(out).not.toMatch(/2026-10-04/);
      expect(out).not.toMatch(/\d{8,}/);
    }
    expect(JSON.parse(json).realDeviceFiles).toBe(false);
    expect(markdown).toContain('| V1 | PASS |');
  });

  it('refuses to render a report that would leak a secret', async () => {
    const secrets = new Secrets();
    const [r] = await validateActivity(
      { id: 'V1', fit: runFit(), companions: [], expect: {} },
      secrets,
    );
    r!.warnings.push(`seen in C:\\Users\\someone\\exports\\x.fit`);
    expect(() =>
      renderReports(buildReport([r!], { mode: 'folder', realDeviceFiles: false }), secrets),
    ).toThrow(/file path/);
    r!.warnings.pop();
    r!.warnings.push(`unit ${FIXTURE_SERIAL}`);
    expect(() =>
      renderReports(buildReport([r!], { mode: 'folder', realDeviceFiles: false }), secrets),
    ).toThrow(/^Output withheld: it would contain a file name, path or device identifier$/);
  });
});
