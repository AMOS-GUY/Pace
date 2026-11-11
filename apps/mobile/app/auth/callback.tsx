import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ErrorState, LoadingState, Screen } from '@/components/layout';
import { authErrorMessage, exchangeCode } from '@/services/auth';

/** Deep link target for email verification (pace://auth/callback?code=…, PKCE flow). */
export default function AuthCallback() {
  const { code, error_description } = useLocalSearchParams<{
    code?: string;
    error_description?: string;
  }>();
  const router = useRouter();
  const [error, setError] = useState<string | null>(error_description ?? null);

  useEffect(() => {
    if (!code || error) return;
    exchangeCode(code)
      .then(() => router.replace('/'))
      .catch((e: unknown) => setError(authErrorMessage(e)));
  }, [code, error, router]);

  return (
    <Screen>
      {error ? (
        <ErrorState
          message={`Verification failed: ${error}`}
          onRetry={() => router.replace('/(auth)/sign-in')}
        />
      ) : code ? (
        <LoadingState label="Verifying your email…" />
      ) : (
        <ErrorState
          message="This link is incomplete. Request a new one from the sign-in screen."
          onRetry={() => router.replace('/(auth)/sign-in')}
        />
      )}
    </Screen>
  );
}
