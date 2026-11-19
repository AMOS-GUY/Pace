import { ROOT_SCREEN_OPTIONS } from './root-screens';
import { ROOT_ROUTE_GUARDS } from './route-access';

describe('ROOT_SCREEN_OPTIONS', () => {
  it('only configures routes the root stack declares', () => {
    for (const route of Object.keys(ROOT_SCREEN_OPTIONS)) {
      expect(Object.keys(ROOT_ROUTE_GUARDS)).toContain(route);
    }
  });

  it('shows a plain back chevron on activity detail, never a route name such as "(tabs)"', () => {
    const detail = ROOT_SCREEN_OPTIONS['activity/[id]'];
    expect(detail?.headerShown).toBe(true);
    expect(detail?.headerBackButtonDisplayMode).toBe('minimal');
    expect(detail?.headerBackTitle).toBeUndefined();
  });

  it('keeps the recording screen a full-screen modal that cannot be swiped away', () => {
    expect(ROOT_SCREEN_OPTIONS.recording).toEqual({
      presentation: 'fullScreenModal',
      gestureEnabled: false,
    });
  });
});
