/** TEST DOUBLES ONLY — in-memory bridge and store used to exercise the coordinator. */
import type { LocationSample } from '@pace/domain';
import type { GpsPolicy } from '@pace/gps-engine';
import type {
  JournalEntry,
  LocationAuthorization,
  NewRecording,
  RecordingBatch,
  RecordingStore,
  TrackingBridge,
} from '../coordinator';
import type { RecordedEvent, SessionConfig, SessionSummary } from '../recording-session';

/**
 * Mirrors the Swift recorder contract (modules/pace-tracking): a per-activity journal with a
 * persisted sequence high-water mark, journal-before-notify, `nextSequence` on start, and
 * compaction that never restarts numbering. Extra hooks simulate faults.
 */
export class FakeBridge implements TrackingBridge {
  authorization: LocationAuthorization = 'when_in_use';
  recordingId: string | null = null;
  /** Retained (unacknowledged or not yet compacted) entries per activity. */
  journal = new Map<string, JournalEntry[]>();
  /** Next sequence number per activity (survives compaction, like the Swift `ackThrough`). */
  nextSequence = new Map<string, number>();
  acknowledged = new Map<string, number>();
  deletedJournals: string[] = [];
  policy: GpsPolicy | null = null;
  failNextStartRecording = false;
  failReads = false;
  private listeners: Array<(id: string | null, e: JournalEntry[]) => void> = [];

  async getAuthorization(): Promise<LocationAuthorization> {
    return this.authorization;
  }
  async requestAuthorization(): Promise<LocationAuthorization> {
    return this.authorization;
  }
  async startAcquisition(p: GpsPolicy): Promise<void> {
    this.policy = p;
  }
  async startRecording(id: string, p: GpsPolicy, nextSequence: number): Promise<void> {
    if (this.failNextStartRecording) {
      this.failNextStartRecording = false;
      throw new Error('Could not open journal');
    }
    if (this.recordingId === id) return;
    this.recordingId = id;
    this.policy = p;
    if (!this.journal.has(id)) this.journal.set(id, []);
    this.nextSequence.set(id, Math.max(this.nextSequence.get(id) ?? 0, nextSequence));
  }
  async updatePolicy(p: GpsPolicy | null): Promise<void> {
    this.policy = p;
  }
  async stopRecording(): Promise<void> {
    this.recordingId = null;
  }
  async stopAcquisition(): Promise<void> {}
  async getRecordingActivityId(): Promise<string | null> {
    return this.recordingId;
  }
  async readJournal(id: string, from: number): Promise<JournalEntry[]> {
    if (this.failReads) throw new Error('native module unavailable');
    return (this.journal.get(id) ?? []).filter((e) => e.sequence >= from);
  }
  async acknowledge(id: string, through: number): Promise<void> {
    this.acknowledged.set(id, through);
    // Compaction: acknowledged entries may be dropped; numbering continues regardless.
    this.journal.set(
      id,
      (this.journal.get(id) ?? []).filter((e) => e.sequence > through),
    );
  }
  async deleteJournal(id: string): Promise<void> {
    if (id === this.recordingId) return;
    this.journal.delete(id);
    this.deletedJournals.push(id);
  }
  addListener(l: (id: string | null, e: JournalEntry[]) => void): () => void {
    this.listeners.push(l);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== l);
    };
  }

  /** Simulates native capturing samples: journal first, then notify JS. */
  emit(samples: LocationSample[], options: { notify?: boolean } = {}): JournalEntry[] {
    const id = this.recordingId;
    if (!id) {
      this.emitAcquisition(samples);
      return [];
    }
    const j = this.journal.get(id)!;
    const base = this.nextSequence.get(id) ?? 0;
    const entries = samples.map((s, i) => ({ sequence: base + i, sample: s }));
    this.nextSequence.set(id, base + entries.length);
    for (const e of entries) j.push(e);
    if (options.notify ?? true) this.deliver(id, entries);
    return entries;
  }

  /** Acquisition-only fixes (not journaled), as native sends before recording starts. */
  emitAcquisition(samples: LocationSample[]): void {
    for (const l of this.listeners)
      l(
        null,
        samples.map((s) => ({ sequence: -1, sample: s })),
      );
  }

  /** Raw event delivery, for duplicate / out-of-order / late-delivery scenarios. */
  deliver(id: string | null, entries: JournalEntry[]): void {
    for (const l of this.listeners) l(id, entries);
  }

  /** Simulates the journal file disappearing (e.g. storage failure): numbering restarts at 0. */
  loseJournal(id: string): void {
    this.journal.delete(id);
    this.nextSequence.delete(id);
  }
}

interface StoredRecording {
  input: NewRecording;
  samples: Array<{ sequenceNumber: number; sample: LocationSample }>;
  events: RecordedEvent[];
  status: string;
  summary: SessionSummary | null;
  discardedAt: number | null;
}

export class MemoryStore implements RecordingStore {
  readonly recordings = new Map<string, StoredRecording>();
  failNextAppend = false;
  failNextComplete = false;

  async createRecording(input: NewRecording): Promise<void> {
    if (this.recordings.has(input.activity.id)) throw new Error('duplicate activity');
    this.recordings.set(input.activity.id, {
      input,
      samples: [],
      events: [],
      status: 'recording',
      summary: null,
      discardedAt: null,
    });
  }
  async appendRecording(id: string, batch: RecordingBatch): Promise<void> {
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new Error('disk full');
    }
    const r = this.recordings.get(id)!;
    for (const s of batch.samples) {
      if (s.sequenceNumber !== r.samples.length)
        throw new Error(`sequence ${s.sequenceNumber} != ${r.samples.length}`);
      r.samples.push(s);
    }
    r.events.push(...batch.events);
    r.status = batch.status;
  }
  async loadRecording(
    id: string,
  ): Promise<{ config: SessionConfig; samples: LocationSample[]; events: RecordedEvent[] } | null> {
    const r = this.recordings.get(id);
    if (!r) return null;
    return {
      config: r.input.config,
      samples: r.samples.map((s) => s.sample),
      events: [...r.events],
    };
  }
  async findIncompleteRecordingId(): Promise<string | null> {
    for (const [id, r] of this.recordings) if (!r.summary && r.discardedAt == null) return id;
    return null;
  }
  async completeRecording(id: string, summary: SessionSummary): Promise<void> {
    if (this.failNextComplete) {
      this.failNextComplete = false;
      throw new Error('write failed');
    }
    const r = this.recordings.get(id)!;
    r.summary = summary;
    r.status = 'completed';
  }
  async discardRecording(id: string, at: number): Promise<void> {
    const r = this.recordings.get(id)!;
    r.discardedAt = at;
    r.samples = [];
  }
}
