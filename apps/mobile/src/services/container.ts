import { RecordingCoordinator } from '@pace/activity-engine';
import { ActivityService, AnalyticsService, BackupService } from '@pace/core';
import {
  ActivityRepository,
  type DatabaseContext,
  GoalRepository,
  PersonalRecordRepository,
  RouteRepository,
  SettingsRepository,
  SqliteRecordingStore,
  SyncOutboxRepository,
  configureConnection,
  migrate,
} from '@pace/database';
import { uuidV4 } from '@pace/domain';
import Constants from 'expo-constants';
import { openDatabaseAsync } from 'expo-sqlite';
import { createNativeTrackingBridge } from 'pace-tracking';
import { createExpoSqliteDriver } from './expo-sqlite-driver';
import { reportError } from './monitoring';
import { EncryptedKeyValueStore } from './secure-storage';

export interface AppServices {
  ctx: DatabaseContext;
  activities: ActivityRepository;
  routes: RouteRepository;
  goals: GoalRepository;
  records: PersonalRecordRepository;
  settings: SettingsRepository;
  outbox: SyncOutboxRepository;
  activityService: ActivityService;
  analytics: AnalyticsService;
  backup: BackupService;
  coordinator: RecordingCoordinator;
  bridge: ReturnType<typeof createNativeTrackingBridge>;
  secureKv: EncryptedKeyValueStore;
  appVersion: string;
}

export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

let instance: Promise<AppServices> | null = null;
const listeners = new Set<() => void>();

/** Subscribe to recording changes (the coordinator's onChange). */
export function onRecordingChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

let currentUserId: string | null = null;
export function setCurrentUserId(id: string | null): void {
  currentUserId = id;
}

async function create(): Promise<AppServices> {
  const sqlite = await openDatabaseAsync('pace.db');
  const db = createExpoSqliteDriver(sqlite);
  await configureConnection(db);
  await migrate(db);
  const ctx: DatabaseContext = { db, now: Date.now, newId: () => uuidV4() };
  const bridge = createNativeTrackingBridge((message) =>
    reportError(new Error(message), { area: 'tracking' }),
  );
  const appVersion = Constants.expoConfig?.version ?? '0.0.0';
  const coordinator = new RecordingCoordinator({
    bridge,
    store: new SqliteRecordingStore(ctx),
    clock: { now: Date.now },
    newId: ctx.newId,
    timezone: deviceTimeZone,
    userId: () => currentUserId,
    onChange: () => listeners.forEach((l) => l()),
    onError: (e) => reportError(e, { area: 'recording' }),
  });
  return {
    ctx,
    activities: new ActivityRepository(ctx),
    routes: new RouteRepository(ctx),
    goals: new GoalRepository(ctx),
    records: new PersonalRecordRepository(ctx),
    settings: new SettingsRepository(ctx),
    outbox: new SyncOutboxRepository(ctx),
    activityService: new ActivityService(ctx),
    analytics: new AnalyticsService(ctx),
    backup: new BackupService(ctx, appVersion),
    coordinator,
    bridge,
    secureKv: new EncryptedKeyValueStore(db),
    appVersion,
  };
}

/** Opens and migrates the local database once; every feature shares this instance. */
export function getServices(): Promise<AppServices> {
  instance ??= create().catch((e: unknown) => {
    instance = null;
    throw e;
  });
  return instance;
}
