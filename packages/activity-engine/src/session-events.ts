import type { LocationSample } from '@pace/domain';

/**
 * Persisted control events of a recording. Together with the raw samples they are sufficient
 * to deterministically reconstruct the whole session (see `replaySession`).
 */
export type SessionEvent =
  | { type: 'started'; at: number }
  | { type: 'paused'; at: number }
  | { type: 'resumed'; at: number }
  /** `at` is the time the athlete stopped moving (auto-pause is backdated to it). */
  | { type: 'auto_paused'; at: number }
  | { type: 'auto_resumed'; at: number }
  | { type: 'interrupted'; at: number }
  | { type: 'lap'; at: number; lengthCount?: number }
  | { type: 'leg_advanced'; at: number }
  | { type: 'finished'; at: number };

export type SessionEventType = SessionEvent['type'];

/** A raw sample with its per-activity sequence number (gap-free, starting at 0). */
export interface SequencedSample {
  sequenceNumber: number;
  sample: LocationSample;
}
