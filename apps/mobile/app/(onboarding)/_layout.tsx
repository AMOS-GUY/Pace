import { darkColors } from '@pace/design-system';
import { Stack } from 'expo-router';

/** Access is checked by the root layout (signed in; src/features/route-access.ts). */
export default function OnboardingLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerTransparent: true,
        title: '',
        headerTintColor: darkColors.textPrimary,
        contentStyle: { backgroundColor: darkColors.background },
      }}
    >
      <Stack.Screen name="profile" options={{ headerShown: false }} />
    </Stack>
  );
}
