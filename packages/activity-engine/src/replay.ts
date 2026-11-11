import type { LocationSample } from '@pace/domain';
import { type RecordedEvent, RecordingSession, type SessionConfig } from './recording-session';

/**
 * Deterministic replay: rebuilds a session from persisted control events and raw samples.
 *
 * Events carry the number of samples processed before them, so interleaving is exact and
 * independent of wall-clock timing. Used for crash recovery and for reproducible GPS tests
 * (synthetic or recorded sequences). Auto-pause is *not* re-detected: the persisted
 * auto-pause events are applied as recorded, so results never drift between versions.
 */
export function replaySession(
  config: SessionConfig,
  events: readonly RecordedEvent[],
  samples: readonly LocationSample[],
  options: { recovering?: boolean } = {},
): RecordingSession {
  const session = new RecordingSession(config);
  if (options.recovering) session.beginRecovery();
  let next = 0;
  for (const e of events) {
    while (session.processedSampleCount < e.afterSampleCount) {
      const s = samples[next++];
      if (!s)
        throw new Error(
          `Replay is missing samples: event needs ${e.afterSampleCount}, have ${samples.length}`,
        );
      session.ingestSample(s, { detectAutoPause: false });
    }
    session.replayEvent(e);
  }
  while (next < samples.length) session.ingestSample(samples[next++]!, { detectAutoPause: false });
  return session;
}

/**
 * Convenience for tests and tooling: run a full live session over a sample sequence with
 * control commands at given sample indices, exactly as the live coordinator would.
 */
export type ScriptStep =
  | { atSample: number; command: 'pause' | 'resume' | 'lap' | 'advanceLeg' | 'interrupt' }
  | { atSample: number; command: 'poolLap'; lengthCount: number };

export function runScript(
  config: SessionConfig,
  samples: readonly LocationSample[],
  steps: readonly ScriptStep[],
  options: { startAt?: number; finishAt?: number } = {},
): { session: RecordingSession; events: RecordedEvent[] } {
  const session = new RecordingSession(config);
  const events: RecordedEvent[] = [];
  const t0 = options.startAt ?? samples[0]?.recordedAt ?? 0;
  events.push(...session.start(t0, { withoutFix: true }));
  const sorted = [...steps].sort((a, b) => a.atSample - b.atSample);
  let si = 0;
  const timeAt = (i: number): number => samples[Math.min(i, samples.length - 1)]?.recordedAt ?? t0;
  for (let i = 0; i <= samples.length; i++) {
    while (si < sorted.length && sorted[si]!.atSample === i) {
      const st = sorted[si++]!;
      const at = i === 0 ? t0 : timeAt(i - 1);
      switch (st.command) {
        case 'pause':
          events.push(...session.pause(at));
          break;
        case 'resume':
          events.push(...session.resume(timeAt(i)));
          break;
        case 'lap':
          events.push(...session.lap(at));
          break;
        case 'poolLap':
          events.push(...session.lap(at, st.lengthCount));
          break;
        case 'advanceLeg':
          events.push(...session.advanceLeg(at));
          break;
        case 'interrupt':
          events.push(...session.interrupt(at));
          break;
      }
    }
    if (i < samples.length) events.push(...session.ingestSample(samples[i]!));
  }
  events.push(...session.finish(options.finishAt ?? timeAt(samples.length - 1)));
  return { session, events };
}
