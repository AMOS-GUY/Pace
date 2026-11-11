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

export class FakeBridge implements TrackingBridge {
  authorization: LocationAuthorization = 'when_in_use';
  recordingId: string | null = null;
  journal = new Map<string, JournalEntry[]>();
  acknowledged = new Map<string, number>();
  policy: GpsPolicy | null = null;
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
  async startRecording(id: string, p: GpsPolicy): Promise<void> {
    this.recordingId = id;
    this.policy = p;
    if (!this.journal.has(id)) this.journal.set(id, []);
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
    return (this.journal.get(id) ?? []).filter((e) => e.sequence >= from);
  }
  async acknowledge(id: string, through: number): Promise<void> {
    this.acknowledged.set(id, through);
  }
  addListener(l: (id: string | null, e: JournalEntry[]) => void): () => void {
    this.listeners.push(l);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== l);
    };
  }

  /** Simulates native capturing samples: journal first, then notify JS. */
  emit(samples: LocationSample[], options: { notify?: boolean } = {}): void {
    const id = this.recordingId;
    if (!id) {
      for (const l of this.listeners)
        l(
          null,
          samples.map((s) => ({ sequence: -1, sample: s })),
        );
      return;
    }
    const j = this.journal.get(id)!;
    const base = j.length;
    const entries = samples.map((s, i) => ({ sequence: base + i, sample: s }));
    for (const e of entries) j.push(e);
    if (options.notify ?? true) for (const l of this.listeners) l(id, entries);
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
