import type { LiveMetrics } from '@pace/activity-engine';
import type { GeoPoint } from '@pace/domain';
import { useEffect } from 'react';
import { create } from 'zustand';
import { getServices, onRecordingChange } from '@/services/container';

interface RecordingState {
  snapshot: LiveMetrics | null;
  activityId: string | null;
  acquisitionAccuracy: number | null;
  /** Recent processed route for the live map (bounded for rendering performance). */
  liveRoute: GeoPoint[][];
  refresh(): Promise<void>;
}

export const useRecording = create<RecordingState>((set) => ({
  snapshot: null,
  activityId: null,
  acquisitionAccuracy: null,
  liveRoute: [],
  async refresh() {
    const { coordinator } = await getServices();
    set({
      snapshot: coordinator.snapshot(),
      activityId: coordinator.currentActivityId,
      acquisitionAccuracy: coordinator.lastAcquisitionAccuracy,
      liveRoute: coordinator.liveRoute(),
    });
  },
}));

/** Keeps the recording store in sync: on every coordinator change and once per second for timers. */
export function useRecordingTicker(): void {
  useEffect(() => {
    const refresh = (): void => void useRecording.getState().refresh();
    const unsubscribe = onRecordingChange(refresh);
    const timer = setInterval(refresh, 1000);
    refresh();
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, []);
}
