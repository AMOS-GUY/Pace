import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Text } from '@/components/Text';
import { Row, Screen } from '@/components/layout';
import { usePreferences } from '@/stores/preferences';

function parseOptional(v: string, min: number, max: number): number | null | 'invalid' {
  if (!v.trim()) return null;
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) && n >= min && n <= max ? n : 'invalid';
}

export default function OnboardingProfile() {
  const router = useRouter();
  const { edit } = useLocalSearchParams<{ edit?: string }>();
  const { profile, saveProfile } = usePreferences();
  const [name, setName] = useState(profile?.displayName ?? '');
  const [height, setHeight] = useState(profile?.heightCm ? String(profile.heightCm) : '');
  const [weight, setWeight] = useState(profile?.weightKg ? String(profile.weightKg) : '');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const next = async (): Promise<void> => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = 'Tell us what to call you.';
    const h = parseOptional(height, 50, 272);
    const w = parseOptional(weight, 20, 400);
    if (h === 'invalid') e.height = 'Enter a height between 50 and 272 cm.';
    if (w === 'invalid') e.weight = 'Enter a weight between 20 and 400 kg.';
    setErrors(e);
    if (Object.keys(e).length) return;
    await saveProfile({
      displayName: name.trim().slice(0, 60),
      preferredSports: profile?.preferredSports ?? [],
      heightCm: h as number | null,
      weightKg: w as number | null,
    });
    if (edit) router.back();
    else router.push('/(onboarding)/sports');
  };

  return (
    <Screen edges={['top', 'bottom']} contentStyle={{ paddingTop: 64 }}>
      {edit ? null : (
        <Text variant="label" color="accent">
          STEP 1 OF 4
        </Text>
      )}
      <Text variant="title" accessibilityRole="header" style={{ marginVertical: 12 }}>
        Set up your profile
      </Text>
      <Input
        label="Display name"
        value={name}
        onChangeText={setName}
        error={errors.name}
        autoComplete="name"
        maxLength={60}
      />
      <Text variant="bodySmall" color="secondary" style={{ marginBottom: 12 }}>
        Optional — used only on this device for future calorie and training-load estimates.
      </Text>
      <Row>
        <Input
          label="Height (cm)"
          value={height}
          onChangeText={setHeight}
          error={errors.height}
          keyboardType="decimal-pad"
          style={{ minWidth: 150 }}
        />
        <Input
          label="Weight (kg)"
          value={weight}
          onChangeText={setWeight}
          error={errors.weight}
          keyboardType="decimal-pad"
          style={{ minWidth: 150 }}
        />
      </Row>
      <Button label={edit ? 'Save' : 'Continue'} size="lg" onPress={next} />
    </Screen>
  );
}
