/**
 * Deterministic recording lifecycle state machine.
 *
 *   READY → ACQUIRING_GPS → RECORDING ⇄ PAUSED → FINALIZING → SAVED
 *
 * plus PERMISSION_DENIED, LOCATION_UNAVAILABLE, RECOVERING, INTERRUPTED and FAILED.
 * `transition` is a pure function: invalid events never mutate state; they are reported
 * as `{ ok: false }` so callers can surface programming errors instead of silently ignoring them.
 */
export type RecordingState =
  | { status: 'READY' }
  | { status: 'PERMISSION_DENIED' }
  | { status: 'ACQUIRING_GPS'; since: number }
  | { status: 'LOCATION_UNAVAILABLE'; since: number }
  | { status: 'RECORDING'; autoPaused: boolean }
  | { status: 'PAUSED'; since: number }
  | { status: 'INTERRUPTED'; since: number }
  | { status: 'RECOVERING' }
  | { status: 'FINALIZING' }
  | { status: 'SAVED' }
  | { status: 'FAILED'; error: string; recoverable: boolean };

export type RecordingStatus = RecordingState['status'];

export type RecordingEvent =
  | { type: 'START_REQUESTED'; at: number; requiresGps: boolean }
  | { type: 'PERMISSION_GRANTED'; at: number }
  | { type: 'PERMISSION_DENIED' }
  | { type: 'GPS_ACQUIRED' }
  /** User chose to start before a GPS fix (samples will still be recorded when available). */
  | { type: 'START_WITHOUT_FIX' }
  | { type: 'LOCATION_UNAVAILABLE'; at: number }
  | { type: 'RETRY_ACQUISITION'; at: number }
  | { type: 'PAUSE'; at: number }
  | { type: 'RESUME' }
  | { type: 'AUTO_PAUSE' }
  | { type: 'AUTO_RESUME' }
  | { type: 'INTERRUPT'; at: number }
  | { type: 'FINISH' }
  | { type: 'DISCARD' }
  | { type: 'SAVE_SUCCEEDED' }
  | { type: 'SAVE_FAILED'; error: string }
  | { type: 'RETRY_SAVE' }
  | { type: 'RECOVERY_STARTED' }
  | { type: 'RECOVERY_SUCCEEDED'; resumeAs: 'RECORDING' | 'PAUSED' | 'INTERRUPTED'; at: number }
  | { type: 'RECOVERY_FAILED'; error: string }
  | { type: 'RESET' };

export type TransitionResult =
  { ok: true; state: RecordingState } | { ok: false; state: RecordingState; reason: string };

const ok = (state: RecordingState): TransitionResult => ({ ok: true, state });

export function transition(state: RecordingState, event: RecordingEvent): TransitionResult {
  const invalid = (): TransitionResult => ({
    ok: false,
    state,
    reason: `Event ${event.type} is not valid in state ${state.status}`,
  });

  switch (state.status) {
    case 'READY':
      if (event.type === 'START_REQUESTED') {
        return ok(
          event.requiresGps
            ? { status: 'ACQUIRING_GPS', since: event.at }
            : { status: 'RECORDING', autoPaused: false },
        );
      }
      if (event.type === 'PERMISSION_DENIED') return ok({ status: 'PERMISSION_DENIED' });
      if (event.type === 'RECOVERY_STARTED') return ok({ status: 'RECOVERING' });
      return invalid();

    case 'PERMISSION_DENIED':
      if (event.type === 'PERMISSION_GRANTED')
        return ok({ status: 'ACQUIRING_GPS', since: event.at });
      if (event.type === 'RESET' || event.type === 'DISCARD') return ok({ status: 'READY' });
      return invalid();

    case 'ACQUIRING_GPS':
      switch (event.type) {
        case 'GPS_ACQUIRED':
        case 'START_WITHOUT_FIX':
          return ok({ status: 'RECORDING', autoPaused: false });
        case 'PERMISSION_DENIED':
          return ok({ status: 'PERMISSION_DENIED' });
        case 'LOCATION_UNAVAILABLE':
          return ok({ status: 'LOCATION_UNAVAILABLE', since: event.at });
        case 'DISCARD':
          return ok({ status: 'READY' });
        default:
          return invalid();
      }

    case 'LOCATION_UNAVAILABLE':
      switch (event.type) {
        case 'RETRY_ACQUISITION':
          return ok({ status: 'ACQUIRING_GPS', since: event.at });
        case 'GPS_ACQUIRED':
        case 'START_WITHOUT_FIX':
          return ok({ status: 'RECORDING', autoPaused: false });
        case 'PERMISSION_DENIED':
          return ok({ status: 'PERMISSION_DENIED' });
        case 'DISCARD':
          return ok({ status: 'READY' });
        default:
          return invalid();
      }

    case 'RECORDING':
      switch (event.type) {
        case 'PAUSE':
          return ok({ status: 'PAUSED', since: event.at });
        case 'AUTO_PAUSE':
          return state.autoPaused ? invalid() : ok({ status: 'RECORDING', autoPaused: true });
        case 'AUTO_RESUME':
          return state.autoPaused ? ok({ status: 'RECORDING', autoPaused: false }) : invalid();
        case 'INTERRUPT':
          return ok({ status: 'INTERRUPTED', since: event.at });
        case 'FINISH':
          return ok({ status: 'FINALIZING' });
        case 'DISCARD':
          return ok({ status: 'READY' });
        default:
          return invalid();
      }

    case 'PAUSED':
      switch (event.type) {
        case 'RESUME':
          return ok({ status: 'RECORDING', autoPaused: false });
        case 'INTERRUPT':
          return ok({ status: 'INTERRUPTED', since: event.at });
        case 'FINISH':
          return ok({ status: 'FINALIZING' });
        case 'DISCARD':
          return ok({ status: 'READY' });
        default:
          return invalid();
      }

    case 'INTERRUPTED':
      switch (event.type) {
        case 'RESUME':
          return ok({ status: 'RECORDING', autoPaused: false });
        case 'FINISH':
          return ok({ status: 'FINALIZING' });
        case 'DISCARD':
          return ok({ status: 'READY' });
        default:
          return invalid();
      }

    case 'RECOVERING':
      if (event.type === 'RECOVERY_SUCCEEDED') {
        if (event.resumeAs === 'RECORDING') return ok({ status: 'RECORDING', autoPaused: false });
        if (event.resumeAs === 'PAUSED') return ok({ status: 'PAUSED', since: event.at });
        return ok({ status: 'INTERRUPTED', since: event.at });
      }
      if (event.type === 'RECOVERY_FAILED') {
        // Raw data remains on disk; the failure is surfaced, never silently dropped.
        return ok({ status: 'FAILED', error: event.error, recoverable: true });
      }
      return invalid();

    case 'FINALIZING':
      if (event.type === 'SAVE_SUCCEEDED') return ok({ status: 'SAVED' });
      if (event.type === 'SAVE_FAILED')
        return ok({ status: 'FAILED', error: event.error, recoverable: true });
      return invalid();

    case 'FAILED':
      if (event.type === 'RETRY_SAVE' && state.recoverable) return ok({ status: 'FINALIZING' });
      if (event.type === 'RESET') return ok({ status: 'READY' });
      return invalid();

    case 'SAVED':
      if (event.type === 'RESET') return ok({ status: 'READY' });
      return invalid();
  }
}

/** States in which an activity record exists and data is being (or was) captured. */
export function isActiveSession(state: RecordingState): boolean {
  return (
    state.status === 'RECORDING' || state.status === 'PAUSED' || state.status === 'INTERRUPTED'
  );
}
