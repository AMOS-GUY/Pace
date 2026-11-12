import {
  ActivityRepository,
  type DatabaseContext,
  GoalRepository,
  PersonalRecordRepository,
  RouteRepository,
  SettingsRepository,
} from '@pace/database';
import type { Activity, Lap, Split } from '@pace/domain';
import { activitiesToCsv, lapsToCsv, personalRecordsToCsv, splitsToCsv } from '@pace/formats';
import { Zip, ZipDeflate, strToU8 } from 'fflate';
import { ActivityService } from './activity-service';

/**
 * Portable export: one ZIP the athlete can open anywhere, independent of the encrypted backup
 * (which stays the way to restore PACE itself).
 *
 *   README.txt                 what each file contains, units, privacy zone used
 *   data.json                  every activity with all metadata, laps, splits, triathlon legs and
 *                              heart-rate/cadence/power series; goals; records; profile and
 *                              preferences
 *   activities.csv / laps.csv / splits.csv / personal_records.csv
 *   activities/*.gpx           one GPX per activity with a GPS track (raw points, segments,
 *                              heart rate, cadence)
 *
 * Privacy and security:
 * - Coordinates appear ONLY in the GPX files, and every one is trimmed with the same
 *   privacy-zone function and radius. data.json and the CSVs contain no coordinates or bounds.
 * - Only allow-listed settings are exported (`profile`, `preferences`). Credentials and keys
 *   live in the Keychain, which this service cannot reach; account and sync identifiers,
 *   devices, the sync queue and import fingerprints are not exported.
 */

export const EXPORTED_SETTINGS = ['profile', 'preferences'] as const;

export interface ExportSink {
  write(chunk: Uint8Array): Promise<void>;
}

export interface PortableExportOptions {
  privacyZoneMeters: number;
  appVersion: string;
  /** Called after each activity: (done, total). */
  onProgress?: (done: number, total: number) => void | Promise<void>;
}

export interface PortableExportSummary {
  fileName: string;
  activities: number;
  gpxFiles: number;
  /** Activities without a GPS track (pool swims, failed GPS): present in JSON/CSV only. */
  withoutTrack: number;
  bytes: number;
}

type SensorType = 'heart_rate' | 'cadence' | 'power';

const FORMAT = 'pace-portable-export';
export const PORTABLE_EXPORT_VERSION = 1;

/** File name of an activity's GPX inside the export: date, title and a short id. */
export function exportGpxName(a: Pick<Activity, 'id' | 'startedAt' | 'title'>): string {
  const date = new Date(a.startedAt).toISOString().slice(0, 10);
  const slug =
    a.title
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'activity';
  return `activities/${date}-${slug}-${a.id.slice(0, 8)}.gpx`;
}

export class PortableExportService {
  private readonly activities: ActivityRepository;
  private readonly routes: RouteRepository;
  private readonly service: ActivityService;

  constructor(private readonly ctx: DatabaseContext) {
    this.activities = new ActivityRepository(ctx);
    this.routes = new RouteRepository(ctx);
    this.service = new ActivityService(ctx);
  }

  async export(sink: ExportSink, options: PortableExportOptions): Promise<PortableExportSummary> {
    const exportedAt = this.ctx.now();
    const queue: Uint8Array[] = [];
    let failure: Error | null = null;
    let bytes = 0;
    const zip = new Zip((err, chunk) => {
      if (err) failure = err;
      else queue.push(chunk);
    });
    const flush = async (): Promise<void> => {
      if (failure) throw failure;
      while (queue.length) {
        const c = queue.shift()!;
        bytes += c.length;
        await sink.write(c);
      }
    };
    const add = async (name: string, content: string): Promise<void> => {
      const f = new ZipDeflate(name, { level: 6 });
      zip.add(f);
      f.push(strToU8(content), true);
      await flush();
    };

    const all = await this.activities.allCompleted();
    const zone = Math.max(0, options.privacyZoneMeters);
    const lapRows: Lap[] = [];
    const splitRows: Array<Split & { activityId: string }> = [];
    const exported: unknown[] = [];
    let gpxFiles = 0;

    for (const [i, a] of all.entries()) {
      const [laps, splits, legs, sensors, hasSamples] = await Promise.all([
        this.activities.laps(a.id),
        this.activities.splits(a.id),
        this.activities.segments(a.id),
        this.sensorSeries(a.id),
        this.routes.allRaw(a.id).then((s) => s.length > 1),
      ]);
      lapRows.push(...laps);
      splitRows.push(...splits.map((s) => ({ ...s, activityId: a.id })));
      let gpxFile: string | null = null;
      if (hasSamples) {
        const { content } = await this.service.exportGpx(a.id, { privacyZoneMeters: zone });
        // A track entirely inside the privacy zone leaves nothing to export.
        if (content.includes('<trkpt')) {
          gpxFile = exportGpxName(a);
          await add(gpxFile, content);
          gpxFiles++;
        }
      }
      exported.push({
        id: a.id,
        sportType: a.sportType,
        title: a.title,
        description: a.description,
        startedAt: new Date(a.startedAt).toISOString(),
        endedAt: a.endedAt != null ? new Date(a.endedAt).toISOString() : null,
        timezone: a.timezone,
        source: a.source,
        swimMode: a.swimMode,
        poolLengthMeters: a.poolLengthMeters,
        elapsedDurationMs: a.elapsedDurationMs,
        movingDurationMs: a.movingDurationMs,
        distanceMeters: a.distanceMeters,
        elevationGainMeters: a.elevationGainMeters,
        elevationLossMeters: a.elevationLossMeters,
        averageSpeedMps: a.averageSpeedMps,
        maximumSpeedMps: a.maximumSpeedMps,
        averagePaceMsPerKm: a.averagePaceMsPerKm,
        createdAt: new Date(a.createdAt).toISOString(),
        updatedAt: new Date(a.updatedAt).toISOString(),
        gpxFile,
        laps: laps.map((l) => ({
          number: l.sequenceNumber + 1,
          startedAt: new Date(l.startedAt).toISOString(),
          durationMs: l.durationMs,
          distanceMeters: l.distanceMeters,
          averagePaceMsPerKm: l.averagePaceMsPerKm,
          averageSpeedMps: l.averageSpeedMps,
          poolLengthCount: l.lengthCount,
        })),
        splits: splits.map((s) => ({
          number: s.index + 1,
          distanceMeters: s.distanceMeters,
          movingDurationMs: s.movingDurationMs,
          paceMsPerKm: s.paceMsPerKm,
          speedMps: s.speedMps,
          elevationGainMeters: s.elevationGainMeters,
          isPartial: s.isPartial,
        })),
        legs: legs.map((g) => ({
          type: g.segmentType,
          startedAt: new Date(g.startedAt).toISOString(),
          endedAt: g.endedAt != null ? new Date(g.endedAt).toISOString() : null,
          elapsedDurationMs: g.elapsedDurationMs,
          movingDurationMs: g.movingDurationMs,
          distanceMeters: g.distanceMeters,
          elevationGainMeters: g.elevationGainMeters,
        })),
        sensors,
      });
      await options.onProgress?.(i + 1, all.length);
    }

    const settings = new SettingsRepository(this.ctx);
    const exportedSettings: Record<string, unknown> = {};
    for (const key of EXPORTED_SETTINGS) {
      const v = await settings.get<unknown>(key);
      if (v != null) exportedSettings[key] = v;
    }
    const records = await new PersonalRecordRepository(this.ctx).list();
    const goals = (await new GoalRepository(this.ctx).list()).filter((g) => g.deletedAt == null);

    await add('activities.csv', activitiesToCsv(all));
    await add('laps.csv', lapsToCsv(lapRows));
    await add('splits.csv', splitsToCsv(splitRows));
    await add('personal_records.csv', personalRecordsToCsv(records));
    await add(
      'data.json',
      JSON.stringify(
        {
          format: FORMAT,
          version: PORTABLE_EXPORT_VERSION,
          exportedAt: new Date(exportedAt).toISOString(),
          appVersion: options.appVersion,
          privacyZoneMeters: zone,
          units: {
            distance: 'metres',
            duration: 'milliseconds',
            speed: 'metres per second',
            pace: 'milliseconds per kilometre',
            elevation: 'metres',
            timestamps: 'ISO 8601 UTC; sensor samples use [epoch milliseconds UTC, value]',
          },
          ...exportedSettings,
          goals: goals.map((g) => ({
            sportType: g.sportType,
            goalType: g.goalType,
            targetValue: g.targetValue,
            period: g.period,
            startDate: g.startDate,
            endDate: g.endDate,
          })),
          personalRecords: records.map((r) => ({
            sportType: r.sportType,
            metric: r.metricType,
            value: r.value,
            unit: r.unit,
            basis: r.basis,
            activityId: r.activityId,
            achievedAt: new Date(r.achievedAt).toISOString(),
          })),
          activities: exported,
        },
        null,
        2,
      ),
    );
    await add('README.txt', readme(exportedAt, options.appVersion, zone, all.length, gpxFiles));
    zip.end();
    await flush();
    return {
      fileName: `pace-export-${new Date(exportedAt).toISOString().slice(0, 10)}.zip`,
      activities: all.length,
      gpxFiles,
      withoutTrack: all.length - gpxFiles,
      bytes,
    };
  }

  private async sensorSeries(
    activityId: string,
  ): Promise<Partial<Record<SensorType, { unit: string; samples: Array<[number, number]> }>>> {
    const rows = await this.ctx.db.all<{
      sensor_type: SensorType;
      unit: string;
      recorded_at: number;
      value: number;
    }>(
      'SELECT sensor_type, unit, recorded_at, value FROM sensor_samples WHERE activity_id = ? ORDER BY sensor_type, recorded_at',
      [activityId],
    );
    const out: Partial<Record<SensorType, { unit: string; samples: Array<[number, number]> }>> = {};
    for (const r of rows) {
      const s = (out[r.sensor_type] ??= { unit: r.unit, samples: [] });
      s.samples.push([r.recorded_at, r.value]);
    }
    return out;
  }
}

function readme(
  exportedAt: number,
  appVersion: string,
  zone: number,
  activities: number,
  gpx: number,
): string {
  return [
    'PACE — your training data',
    '=========================',
    '',
    `Exported ${new Date(exportedAt).toISOString()} from PACE ${appVersion}.`,
    `${activities} completed activities; ${gpx} with a GPS track as GPX.`,
    '',
    'Files',
    '-----',
    'data.json             Everything in one readable file: every activity with all summary',
    '                      figures, laps, splits, triathlon legs and heart-rate, cadence and power',
    '                      samples; your goals, personal records, profile and preferences.',
    'activities.csv        One row per activity (open in any spreadsheet).',
    'laps.csv, splits.csv  Laps and distance splits, linked by activity_id.',
    'personal_records.csv  Your best efforts.',
    'activities/*.gpx      GPS tracks (GPX 1.1) for Strava, Garmin Connect, Komoot and others.',
    '',
    'Units',
    '-----',
    'Distances and elevation in metres, durations in milliseconds, speed in metres per second,',
    'pace in milliseconds per kilometre, times in UTC (each activity also lists its time zone).',
    'Cadence is per minute as GPX/TCX define it (revolutions, or strides of one leg when running);',
    'power in watts; heart rate in beats per minute.',
    '',
    'Privacy',
    '-------',
    zone > 0
      ? `GPS tracks were trimmed by ${zone} m at the start and the end to hide places such as home.`
      : 'No privacy zone was applied: GPS tracks are complete.',
    'Coordinates appear only in the GPX files. Summary figures describe the full activity.',
    '',
    'GPX contains GPS points only. Laps, splits, power and pool swims are in data.json and the',
    'CSV files. When a GPX file is imported again, pauses and the finish are placed at the',
    'nearest GPS point, so moving time can differ by about a second per pause.',
    'No passwords, keys or sign-in tokens are included.',
    '',
    'Restoring PACE on a new phone uses the encrypted backup (Settings > Backup), not this file.',
    'The GPX files in this archive can be imported into PACE or any other app.',
    '',
  ].join('\n');
}
