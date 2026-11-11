import { z } from '@pace/validation';
import { useState } from 'react';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Text } from '@/components/Text';
import { Banner, Screen } from '@/components/layout';
import { authErrorMessage, requestPasswordReset } from '@/services/auth';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    const parsed = z.email().safeParse(email.trim().toLowerCase());
    if (!parsed.success) {
      setState({ tone: 'error', text: 'Enter a valid email address.' });
      return;
    }
    setBusy(true);
    try {
      await requestPasswordReset(parsed.data);
      // Same message whether or not the account exists, to avoid account enumeration.
      setState({
        tone: 'success',
        text: 'If an account exists for that email, a reset link is on its way.',
      });
    } catch (e) {
      setState({ tone: 'error', text: authErrorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen edges={['top', 'bottom']} contentStyle={{ paddingTop: 96 }}>
      <Text variant="title" accessibilityRole="header" style={{ marginBottom: 24 }}>
        Reset password
      </Text>
      {state ? <Banner tone={state.tone} message={state.text} /> : null}
      <Input
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
        autoComplete="email"
        onSubmitEditing={submit}
      />
      <Button label="Send reset link" size="lg" onPress={submit} loading={busy} />
    </Screen>
  );
}
