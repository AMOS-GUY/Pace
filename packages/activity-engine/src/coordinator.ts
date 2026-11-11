import type {
  Activity,
  ActivityStatus,
  ActivitySummaryMetrics,
  LocationSample,
  SportType,
} from '@pace/domain';
import type { GpsPolicy } from '@pace/gps-engine';
import {
  type LiveMetrics,
  type RecordedEvent,
  RecordingSession,
  type SessionConfig,
  type SessionConfigOptions,
  type SessionSummary,
  sessionConfigFor,
} from './recording-session';
import { replaySession } from './replay';
import type { SequencedSample } from './session-events';

// ============================================================================ ports

export type LocationAuthorization =
  'undetermined' | 'denied' | 'restricted' | 'when_in_use' | 'always';

export interface JournalEntry {
  /** Per-activity, gap-free sequence number assigned by the native recorder (from 0). */
  sequence: number;
  sample: LocationSample;
}

/**
 * Native tracking service contract (implemented by the iOS Swift module; Android later).
 *
 * The native side owns location acquisition and appends every recording sample to a durable
 * on-device journal *before* notifying JavaScript, so samples survive JS suspension or a crash.
 * JavaScript copies journal entries into SQLite and acknowledges them, after which native may
 * compact its journal.
 */
export interface TrackingBridge {
  getAuthorization(): Promise<LocationAuthorization>;
  requestAuthorization(level: 'when_in_use' | 'always'): Promise<LocationAuthorization>;
  /** Start location updates for GPS acquisition only (no journaling, foreground only). */
  startAcquisition(policy: GpsPolicy): Promise<void>;
  /** Begin journaled (background-capable) recording for an activity. Idempotent per activity. */
  startRecording(activityId: string, policy: GpsPolicy): Promise<void>;
  /** Switch policy mid-recording (multisport legs) without interrupting the journal. */
  updatePolicy(policy: GpsPolicy | null): Promise<void>;
  stopRecording(): Promise<void>;
  stopAcquisition(): Promise<void>;
  /** Activity currently being journaled by native, if any (survives JS restarts). */
  getRecordingActivityId(): Promise<string | null>;
  readJournal(activityId: string, fromSequence: number): Promise<JournalEntry[]>;
  acknowledge(activityId: string, throughSequence: number): Promise<void>;
  /** activityId is null for acquisition-only samples. */
  addListener(listener: (activityId: string | null, entries: JournalEntry[]) => void): () => void;
  /** Remove the native journal once SQLite holds the final activity (or it was discarded). */
  deleteJournal?(activityId: string): Promise<void>;
}

export interface NewRecording {
  activity: Pick<
    Activity,
    | 'id'
    | 'userId'
    | 'sportType'
    | 'title'
    | 'startedAt'
    | 'timezone'
    | 'swimMode'
    | 'poolLengthMeters'
  >;
  config: SessionConfig;
}

export interface RecordingBatch {
  samples: SequencedSample[];
  events: RecordedEvent[];
  status: ActivityStatus;
  metrics: ActivitySummaryMetrics;
}

/** Persistence contract implemented by the SQLite repositories. Each call is one transaction. */
export interface RecordingStore {
  createRecording(input: NewRecording): Promise<void>;
  appendRecording(activityId: string, batch: RecordingBatch): Promise<void>;
  loadRecording(
    activityId: string,
  ): Promise<{ config: SessionConfig; samples: LocationSample[]; events: RecordedEvent[] } | null>;
  findIncompleteRecordingId(): Promise<string | null>;
  completeRecording(activityId: string, summary: SessionSummary): Promise<void>;
  discardRecording(activityId: string, at: number): Promise<void>;
}

export interface Clock {
  now(): number;
}

export interface CoordinatorDeps {
  bridge: TrackingBridge;
  store: RecordingStore;
  clock: Clock;
  newId: () => string;
  timezone: () => string;
  userId: () => string | null;
  /** Called after every state/metrics change; the UI renders from `snapshot()`. */
  onChange?: () => void;
  /** Non-fatal errors (e.g. a failed batch persist that will be retried). */
  onError?: (error: unknown) => void;
}

export type StartResult =
  | { ok: true; activityId: string }
  | { ok: false; reason: 'permission_denied' | 'no_active_session' | 'already_recording' };

// ============================================================================ coordinator

/**
 * Application service that connects the native tracker, the recording session and storage.
 *
 * Guarantees:
 * - one activity per recording (duplicate starts are rejected);
 * - every sample and control event is persisted, in order, before the native journal entry
 *   is acknowledged;
 * - incomplete recordings are recovered by deterministic replay plus a journal drain;
 * - operations are serialised so concurrent UI taps and native callbacks cannot interleave.
 */
export class RecordingCoordinator {
  private session: RecordingSession | null = null;
  private activityId: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private unsubscribe: (() => void) | null = null;
  private pending: { samples: SequencedSample[]; events: RecordedEvent[] } = {
    samples: [],
    events: [],
  };
  private acquisitionAccuracy: number | null = null;

  constructor(private readonly deps: CoordinatorDeps) {}

  /** Snapshot for the UI; null when idle. */
  snapshot(): LiveMetrics | null {
    return this.session?.snapshot(this.deps.clock.now()) ?? null;
  }
  /** Decimated live route for the map; empty when idle. */
  liveRoute(): Array<Array<{ latitude: number; longitude: number }>> {
    return this.session?.liveRoute() ?? [];
  }
  get currentActivityId(): string | null {
    return this.activityId;
  }
  get lastAcquisitionAccuracy(): number | null {
    return this.acquisitionAccuracy;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private ensureListener(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.bridge.addListener((activityId, entries) => {
      void this.serial(() => this.onEntries(activityId, entries)).catch((e) =>
        this.deps.onError?.(e),
      );
    });
  }

  /** Prepare a session: checks permission and starts acquisition (no activity is created yet). */
  prepare(
    sportType: SportType,
    options: SessionConfigOptions = {},
  ): Promise<StartResult | { ok: true; activityId: null }> {
    return this.serial(async () => {
      if (
        this.session &&
        this.session.state.status !== 'READY' &&
        this.session.state.status !== 'PERMISSION_DENIED' &&
        this.session.state.status !== 'ACQUIRING_GPS' &&
        this.session.state.status !== 'LOCATION_UNAVAILABLE'
      ) {
        return { ok: false, reason: 'already_recording' } as const;
      }
      const id = this.deps.newId();
      const session = new RecordingSession(sessionConfigFor(id, sportType, options));
      this.session = session;
      this.activityId = null;
      this.ensureListener();
      if (!session.requiresGps) {
        this.changed();
        return { ok: true, activityId: null } as const;
      }
      let auth = await this.deps.bridge.getAuthorization();
      if (auth === 'undetermined')
        auth = await this.deps.bridge.requestAuthorization('when_in_use');
      const now = this.deps.clock.now();
      if (auth === 'denied' || auth === 'restricted') {
        session.dispatch({ type: 'PERMISSION_DENIED' });
        this.changed();
        return { ok: false, reason: 'permission_denied' } as const;
      }
      session.dispatch({ type: 'START_REQUESTED', at: now, requiresGps: true });
      await this.deps.bridge.startAcquisition(session.config.legs[0]!.policy!);
      this.changed();
      return { ok: true, activityId: null } as const;
    });
  }

  /** Start recording. Creates exactly one activity record and begins journaling. */
  start(options: { title?: string; withoutFix?: boolean } = {}): Promise<StartResult> {
    return this.serial(async () => {
      const session = this.session;
      if (!session) return { ok: false, reason: 'no_active_session' } as const;
      if (this.activityId) return { ok: false, reason: 'already_recording' } as const;
      if (session.state.status === 'PERMISSION_DENIED')
        return { ok: false, reason: 'permission_denied' } as const;
      const at = this.deps.clock.now();
      const id = session.config.activityId;
      const timezone = this.deps.timezone();
      const leg = session.config.legs[0]!;
      await this.deps.store.createRecording({
        activity: {
          id,
          userId: this.deps.userId(),
          sportType: session.config.sportType,
          title: options.title ?? defaultTitle(session.config.sportType, at, timezone),
          startedAt: at,
          timezone,
          swimMode:
            session.config.sportType === 'swimming'
              ? leg.poolLengthMeters != null
                ? 'pool'
                : 'open_water'
              : null,
          poolLengthMeters: leg.poolLengthMeters,
        },
        config: session.config,
      });
      this.activityId = id;
      this.pending.events.push(...session.start(at, { withoutFix: options.withoutFix ?? true }));
      if (leg.policy) {
        await this.deps.bridge.startRecording(id, leg.policy);
        await this.deps.bridge.stopAcquisition();
      }
      await this.flush();
      return { ok: true, activityId: id } as const;
    });
  }

  pause(): Promise<void> {
    return this.command((s, at) => s.pause(at));
  }
  resume(): Promise<void> {
    return this.command((s, at) => s.resume(at));
  }
  lap(lengthCount?: number): Promise<void> {
    return this.command((s, at) => s.lap(at, lengthCount));
  }
  advanceLeg(): Promise<void> {
    return this.serial(async () => {
      const s = this.requireSession();
      await this.drain();
      this.pending.events.push(...s.advanceLeg(this.deps.clock.now()));
      await this.deps.bridge.updatePolicy(s.currentLeg.policy);
      await this.flush();
    });
  }

  private command(fn: (s: RecordingSession, at: number) => RecordedEvent[]): Promise<void> {
    return this.serial(async () => {
      const s = this.requireSession();
      // Persist everything native has captured so far so the event lands in the right order.
      await this.drain();
      this.pending.events.push(...fn(s, this.deps.clock.now()));
      await this.flush();
    });
  }

  /** Finish and save. Returns the summary that was persisted. */
  finish(): Promise<SessionSummary> {
    return this.serial(async () => {
      const s = this.requireSession();
      const id = this.activityId!;
      await this.drain();
      this.pending.events.push(...s.finish(this.deps.clock.now()));
      await this.flush();
      if (s.requiresGps || s.config.legs.some((l) => l.policy))
        await this.deps.bridge.stopRecording();
      const summary = s.summary();
      try {
        await this.deps.store.completeRecording(id, summary);
        s.markSaved();
      } catch (e) {
        s.markSaveFailed(e instanceof Error ? e.message : String(e));
        this.changed();
        throw e;
      }
      // Cleanup only: SQLite already holds everything, so a failure here loses nothing.
      await this.deps.bridge.deleteJournal?.(id).catch((err: unknown) => this.deps.onError?.(err));
      this.changed();
      return summary;
    });
  }

  /** Retry saving after a failure. Raw data is already persisted, so nothing is lost. */
  retrySave(): Promise<SessionSummary> {
    return this.serial(async () => {
      const s = this.requireSession();
      s.dispatch({ type: 'RETRY_SAVE' });
      const summary = s.summary();
      await this.deps.store.completeRecording(this.activityId!, summary);
      s.markSaved();
      await this.deps.bridge
        .deleteJournal?.(this.activityId!)
        .catch((err: unknown) => this.deps.onError?.(err));
      this.changed();
      return summary;
    });
  }

  /** Discard: an explicit user decision. Before start, simply stops acquisition. */
  discard(): Promise<void> {
    return this.serial(async () => {
      const s = this.session;
      if (!s) return;
      if (this.activityId) {
        await this.deps.bridge.stopRecording();
        await this.deps.store.discardRecording(this.activityId, this.deps.clock.now());
        await this.deps.bridge.deleteJournal?.(this.activityId);
      } else {
        await this.deps.bridge.stopAcquisition();
      }
      this.reset();
    });
  }

  /** Clear a SAVED session so a new one can be prepared. */
  close(): void {
    const status = this.session?.state.status;
    if (status === 'SAVED' || status === 'READY' || status === 'PERMISSION_DENIED') this.reset();
  }

  /**
   * Recover an incomplete recording after an app restart.
   * Replays persisted data, then drains any samples the native journal captured meanwhile.
   * If native is no longer recording, the session becomes INTERRUPTED at the last known data time.
   */
  recover(): Promise<
    { recovered: false } | { recovered: true; activityId: string; status: string }
  > {
    return this.serial(async () => {
      const id = await this.deps.store.findIncompleteRecordingId();
      if (!id) return { recovered: false } as const;
      const loaded = await this.deps.store.loadRecording(id);
      if (!loaded) return { recovered: false } as const;
      const session = replaySession(loaded.config, loaded.events, loaded.samples, {
        recovering: true,
      });
      if (session.state.status === 'RECOVERING') {
        // The app stopped between creating the record and persisting its start event:
        // no samples or events exist, so there is nothing to recover.
        await this.deps.store.discardRecording(id, this.deps.clock.now());
        return { recovered: false } as const;
      }
      this.session = session;
      this.activityId = id;
      this.ensureListener();
      await this.drain();
      const nativeId = await this.deps.bridge.getRecordingActivityId();
      if (nativeId !== id && session.state.status === 'RECORDING') {
        const lastSample = loaded.samples[loaded.samples.length - 1]?.recordedAt ?? 0;
        const lastEvent = loaded.events[loaded.events.length - 1]?.event.at ?? 0;
        this.pending.events.push(...session.interrupt(Math.max(lastSample, lastEvent)));
      }
      await this.flush();
      return { recovered: true, activityId: id, status: session.state.status } as const;
    });
  }

  /** Continue an INTERRUPTED recording (restarts native journaling for the same activity). */
  resumeInterrupted(): Promise<void> {
    return this.serial(async () => {
      const s = this.requireSession();
      const policy = s.currentLeg.policy;
      if (policy) await this.deps.bridge.startRecording(this.activityId!, policy);
      this.pending.events.push(...s.resume(this.deps.clock.now()));
      await this.flush();
    });
  }

  // ------------------------------------------------------------------ internals

  private requireSession(): RecordingSession {
    if (!this.session || !this.activityId) throw new Error('No recording in progress');
    return this.session;
  }

  private async onEntries(activityId: string | null, entries: JournalEntry[]): Promise<void> {
    const s = this.session;
    if (!s) return;
    if (activityId == null) {
      // Acquisition-only fix: update the GPS indicator; transition to RECORDING happens on start.
      const last = entries[entries.length - 1];
      if (last) {
        this.acquisitionAccuracy = last.sample.horizontalAccuracyMeters;
        s.ingestSample(last.sample, { detectAutoPause: false });
      }
      this.changed();
      return;
    }
    if (activityId !== this.activityId) return;
    await this.ingest(entries);
    await this.flush();
  }

  /** Ingest journal entries in sequence; re-reads the journal if a gap is detected. */
  private async ingest(entries: JournalEntry[]): Promise<void> {
    const s = this.session!;
    let expected = s.processedSampleCount;
    let list = entries;
    if (list.length > 0 && list[0]!.sequence > expected) {
      list = await this.deps.bridge.readJournal(this.activityId!, expected);
    }
    for (const e of list) {
      if (e.sequence < expected) continue; // already processed (duplicate delivery)
      if (e.sequence > expected)
        throw new Error(`Journal gap: expected ${expected}, got ${e.sequence}`);
      this.pending.samples.push({ sequenceNumber: e.sequence, sample: e.sample });
      this.pending.events.push(...s.ingestSample(e.sample));
      expected++;
    }
  }

  private async drain(): Promise<void> {
    if (!this.activityId || !this.session) return;
    const entries = await this.deps.bridge.readJournal(
      this.activityId,
      this.session.processedSampleCount,
    );
    await this.ingest(entries);
  }

  private async flush(): Promise<void> {
    const s = this.session;
    const id = this.activityId;
    if (!s || !id) return;
    const batch = this.pending;
    this.pending = { samples: [], events: [] };
    const snap = s.snapshot(this.deps.clock.now());
    try {
      await this.deps.store.appendRecording(id, {
        samples: batch.samples,
        events: batch.events,
        status: statusFor(s),
        metrics: {
          elapsedDurationMs: snap.elapsedMs,
          movingDurationMs: snap.movingMs,
          distanceMeters: snap.distanceMeters,
          elevationGainMeters: snap.elevationGainMeters,
          elevationLossMeters: 0,
          averageSpeedMps: snap.averageSpeedMps,
          maximumSpeedMps: snap.maximumSpeedMps,
          averagePaceMsPerKm: snap.averagePaceMsPerKm,
        },
      });
    } catch (e) {
      // Keep the batch for the next flush; the native journal still holds the samples.
      this.pending = {
        samples: [...batch.samples, ...this.pending.samples],
        events: [...batch.events, ...this.pending.events],
      };
      throw e;
    }
    const last = batch.samples[batch.samples.length - 1];
    if (last) await this.deps.bridge.acknowledge(id, last.sequenceNumber);
    this.changed();
  }

  private reset(): void {
    this.session = null;
    this.activityId = null;
    this.pending = { samples: [], events: [] };
    this.acquisitionAccuracy = null;
    this.changed();
  }

  private changed(): void {
    this.deps.onChange?.();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

function statusFor(s: RecordingSession): ActivityStatus {
  switch (s.state.status) {
    case 'PAUSED':
      return 'paused';
    case 'INTERRUPTED':
      return 'interrupted';
    default:
      return 'recording';
  }
}

const SPORT_TITLES: Record<SportType, string> = {
  running: 'Run',
  cycling: 'Ride',
  walking: 'Walk',
  hiking: 'Hike',
  swimming: 'Swim',
  triathlon: 'Triathlon',
};

/** e.g. "Morning Run" based on local hour. */
export function defaultTitle(sport: SportType, at: number, timeZone: string): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(
      new Date(at),
    ),
  );
  const part =
    hour < 5
      ? 'Night'
      : hour < 12
        ? 'Morning'
        : hour < 17
          ? 'Afternoon'
          : hour < 21
            ? 'Evening'
            : 'Night';
  return `${part} ${SPORT_TITLES[sport]}`;
}
