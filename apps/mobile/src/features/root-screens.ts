import { darkColors } from '@pace/design-system';
import type { Stack } from 'expo-router';
import type { ComponentProps } from 'react';
import type { RootRoute } from './route-access';

/** The object form of Stack.Screen's options (not the per-route function form). */
type ScreenOptions = Exclude<
  NonNullable<ComponentProps<typeof Stack.Screen>['options']>,
  (...args: never[]) => unknown
>;

/** Options of the root stack's screens (the guards are in route-access.ts). */
export const ROOT_SCREEN_OPTIONS: Partial<Record<RootRoute, ScreenOptions>> = {
  recording: { presentation: 'fullScreenModal', gestureEnabled: false },
  'activity/[id]': {
    headerShown: true,
    title: '',
    headerStyle: { backgroundColor: darkColors.background },
    headerTintColor: darkColors.textPrimary,
    // Chevron only. The screen behind it is often the tab navigator, whose route name "(tabs)"
    // iOS would otherwise show as the back title. VoiceOver still reads "Back".
    headerBackButtonDisplayMode: 'minimal',
  },
  settings: { headerShown: false },
  import: {
    presentation: 'modal',
    headerShown: true,
    title: 'Import activities',
    headerStyle: { backgroundColor: darkColors.background },
    headerTintColor: darkColors.textPrimary,
  },
};
