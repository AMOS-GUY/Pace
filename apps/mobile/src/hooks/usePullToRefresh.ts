import { useCallback, useEffect, useRef, useState } from 'react';
import { runPullRefresh } from '@/features/list-state';

/** RefreshControl props for a screen: the spinner shows only while the user's own pull runs. */
export function usePullToRefresh(refetch: () => Promise<unknown>): {
  refreshing: boolean;
  onRefresh: () => void;
} {
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const onRefresh = useCallback(() => {
    void runPullRefresh(refetch, (r) => {
      if (mounted.current) setRefreshing(r);
    });
  }, [refetch]);
  return { refreshing, onRefresh };
}
