import '@/polyfills';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from '@expo-google-fonts/inter';
import { darkColors } from '@pace/design-system';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack, useRouter } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ErrorState, Screen } from '@/components/layout';
import { getServices } from '@/services/container';
import { reportError } from '@/services/monitoring';
import { startForegroundSync } from '@/services/sync';
import { usePreferences } from '@/stores/preferences';
import { useRecordingTicker } from '@/stores/recording';
import { useSession } from '@/stores/session';
import { ThemeProvider } from '@/theme/ThemeProvider';

void SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });
  const [bootError, setBootError] = useState<string | null>(null);
  const [booted, setBooted] = useState(false);
  const router = useRouter();
  useRecordingTicker();
  const authStatus = useSession((s) => s.status);

  // Background-safe sync: only when signed in; recording never depends on it.
  useEffect(() => (authStatus === 'signedIn' ? startForegroundSync() : undefined), [authStatus]);

  useEffect(() => {
    (async () => {
      try {
        await getServices(); // opens + migrates SQLite
        await Promise.all([useSession.getState().init(), usePreferences.getState().load()]);
        setBooted(true);
        // Recover an interrupted recording before anything else is shown.
        const { coordinator } = await getServices();
        const r = await coordinator.recover().catch((e: unknown) => {
          reportError(e, { area: 'recovery' });
          return { recovered: false as const };
        });
        if (r.recovered) router.push('/recording');
      } catch (e) {
        reportError(e, { area: 'boot' });
        setBootError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [router]);

  useEffect(() => {
    if (fontsLoaded && (booted || bootError)) void SplashScreen.hideAsync();
  }, [fontsLoaded, booted, bootError]);

  if (!fontsLoaded || (!booted && !bootError)) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: darkColors.background }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <QueryClientProvider client={queryClient}>
            <StatusBar style="light" />
            {bootError ? (
              <Screen>
                <ErrorState message={`PACE could not open its local database: ${bootError}`} />
              </Screen>
            ) : (
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: darkColors.background },
                }}
              >
                <Stack.Screen
                  name="recording"
                  options={{ presentation: 'fullScreenModal', gestureEnabled: false }}
                />
                <Stack.Screen
                  name="activity/[id]"
                  options={{
                    headerShown: true,
                    title: '',
                    headerStyle: { backgroundColor: darkColors.background },
                    headerTintColor: darkColors.textPrimary,
                  }}
                />
                <Stack.Screen name="settings" options={{ headerShown: false }} />
              </Stack>
            )}
          </QueryClientProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
