import { credentialsSchema } from '@pace/validation';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Text } from '@/components/Text';
import { Banner, Screen } from '@/components/layout';
import { authErrorMessage, signUp } from '@/services/auth';

export default function SignUp() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{
    email?: string;
    password?: string;
    confirm?: string;
  }>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setError(null);
    const parsed = credentialsSchema.safeParse({ email: email.trim().toLowerCase(), password });
    const errs: typeof fieldErrors = {};
    if (!parsed.success) {
      for (const i of parsed.error.issues)
        errs[i.path[0] as 'email' | 'password'] =
          i.path[0] === 'email' ? 'Enter a valid email address.' : i.message;
    }
    if (password !== confirm) errs.confirm = 'Passwords do not match.';
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0 || !parsed.success) return;
    setBusy(true);
    try {
      const { needsVerification } = await signUp(parsed.data.email, parsed.data.password);
      if (needsVerification)
        router.replace({ pathname: '/(auth)/verify-email', params: { email: parsed.data.email } });
      else router.replace('/');
    } catch (e) {
      setError(authErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen edges={['top', 'bottom']} contentStyle={{ paddingTop: 96 }}>
      <Text variant="title" accessibilityRole="header" style={{ marginBottom: 8 }}>
        Create your account
      </Text>
      <Text variant="bodySmall" color="secondary" style={{ marginBottom: 24 }}>
        An account protects your backups and lets you restore on a new phone. Recording itself works
        offline.
      </Text>
      {error ? <Banner tone="error" message={error} /> : null}
      <Input
        label="Email"
        value={email}
        onChangeText={setEmail}
        error={fieldErrors.email}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        textContentType="emailAddress"
      />
      <Input
        label="Password"
        value={password}
        onChangeText={setPassword}
        error={fieldErrors.password}
        hint="At least 10 characters."
        secureTextEntry
        autoComplete="new-password"
        textContentType="newPassword"
      />
      <Input
        label="Confirm password"
        value={confirm}
        onChangeText={setConfirm}
        error={fieldErrors.confirm}
        secureTextEntry
        textContentType="newPassword"
        onSubmitEditing={submit}
      />
      <Button label="Create account" size="lg" onPress={submit} loading={busy} />
    </Screen>
  );
}
