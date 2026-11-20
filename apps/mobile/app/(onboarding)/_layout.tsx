import { darkColors } from '@pace/design-system';
import { Stack } from 'expo-router';
import { Guard } from '@/components/Guard';

/** Guarded (signed in): see src/features/route-access.ts. */
export default function OnboardingLayout() {
  return (
    <Guard guard="onboarding">
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
    </Guard>
  );
}
