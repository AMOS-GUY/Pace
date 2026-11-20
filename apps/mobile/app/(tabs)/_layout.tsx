import { Ionicons } from '@expo/vector-icons';
import { darkColors, fontFamily } from '@pace/design-system';
import { Tabs } from 'expo-router';
import type { ComponentProps } from 'react';
import type { ColorValue } from 'react-native';
import { Guard } from '@/components/Guard';

type IconName = ComponentProps<typeof Ionicons>['name'];

const icon =
  (name: IconName) =>
  ({ color, size }: { color: ColorValue; size: number }) => (
    <Ionicons name={name} color={color as string} size={size} />
  );

/** Guarded (signed in and onboarded): see src/features/route-access.ts. */
export default function TabsLayout() {
  return (
    <Guard guard="app">
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: darkColors.accent,
          tabBarInactiveTintColor: darkColors.textSecondary,
          tabBarStyle: { backgroundColor: darkColors.surface, borderTopColor: darkColors.divider },
          tabBarLabelStyle: { fontFamily: fontFamily.medium, fontSize: 11 },
        }}
      >
        <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: icon('home-outline') }} />
        <Tabs.Screen
          name="record"
          options={{ title: 'Record', tabBarIcon: icon('radio-button-on-outline') }}
        />
        <Tabs.Screen
          name="activities"
          options={{ title: 'Activities', tabBarIcon: icon('list-outline') }}
        />
        <Tabs.Screen
          name="progress"
          options={{ title: 'Progress', tabBarIcon: icon('stats-chart-outline') }}
        />
        <Tabs.Screen
          name="profile"
          options={{ title: 'Profile', tabBarIcon: icon('person-circle-outline') }}
        />
      </Tabs>
    </Guard>
  );
}
