import type { SportType } from '@pace/domain';
import { useRouter } from 'expo-router';
import { useCallback } from 'react';
import { usePreferences } from '@/stores/preferences';

/**
 * Opens the recorder for a sport, exactly as the Record tab does: the sport is stored as
 * `lastSport` (which the recorder reads), then the full-screen recorder is opened. Without a
 * sport, the recorder opens with the last used sport.
 */
export function useStartActivity(): (sport?: SportType) => Promise<void> {
  const router = useRouter();
  const update = usePreferences((s) => s.update);
  return useCallback(
    async (sport?: SportType) => {
      if (sport) await update({ lastSport: sport });
      router.push('/recording');
    },
    [router, update],
  );
}
