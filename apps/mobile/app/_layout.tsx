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
import { ROOT_SCREEN_OPTIONS } from '@/features/root-screens';
import {
  ROOT_ROUTE_GUARDS,
  type RootRoute,
  type RouteGuard,
  isRecordingActive,
  routeAccess,
} from '@/features/route-access';
import { getServices } from '@/services/container';
import { reportError } from '@/services/monitoring';
import { startForegroundSync } from '@/services/sync';
import { usePreferences } from '@/stores/preferences';
import { useRecording, useRecordingTicker } from '@/stores/recording';
import { useSession } from '@/stores/session';
import { ThemeProvider } from '@/theme/ThemeProvider';

void SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

const GUARDS: readonly RouteGuard[] = ['auth', 'authLinks', 'onboarding', 'app', 'recording'];
const ROUTES = Object.keys(ROOT_ROUTE_GUARDS) as RootRoute[];

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
  const onboardingComplete = useSession((s) => s.onboardingComplete);
  const recordingActive = useRecording((s) => isRecordingActive(s.snapshot?.state.status));
  // Every route but the entry screen sits behind a guard (src/features/route-access.ts). A route
  // that is not allowed is never shown, whether it was tapped, deep-linked or restored; the
  // user is sent to the entry screen, which routes them on.
  const access = routeAccess({ status: authStatus, onboardingComplete, recordingActive });

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
        if (r.recovered) {
          // Load the recovered state first: the recording screen's guard reads it.
          await useRecording.getState().refresh();
          router.push('/recording');
        }
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
                <Stack.Screen name="index" />
                {GUARDS.map((guard) => (
                  <Stack.Protected key={guard} guard={access[guard]} redirectTo="/">
                    {ROUTES.filter((r) => ROOT_ROUTE_GUARDS[r] === guard).map((name) => (
                      <Stack.Screen key={name} name={name} options={ROOT_SCREEN_OPTIONS[name]} />
                    ))}
                  </Stack.Protected>
                ))}
              </Stack>
            )}
          </QueryClientProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
