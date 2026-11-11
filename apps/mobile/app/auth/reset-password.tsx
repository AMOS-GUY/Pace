import { credentialsSchema } from '@pace/validation';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Text } from '@/components/Text';
import { Banner, LoadingState, Screen } from '@/components/layout';
import { authErrorMessage, exchangeCode, updatePassword } from '@/services/auth';

/** Deep link target for password recovery (pace://auth/reset-password?code=…). */
export default function ResetPassword() {
  const { code } = useLocalSearchParams<{ code?: string }>();
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!code) {
      setError('This reset link is incomplete. Request a new one.');
      return;
    }
    exchangeCode(code)
      .then(() => setReady(true))
      .catch((e: unknown) => setError(authErrorMessage(e)));
  }, [code]);

  const submit = async (): Promise<void> => {
    const r = credentialsSchema.shape.password.safeParse(password);
    if (!r.success) {
      setError(r.error.issues[0]?.message ?? 'Invalid password');
      return;
    }
    setBusy(true);
    try {
      await updatePassword(password);
      router.replace('/');
    } catch (e) {
      setError(authErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen edges={['top', 'bottom']} contentStyle={{ paddingTop: 64 }}>
      <Text variant="title" accessibilityRole="header" style={{ marginBottom: 24 }}>
        Choose a new password
      </Text>
      {error ? <Banner tone="error" message={error} /> : null}
      {!ready && !error ? <LoadingState label="Checking link…" /> : null}
      {ready ? (
        <>
          <Input
            label="New password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            textContentType="newPassword"
            hint="At least 10 characters."
          />
          <Button label="Save password" size="lg" onPress={submit} loading={busy} />
        </>
      ) : null}
    </Screen>
  );
}
