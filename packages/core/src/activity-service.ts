import { type RecordedEvent, RecordingSession, sessionConfigFor } from '@pace/activity-engine';
import {
  type DatabaseContext,
  ROUTE_POINT_COLUMNS,
  ActivityRepository,
  RouteRepository,
  eventPayload,
  insertMany,
  sampleValues,
  writeCompletedActivity,
} from '@pace/database';
import type { Activity, LocationSample, SportType } from '@pace/domain';
import {
  type ParsedTrack,
  activitiesToCsv,
  parseFit,
  parseGpxTrack,
  parseTcx,
  plausibleTime,
  toGpx,
  trimPrivacyZone,
} from '@pace/formats';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

export class ImportError extends Error {
  constructor(
    message: string,
    readonly code: 'sport_required' | 'duplicate' | 'unsupported_sport' | 'invalid_file',
    /** For duplicates: the activity already in PACE. */
    readonly existingActivityId?: string,
  ) {
    super(message);
  }
}

export interface ImportResult {
  activityId: string;
  warnings: string[];
}

export type MultiImportResult = Array<
  { ok: true; result: ImportResult } | { ok: false; error: ImportError }
>;

export interface ImportOptions {
  /** Overrides the file's sport (or supplies it when the file has none). */
  sportType?: SportType;
  timezone: string;
  userId?: string | null;
}

/** T1, bike, T2 and run: the leg changes of a PACE triathlon. */
const TRIATHLON_LEG_CHANGES = 4;

/**
 * Share of the shorter time span two activities must overlap to be the same session (e.g. the
 * same run exported from two services, or a PACE export imported back).
 */
const DUPLICATE_OVERLAP = 0.5;

const SOURCE_FOR_FORMAT = {
  gpx: 'imported_gpx',
  tcx: 'imported_tcx',
  fit: 'imported_fit',
} as const;

/** Stable fingerprint of an imported track so the same file is never imported twice. */
export function importFingerprint(samples: readonly LocationSample[]): string {
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const key = `${first.recordedAt}|${first.latitude.toFixed(6)}|${first.longitude.toFixed(6)}|${last.recordedAt}|${samples.length}`;
  return `gpx:${bytesToHex(sha256(utf8ToBytes(key))).slice(0, 32)}`;
}

export class ActivityService {
  private readonly activities: ActivityRepository;
  private readonly routes: RouteRepository;

  constructor(private readonly ctx: DatabaseContext) {
    this.activities = new ActivityRepository(ctx);
    this.routes = new RouteRepository(ctx);
  }

  /**
   * Imports a GPX track as a completed activity. The track is processed by exactly the same
   * engine as live recordings (GPX segments become pause/resume), and the raw points,
   * events and session config are stored so it can be re-derived or restored later.
   */
  async importGpx(xml: string, options: ImportOptions): Promise<ImportResult> {
    let parsed: ParsedTrack;
    try {
      parsed = parseGpxTrack(xml);
    } catch (e) {
      throw new ImportError(e instanceof Error ? e.message : 'Invalid GPX', 'invalid_file');
    }
    return this.importTrack(parsed, options);
  }

  /**
   * Imports every activity in a TCX file. Each activity succeeds or fails on its own; the
   * result lists them in file order.
   */
  async importTcx(xml: string, options: ImportOptions): Promise<MultiImportResult> {
    let tracks: ParsedTrack[];
    try {
      tracks = parseTcx(xml);
    } catch (e) {
      throw new ImportError(e instanceof Error ? e.message : 'Invalid TCX', 'invalid_file');
    }
    return this.importTracks(tracks, options);
  }

  /**
   * Imports every activity in a FIT file (several when FIT files are chained). A damaged or
   * malformed file is refused as a whole before anything is stored.
   */
  async importFit(bytes: Uint8Array, options: ImportOptions): Promise<MultiImportResult> {
    let tracks: ParsedTrack[];
    try {
      tracks = parseFit(bytes);
    } catch (e) {
      throw new ImportError(e instanceof Error ? e.message : 'Invalid FIT', 'invalid_file');
    }
    return this.importTracks(tracks, options);
  }

  private async importTracks(
    tracks: ParsedTrack[],
    options: ImportOptions,
  ): Promise<MultiImportResult> {
    const out: MultiImportResult = [];
    for (const t of tracks) {
      try {
        out.push({ ok: true, result: await this.importTrack(t, options) });
      } catch (e) {
        if (!(e instanceof ImportError)) throw e;
        out.push({ ok: false, error: e });
      }
    }
    return out;
  }

  /**
   * Imports one parsed track (GPX, TCX or FIT) through the same session engine as live
   * recordings. Duplicates are refused by exact fingerprint and by time overlap with an existing
   * activity. Triathlons need the four leg start times only FIT multisport files provide.
   */
  async importTrack(parsed: ParsedTrack, options: ImportOptions): Promise<ImportResult> {
    const label = parsed.format.toUpperCase();
    const sport = options.sportType ?? parsed.sportType;
    if (!sport) throw new ImportError('Choose the sport for this activity', 'sport_required');
    const legStarts = sport === 'triathlon' ? (parsed.legStarts ?? []) : [];
    if (sport === 'triathlon' && legStarts.length !== TRIATHLON_LEG_CHANGES)
      throw new ImportError(
        `Triathlons cannot be imported from ${label} without their swim, transition, bike and run legs`,
        'unsupported_sport',
      );

    const all = parsed.segments.flat();
    // Parsers skip such times already; this guards any other source of a ParsedTrack, because
    // one time outside 2000–2100 would make every later backup unrestorable.
    if (
      all.some((s) => !plausibleTime(s.recordedAt)) ||
      parsed.sensors.some((s) => !plausibleTime(s.recordedAt))
    )
      throw new ImportError('The file contains times outside 2000–2100', 'invalid_file');
    const externalId = importFingerprint(all);
    const existing = await this.ctx.db.get<{ id: string }>(
      'SELECT id FROM activities WHERE external_id = ? AND deleted_at IS NULL',
      [externalId],
    );
    if (existing)
      throw new ImportError('This activity has already been imported', 'duplicate', existing.id);
    const overlap = await this.overlappingActivity(
      all[0]!.recordedAt,
      all[all.length - 1]!.recordedAt,
    );
    if (overlap)
      throw new ImportError(
        `This overlaps “${overlap.title}” already in PACE (${new Date(overlap.started_at).toISOString().slice(0, 16).replace('T', ' ')} UTC)`,
        'duplicate',
        overlap.id,
      );

    const id = this.ctx.newId();
    const config = sessionConfigFor(id, sport, {
      autoPauseEnabled: false,
      ...(sport === 'swimming' ? { swimMode: 'open_water' as const } : {}),
    });
    const session = new RecordingSession(config);
    const events: RecordedEvent[] = [];
    const first = all[0]!;
    events.push(...session.start(first.recordedAt, { withoutFix: true }));
    // Lap boundaries from the file become lap events at their time, so lap figures are computed
    // by the engine from the track exactly as for a lap pressed during a live recording.
    // Leg changes become leg events the same way; a leg change and a lap at the same moment
    // apply the leg change first, so the lap belongs to the new leg.
    const laps = [...parsed.lapStarts];
    const legs = [...legStarts];
    const flushLaps = (until: number): void => {
      for (;;) {
        const leg = legs[0];
        const lap = laps[0];
        if (leg != null && leg <= until && (lap == null || leg <= lap))
          events.push(...session.advanceLeg(legs.shift()!));
        else if (lap != null && lap <= until) events.push(...session.lap(laps.shift()!));
        else break;
      }
    };
    parsed.segments.forEach((seg, i) => {
      if (i > 0) {
        events.push(
          ...session.pause(parsed.segments[i - 1]![parsed.segments[i - 1]!.length - 1]!.recordedAt),
        );
        flushLaps(seg[0]!.recordedAt - 1);
        events.push(...session.resume(seg[0]!.recordedAt));
      }
      for (const s of seg) {
        flushLaps(s.recordedAt);
        events.push(...session.ingestSample(s, { detectAutoPause: false }));
      }
    });
    const warnings = [...parsed.warnings];
    if (laps.length > 0)
      warnings.push(`${laps.length} lap(s) starting after the last GPS point were not imported.`);
    if (legs.length > 0)
      throw new ImportError(
        'The triathlon has legs without any GPS data after them; it cannot be imported',
        'invalid_file',
      );
    events.push(...session.finish(all[all.length - 1]!.recordedAt));
    const summary = session.summary();
    const now = this.ctx.now();

    await this.ctx.db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO activities (id, user_id, sport_type, title, description, started_at, ended_at, timezone, status, source,
           swim_mode, pool_length_meters, session_config, external_id, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'recording', ?, ?, NULL, ?, ?, ?, ?, 1)`,
        [
          id,
          options.userId ?? null,
          sport,
          parsed.name ?? 'Imported activity',
          parsed.description,
          summary.startedAt,
          null,
          options.timezone,
          SOURCE_FOR_FORMAT[parsed.format],
          sport === 'swimming' ? 'open_water' : null,
          JSON.stringify(config),
          externalId,
          now,
          now,
        ],
      );
      await insertMany(
        tx,
        'route_points',
        ROUTE_POINT_COLUMNS,
        all.map((s, i) => sampleValues(id, i, s)),
      );
      await insertMany(
        tx,
        'recording_events',
        [
          'activity_id',
          'sequence_number',
          'event_type',
          'occurred_at',
          'after_sample_count',
          'payload',
        ],
        events.map((e, i) => [
          id,
          i,
          e.event.type,
          e.event.at,
          e.afterSampleCount,
          eventPayload(e.event),
        ]),
      );
      await insertMany(
        tx,
        'sensor_samples',
        ['id', 'activity_id', 'sensor_type', 'value', 'unit', 'recorded_at', 'source_device_id'],
        parsed.sensors.map((x) => [
          this.ctx.newId(),
          id,
          x.type,
          x.value,
          x.unit,
          x.recordedAt,
          null,
        ]),
      );
      await writeCompletedActivity(tx, this.ctx, id, sport, summary);
    });
    return { activityId: id, warnings };
  }

  /** A completed activity sharing at least half of the shorter time span with [start, end]. */
  private async overlappingActivity(
    start: number,
    end: number,
  ): Promise<{ id: string; title: string; started_at: number } | null> {
    const candidates = await this.ctx.db.all<{
      id: string;
      title: string;
      started_at: number;
      ended_at: number;
    }>(
      `SELECT id, title, started_at, ended_at FROM activities
       WHERE deleted_at IS NULL AND status = 'completed' AND ended_at IS NOT NULL
         AND started_at < ? AND ended_at > ?
       ORDER BY started_at`,
      [end, start],
    );
    for (const c of candidates) {
      const shared = Math.min(end, c.ended_at) - Math.max(start, c.started_at);
      const shorter = Math.min(end - start, c.ended_at - c.started_at);
      if (shorter > 0 && shared >= DUPLICATE_OVERLAP * shorter) return c;
    }
    return null;
  }

  /** GPX 1.1 export of the raw samples, split by recording segment, with optional privacy trim. */
  async exportGpx(
    activityId: string,
    options: { privacyZoneMeters?: number } = {},
  ): Promise<{ fileName: string; content: string }> {
    const a = await this.activities.getById(activityId);
    if (!a || a.deletedAt != null) throw new Error('Activity not found');
    const samples = await this.routes.allRaw(activityId);
    const segments = await this.rawSegments(activityId, samples);
    const series = async (type: 'heart_rate' | 'cadence' | 'power') =>
      this.ctx.db.all<{ recorded_at: number; value: number }>(
        'SELECT recorded_at, value FROM sensor_samples WHERE activity_id = ? AND sensor_type = ? ORDER BY recorded_at',
        [activityId, type],
      );
    const hr = await series('heart_rate');
    const cadence = await series('cadence');
    const power = await series('power');
    const trimmed = trimPrivacyZone(segments, options.privacyZoneMeters ?? 0);
    const content = toGpx({
      name: a.title,
      description: a.description,
      sportType: a.sportType,
      startedAt: a.startedAt,
      segments: trimmed,
      heartRate: hr.map((h) => ({ recordedAt: h.recorded_at, bpm: h.value })),
      cadence: cadence.map((c) => ({ recordedAt: c.recorded_at, rpm: c.value })),
      power: power.map((p) => ({ recordedAt: p.recorded_at, watts: p.value })),
    });
    const date = new Date(a.startedAt).toISOString().slice(0, 10);
    const safe =
      a.title
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40) || 'activity';
    return { fileName: `${date}-${safe}.gpx`, content };
  }

  /**
   * Splits raw samples at pause/resume boundaries from the recording events so exported tracks
   * show the same breaks as the app. Samples captured while paused are exported in their own
   * segments only if they fall inside a recording interval.
   */
  private async rawSegments(
    activityId: string,
    samples: LocationSample[],
  ): Promise<LocationSample[][]> {
    const events = await this.ctx.db.all<{ event_type: string; occurred_at: number }>(
      'SELECT event_type, occurred_at FROM recording_events WHERE activity_id = ? ORDER BY sequence_number',
      [activityId],
    );
    const intervals: Array<[number, number]> = [];
    let open: number | null = null;
    for (const e of events) {
      if ((e.event_type === 'started' || e.event_type === 'resumed') && open == null)
        open = e.occurred_at;
      if (
        (e.event_type === 'paused' ||
          e.event_type === 'interrupted' ||
          e.event_type === 'finished') &&
        open != null
      ) {
        intervals.push([open, e.occurred_at]);
        open = null;
      }
    }
    if (open != null) intervals.push([open, Infinity]);
    if (intervals.length === 0) return samples.length ? [samples] : [];
    return intervals
      .map(([s, e]) => samples.filter((p) => p.recordedAt >= s && p.recordedAt <= e))
      .filter((seg) => seg.length > 0);
  }

  async exportCsv(): Promise<{ fileName: string; content: string }> {
    const all: Activity[] = await this.activities.allCompleted();
    return { fileName: 'pace-activities.csv', content: activitiesToCsv(all) };
  }
}
