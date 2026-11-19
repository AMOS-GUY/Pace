/**
 * What a data screen shows, from its query. Exactly one of loading, error or content:
 * - data already on screen stays there when a background refetch fails (no error screen over it);
 * - the error screen is only for a first load that failed;
 * - the loading screen is only for a first load in progress.
 * Refreshes never show the full-screen loader: see `runPullRefresh`.
 */
export type ContentState = 'loading' | 'error' | 'content';

export function contentState(q: {
  hasData: boolean;
  isError: boolean;
  isPending: boolean;
}): ContentState {
  if (q.hasData) return 'content';
  if (q.isError) return 'error';
  return q.isPending ? 'loading' : 'content';
}

/**
 * One pull-to-refresh. The refresh indicator follows only the user's pull, not background
 * refetches (a cache invalidation after a save, or returning to the screen): driving iOS's
 * RefreshControl from those left its spinner showing over a loaded list. The indicator is
 * always cleared, even if the refetch fails.
 */
export async function runPullRefresh(
  refetch: () => Promise<unknown>,
  setRefreshing: (refreshing: boolean) => void,
): Promise<void> {
  setRefreshing(true);
  try {
    await refetch();
  } catch {
    // The query reports its own error state; the indicator must not stay on.
  } finally {
    setRefreshing(false);
  }
}
