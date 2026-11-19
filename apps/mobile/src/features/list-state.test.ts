import { contentState, runPullRefresh } from './list-state';

describe('contentState', () => {
  it('shows the loader only for a first load in progress', () => {
    expect(contentState({ hasData: false, isError: false, isPending: true })).toBe('loading');
  });

  it('shows the error screen only when a first load failed', () => {
    expect(contentState({ hasData: false, isError: true, isPending: false })).toBe('error');
  });

  it('keeps loaded data on screen while it refetches or after a refetch failed', () => {
    expect(contentState({ hasData: true, isError: false, isPending: false })).toBe('content');
    expect(contentState({ hasData: true, isError: true, isPending: false })).toBe('content');
  });

  it('shows content (the empty state) for a finished load with no data', () => {
    expect(contentState({ hasData: false, isError: false, isPending: false })).toBe('content');
  });
});

describe('runPullRefresh', () => {
  it('shows the indicator for the duration of the refetch only', async () => {
    const seen: boolean[] = [];
    let finish!: () => void;
    const refetch = (): Promise<void> => new Promise((resolve) => (finish = resolve));
    const run = runPullRefresh(refetch, (r) => seen.push(r));
    expect(seen).toEqual([true]);
    finish();
    await run;
    expect(seen).toEqual([true, false]);
  });

  it('clears the indicator when the refetch fails', async () => {
    const seen: boolean[] = [];
    await expect(
      runPullRefresh(
        () => Promise.reject(new Error('db busy')),
        (r) => seen.push(r),
      ),
    ).resolves.toBeUndefined();
    expect(seen).toEqual([true, false]);
  });

  it('a repeated pull ends with the indicator off', async () => {
    const seen: boolean[] = [];
    await Promise.all([
      runPullRefresh(
        () => Promise.resolve(),
        (r) => seen.push(r),
      ),
      runPullRefresh(
        () => Promise.resolve(),
        (r) => seen.push(r),
      ),
    ]);
    expect(seen.at(-1)).toBe(false);
  });
});
