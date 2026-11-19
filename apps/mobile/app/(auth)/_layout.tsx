import { darkColors } from '@pace/design-system';
import { Stack } from 'expo-router';

/** Access is checked by the root layout (signed out; src/features/route-access.ts). */
export default function AuthLayout() {
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
      <Stack.Screen name="welcome" options={{ headerShown: false }} />
    </Stack>
  );
}
