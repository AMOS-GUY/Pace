import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { Button } from '@/components/Button';
import { Text } from '@/components/Text';
import { Screen } from '@/components/layout';
import { useTheme } from '@/theme/ThemeProvider';

export default function Welcome() {
  const router = useRouter();
  const { spacing, colors } = useTheme();
  return (
    <Screen
      scroll={false}
      edges={['top', 'bottom']}
      contentStyle={{ justifyContent: 'space-between' }}
    >
      <View style={{ marginTop: spacing.xxxl * 2 }}>
        <Text variant="display" style={{ color: colors.accent }} accessibilityRole="header">
          PACE
        </Text>
        <Text variant="title" style={{ marginTop: spacing.md }}>
          Your Training.{'\n'}Your Data.{'\n'}Your Pace.
        </Text>
        <Text variant="body" color="secondary" style={{ marginTop: spacing.lg }}>
          Dependable GPS recording for running, cycling, walking, hiking, swimming and triathlon.
          Your activities live on your phone first — always exportable.
        </Text>
      </View>
      <View style={{ gap: spacing.md }}>
        <Button label="Create account" size="lg" onPress={() => router.push('/(auth)/sign-up')} />
        <Button
          label="Sign in"
          size="lg"
          variant="secondary"
          onPress={() => router.push('/(auth)/sign-in')}
        />
      </View>
    </Screen>
  );
}
