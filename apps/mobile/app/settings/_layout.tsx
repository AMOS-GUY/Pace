import { darkColors, fontFamily } from '@pace/design-system';
import { Stack } from 'expo-router';

export default function SettingsLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerStyle: { backgroundColor: darkColors.background },
        headerTintColor: darkColors.textPrimary,
        headerTitleStyle: { fontFamily: fontFamily.semibold },
        contentStyle: { backgroundColor: darkColors.background },
      }}
    >
      <Stack.Screen name="units" options={{ title: 'Units' }} />
      <Stack.Screen name="goals" options={{ title: 'Training goals' }} />
      <Stack.Screen name="backup" options={{ title: 'Backup & restore' }} />
      <Stack.Screen name="export" options={{ title: 'Export data' }} />
      <Stack.Screen name="privacy" options={{ title: 'Privacy' }} />
      <Stack.Screen name="devices" options={{ title: 'Connected devices' }} />
      <Stack.Screen name="account" options={{ title: 'Delete account' }} />
    </Stack>
  );
}
