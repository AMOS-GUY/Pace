import { darkColors } from '@pace/design-system';
import { Redirect, Stack } from 'expo-router';
import { useSession } from '@/stores/session';

export default function OnboardingLayout() {
  const status = useSession((s) => s.status);
  if (status === 'signedOut') return <Redirect href="/(auth)/welcome" />;
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
