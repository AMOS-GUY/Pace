import { type RecordedEvent, RecordingSession, sessionConfigFor } from '@pace/activity-engine';
import {
  type DatabaseContext,
  ROUTE_POINT_COLUMNS,
  ActivityRepository,
  RouteRepository,
  insertMany,
  sampleValues,
  writeCompletedActivity,
} from '@pace/database';
import type { Activity, LocationSample, SportType } from '@pace/domain';
import { activitiesToCsv, parseGpx, toGpx, trimPrivacyZone } from '@pace/formats';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

export class ImportError extends Error {
  constructor(
    message: string,
    readonly code: 'sport_required' | 'duplicate' | 'unsupported_sport' | 'invalid_file',
  ) {
    super(message);
  }
}

export interface ImportResult {
  activityId: string;
  warnings: string[];
}

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
  async importGpx(
    xml: string,
    options: { sportType?: SportType; timezone: string; userId?: string | null },
  ): Promise<ImportResult> {
    let parsed;
    try {
      parsed = parseGpx(xml);
    } catch (e) {
      throw new ImportError(e instanceof Error ? e.message : 'Invalid GPX', 'invalid_file');
    }
    const sport = options.sportType ?? parsed.sportType;
    if (!sport) throw new ImportError('Choose the sport for this activity', 'sport_required');
    if (sport === 'triathlon')
      throw new ImportError('Triathlons cannot be imported from GPX', 'unsupported_sport');

    const all = parsed.segments.flat();
    const externalId = importFingerprint(all);
    const existing = await this.ctx.db.get<{ id: string }>(
      'SELECT id FROM activities WHERE external_id = ? AND deleted_at IS NULL',
      [externalId],
    );
    if (existing) throw new ImportError('This activity has already been imported', 'duplicate');

    const id = this.ctx.newId();
    const config = sessionConfigFor(id, sport, {
      autoPauseEnabled: false,
      ...(sport === 'swimming' ? { swimMode: 'open_water' as const } : {}),
    });
    const session = new RecordingSession(config);
    const events: RecordedEvent[] = [];
    const first = all[0]!;
    events.push(...session.start(first.recordedAt, { withoutFix: true }));
    parsed.segments.forEach((seg, i) => {
      if (i > 0) {
        events.push(
          ...session.pause(parsed.segments[i - 1]![parsed.segments[i - 1]!.length - 1]!.recordedAt),
        );
        events.push(...session.resume(seg[0]!.recordedAt));
      }
      for (const s of seg) events.push(...session.ingestSample(s, { detectAutoPause: false }));
    });
    events.push(...session.finish(all[all.length - 1]!.recordedAt));
    const summary = session.summary();
    const now = this.ctx.now();

    await this.ctx.db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO activities (id, user_id, sport_type, title, description, started_at, ended_at, timezone, status, source,
           swim_mode, pool_length_meters, session_config, external_id, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'recording', 'imported_gpx', ?, NULL, ?, ?, ?, ?, 1)`,
        [
          id,
          options.userId ?? null,
          sport,
          parsed.name ?? 'Imported activity',
          parsed.description,
          summary.startedAt,
          null,
          options.timezone,
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
        events.map((e, i) => [id, i, e.event.type, e.event.at, e.afterSampleCount, null]),
      );
      await insertMany(
        tx,
        'sensor_samples',
        ['id', 'activity_id', 'sensor_type', 'value', 'unit', 'recorded_at', 'source_device_id'],
        parsed.heartRate.map((h) => [
          this.ctx.newId(),
          id,
          'heart_rate',
          h.bpm,
          'bpm',
          h.recordedAt,
          null,
        ]),
      );
      await writeCompletedActivity(tx, this.ctx, id, sport, summary);
    });
    return { activityId: id, warnings: parsed.warnings };
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
    const hr = await this.ctx.db.all<{ recorded_at: number; value: number }>(
      "SELECT recorded_at, value FROM sensor_samples WHERE activity_id = ? AND sensor_type = 'heart_rate' ORDER BY recorded_at",
      [activityId],
    );
    const trimmed = trimPrivacyZone(segments, options.privacyZoneMeters ?? 0);
    const content = toGpx({
      name: a.title,
      description: a.description,
      sportType: a.sportType,
      startedAt: a.startedAt,
      segments: trimmed,
      heartRate: hr.map((h) => ({ recordedAt: h.recorded_at, bpm: h.value })),
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
