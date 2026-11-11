import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import { Banner, Card, Screen } from '@/components/layout';
import { authErrorMessage, resendVerification } from '@/services/auth';

export default function VerifyEmail() {
  const { email } = useLocalSearchParams<{ email?: string }>();
  const router = useRouter();
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const resend = async (): Promise<void> => {
    if (!email) return;
    setBusy(true);
    try {
      await resendVerification(email);
      setMessage({ tone: 'success', text: 'Verification email sent again.' });
    } catch (e) {
      setMessage({ tone: 'error', text: authErrorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen edges={['top', 'bottom']} contentStyle={{ paddingTop: 96 }}>
      <Text variant="title" accessibilityRole="header" style={{ marginBottom: 16 }}>
        Check your inbox
      </Text>
      {message ? <Banner tone={message.tone} message={message.text} /> : null}
      <Card>
        <Text variant="body">
          We sent a verification link to {email ?? 'your email address'}. Open it on this iPhone to
          activate your account — PACE will sign you in automatically.
        </Text>
      </Card>
      <Button
        label="Resend email"
        variant="secondary"
        onPress={resend}
        loading={busy}
        disabled={!email}
      />
      <Button
        label="Back to sign in"
        variant="ghost"
        onPress={() => router.replace('/(auth)/sign-in')}
        style={{ marginTop: 12 }}
      />
    </Screen>
  );
}
