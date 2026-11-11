import type { JournalEntry, LocationAuthorization, TrackingBridge } from '@pace/activity-engine';
import type { GpsPolicy } from '@pace/gps-engine';
import { locationSampleSchema } from '@pace/validation';
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

interface NativeEntry {
  sequence: number;
  sample: unknown;
}

interface EventSubscription {
  remove(): void;
}

interface PaceTrackingNative {
  getAuthorization(): Promise<LocationAuthorization>;
  requestAuthorization(level: 'when_in_use' | 'always'): Promise<LocationAuthorization>;
  startAcquisition(policy: GpsPolicy): Promise<void>;
  stopAcquisition(): Promise<void>;
  startRecording(activityId: string, policy: GpsPolicy): Promise<void>;
  updatePolicy(policy: GpsPolicy | null): Promise<void>;
  stopRecording(): Promise<void>;
  getRecordingActivityId(): Promise<string | null>;
  readJournal(activityId: string, fromSequence: number): Promise<NativeEntry[]>;
  acknowledge(activityId: string, throughSequence: number): Promise<void>;
  deleteJournal(activityId: string): Promise<void>;
  addListener(
    event: 'onSamples',
    cb: (e: { activityId: string | null; entries: NativeEntry[] }) => void,
  ): EventSubscription;
  addListener(
    event: 'onAuthorizationChange',
    cb: (e: { status: LocationAuthorization }) => void,
  ): EventSubscription;
  addListener(event: 'onError', cb: (e: { message: string }) => void): EventSubscription;
}

const Native = requireOptionalNativeModule<PaceTrackingNative>('PaceTracking');

export class TrackingUnavailableError extends Error {
  constructor() {
    super(
      Platform.OS === 'ios'
        ? 'The PACE tracking module is not in this build. Use a development build (npx expo run:ios), not Expo Go.'
        : 'GPS recording is not yet available on this platform.',
    );
  }
}

function native(): PaceTrackingNative {
  if (!Native) throw new TrackingUnavailableError();
  return Native;
}

export const isTrackingAvailable = (): boolean => Native != null;

/** Validates every sample crossing the native boundary; malformed ones are reported, not used. */
function toEntries(raw: NativeEntry[], onInvalid: (msg: string) => void): JournalEntry[] {
  const out: JournalEntry[] = [];
  for (const e of raw) {
    const parsed = locationSampleSchema.safeParse(e.sample);
    if (parsed.success) out.push({ sequence: e.sequence, sample: parsed.data });
    else
      onInvalid(
        `Invalid native sample #${e.sequence}: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
      );
  }
  return out;
}

/**
 * JS side of the native tracker, implementing the activity-engine TrackingBridge port.
 *
 * Note on validation: a structurally invalid sample from native would break the gap-free
 * sequence. That indicates a native bug; it is surfaced via `onError` and the sequence gap
 * makes the coordinator re-read the journal rather than silently skipping data.
 */
export function createNativeTrackingBridge(onError: (message: string) => void): TrackingBridge & {
  deleteJournal(activityId: string): Promise<void>;
  onAuthorizationChange(cb: (s: LocationAuthorization) => void): () => void;
} {
  return {
    getAuthorization: () => native().getAuthorization(),
    requestAuthorization: (level) => native().requestAuthorization(level),
    startAcquisition: (policy) => native().startAcquisition(policy),
    stopAcquisition: () => native().stopAcquisition(),
    startRecording: (id, policy) => native().startRecording(id, policy),
    updatePolicy: (policy) => native().updatePolicy(policy),
    stopRecording: () => native().stopRecording(),
    getRecordingActivityId: () => native().getRecordingActivityId(),
    readJournal: async (id, from) => toEntries(await native().readJournal(id, from), onError),
    acknowledge: (id, through) => native().acknowledge(id, through),
    deleteJournal: (id) => native().deleteJournal(id),
    addListener(listener) {
      if (!Native) return () => undefined;
      const a = Native.addListener('onSamples', (e) =>
        listener(e.activityId, toEntries(e.entries, onError)),
      );
      const b = Native.addListener('onError', (e) => onError(e.message));
      return () => {
        a.remove();
        b.remove();
      };
    },
    onAuthorizationChange(cb) {
      if (!Native) return () => undefined;
      const s = Native.addListener('onAuthorizationChange', (e) => cb(e.status));
      return () => s.remove();
    },
  };
}
