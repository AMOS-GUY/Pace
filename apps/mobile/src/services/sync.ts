import { enqueueOutbox } from '@pace/database';
import type { Activity } from '@pace/domain';
import {
  type PushResult,
  type SyncableActivity,
  SyncEngine,
  type SyncReport,
  resolveActivityConflict,
} from '@pace/sync';
import { AppState } from 'react-native';
import { ApiError, api, isApiConfigured } from './api';
import { type AppServices, getServices } from './container';
import { reportError } from './monitoring';

function toPayload(a: Activity): Omit<Activity, 'userId'> {
  const { userId: _ignored, ...rest } = a;
  return rest;
}

function createEngine(s: AppServices): SyncEngine {
  return new SyncEngine(
    s.outbox,
    {
      async load(type, id) {
        if (type !== 'activity') return null;
        const a = await s.activities.getById(id);
        return a && a.status === 'completed' ? toPayload(a) : null;
      },
      routeSamples: (id, after, limit) => s.routes.rawPage(id, after, limit),
      async applyResolved(type, id, merged) {
        if (type !== 'activity') return;
        const m = merged as SyncableActivity;
        await s.ctx.db.transaction(async (tx) => {
          await tx.run(
            'UPDATE activities SET title = ?, description = ?, version = ?, updated_at = ?, deleted_at = ? WHERE id = ?',
            [m.title, m.description, m.version, m.updatedAt, m.deletedAt, id],
          );
          await enqueueOutbox(tx, s.ctx.now(), {
            entityType: 'activity',
            entityId: id,
            operation: m.deletedAt ? 'delete' : 'upsert',
            entityVersion: m.version,
          });
        });
      },
    },
    {
      async push(item, payload): Promise<PushResult> {
        try {
          if (item.operation === 'delete') {
            await api(`/activities/${item.entityId}?version=${item.entityVersion}`, {
              method: 'DELETE',
            });
            return { status: 'applied' };
          }
          const r = await api<{ status: 'applied' | 'duplicate' }>('/activities/sync', {
            method: 'POST',
            body: { activity: payload },
            idempotencyKey: item.idempotencyKey,
          });
          return { status: r.status };
        } catch (e) {
          if (e instanceof ApiError && e.status === 409 && e.code === 'version_conflict') {
            const server = e.body?.server;
            if (server)
              return {
                status: 'conflict',
                serverVersion: (server as SyncableActivity).version,
                serverEntity: server,
              };
          }
          if (
            e instanceof ApiError &&
            e.status >= 400 &&
            e.status < 500 &&
            e.status !== 401 &&
            e.status !== 429
          ) {
            return { status: 'rejected', reason: `${e.status} ${e.code ?? e.message}` };
          }
          throw e;
        }
      },
      async pushRouteBatch(activityId, firstSequence, samples) {
        await api(`/activities/${activityId}/route-batches`, {
          method: 'POST',
          body: { firstSequence, samples },
        });
      },
    },
    (type, local, server) =>
      type === 'activity'
        ? resolveActivityConflict(local as SyncableActivity, server as SyncableActivity)
        : local,
    { now: Date.now, entityTypes: ['activity'] },
  );
}

let engine: SyncEngine | null = null;

/** Push pending local changes. A no-op when cloud services are not configured. */
export async function syncNow(): Promise<SyncReport | null> {
  if (!isApiConfigured()) return null;
  const s = await getServices();
  engine ??= createEngine(s);
  return engine.runOnce();
}

/** Opportunistic background sync whenever the app returns to the foreground. */
export function startForegroundSync(): () => void {
  const run = (): void => void syncNow().catch((e: unknown) => reportError(e, { area: 'sync' }));
  run();
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'active') run();
  });
  return () => sub.remove();
}
