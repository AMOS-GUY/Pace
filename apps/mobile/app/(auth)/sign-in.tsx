import { credentialsSchema } from '@pace/validation';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable } from 'react-native';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Text } from '@/components/Text';
import { Banner, Screen } from '@/components/layout';
import { authErrorMessage, signIn } from '@/services/auth';

export default function SignIn() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    setError(null);
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    try {
      await signIn(email.trim().toLowerCase(), password);
      router.replace('/');
    } catch (e) {
      const msg = authErrorMessage(e);
      if (/verify your email/.test(msg))
        router.push({ pathname: '/(auth)/verify-email', params: { email: email.trim() } });
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen edges={['top', 'bottom']} contentStyle={{ paddingTop: 96 }}>
      <Text variant="title" accessibilityRole="header" style={{ marginBottom: 24 }}>
        Sign in
      </Text>
      {error ? <Banner tone="error" message={error} /> : null}
      <Input
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        textContentType="emailAddress"
      />
      <Input
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
        onSubmitEditing={submit}
      />
      <Button label="Sign in" size="lg" onPress={submit} loading={busy} />
      <Pressable
        accessibilityRole="button"
        onPress={() => router.push('/(auth)/forgot-password')}
        style={{ marginTop: 20, alignSelf: 'center' }}
        hitSlop={12}
      >
        <Text variant="label" color="accent">
          Forgot password?
        </Text>
      </Pressable>
      <Text variant="caption" color="secondary" align="center" style={{ marginTop: 32 }}>
        Passwords need at least {credentialsSchema.shape.password.minLength ?? 10} characters.
      </Text>
    </Screen>
  );
}
