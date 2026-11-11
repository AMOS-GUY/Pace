import { darkColors } from '@pace/design-system';
import { Redirect, Stack } from 'expo-router';
import { useSession } from '@/stores/session';

export default function AuthLayout() {
  const status = useSession((s) => s.status);
  if (status === 'signedIn') return <Redirect href="/" />;
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
