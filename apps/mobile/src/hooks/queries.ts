import type { ActivityQuery } from '@pace/database';
import type { SportType } from '@pace/domain';
import { decodePolyline } from '@pace/gps-engine';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { deviceTimeZone, getServices } from '@/services/container';

/** All data reads go through the local database; nothing here touches the network. */
export const queryKeys = {
  all: ['pace'] as const,
  dashboard: () => ['pace', 'dashboard'] as const,
  activities: (q: ActivityQuery) => ['pace', 'activities', q] as const,
  activity: (id: string) => ['pace', 'activity', id] as const,
  progress: (period: string, sport: string | undefined) =>
    ['pace', 'progress', period, sport] as const,
  goals: () => ['pace', 'goals'] as const,
};

export function useInvalidateAll(): () => Promise<void> {
  const qc = useQueryClient();
  return useCallback(() => qc.invalidateQueries({ queryKey: queryKeys.all }), [qc]);
}

export function useDashboard() {
  return useQuery({
    queryKey: queryKeys.dashboard(),
    queryFn: async () => (await getServices()).analytics.dashboard(Date.now(), deviceTimeZone()),
  });
}

const PAGE = 30;

export function useActivityList(q: Omit<ActivityQuery, 'limit' | 'offset'>) {
  return useInfiniteQuery({
    queryKey: queryKeys.activities(q),
    initialPageParam: 0,
    queryFn: async ({ pageParam }) =>
      (await getServices()).activities.list({ ...q, limit: PAGE, offset: pageParam }),
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });
}

export function useActivityDetail(id: string) {
  return useQuery({
    queryKey: queryKeys.activity(id),
    queryFn: async () => {
      const s = await getServices();
      const activity = await s.activities.getById(id);
      if (!activity || activity.deletedAt != null) return null;
      const [laps, splits, segments, route, records] = await Promise.all([
        s.activities.laps(id),
        s.activities.splits(id),
        s.activities.segments(id),
        s.routes.processed(id),
        s.records.forActivity(id),
      ]);
      return {
        activity,
        laps,
        splits,
        segments,
        records,
        route: route
          ? { ...route, points: route.segments.map((seg) => decodePolyline(seg, 6)) }
          : null,
      };
    },
  });
}

export function useProgress(period: 'week' | 'month' | 'year', sportType?: SportType) {
  return useQuery({
    queryKey: queryKeys.progress(period, sportType),
    queryFn: async () =>
      (await getServices()).analytics.progress({
        period,
        count: period === 'week' ? 12 : period === 'month' ? 12 : 5,
        now: Date.now(),
        timeZone: deviceTimeZone(),
        ...(sportType ? { sportType } : {}),
      }),
  });
}

export function useGoals() {
  return useQuery({
    queryKey: queryKeys.goals(),
    queryFn: async () => (await getServices()).goals.list(),
  });
}
