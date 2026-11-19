import { darkColors } from '@pace/design-system';
import { Stack } from 'expo-router';
import { Guard } from '@/components/Guard';

/** Guarded (signed out): see src/features/route-access.ts. */
export default function AuthLayout() {
  return (
    <Guard guard="auth">
      <Stack
        screenOptions={{
          headerShown: true,
          headerTransparent: true,
          title: '',
          headerTintColor: darkColors.textPrimary,
          contentStyle: { backgroundColor: darkColors.background },
        }}
      >
        <Stack.Screen name="welcome" options={{ headerShown: false }} />
      </Stack>
    </Guard>
  );
}
