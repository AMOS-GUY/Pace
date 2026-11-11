import type { ConfigContext, ExpoConfig } from 'expo/config';

const IS_DEV = process.env.APP_VARIANT === 'development';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: IS_DEV ? 'PACE Dev' : 'PACE',
  slug: 'pace',
  scheme: 'pace',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'dark',
  backgroundColor: '#080B12',
  ios: {
    bundleIdentifier: IS_DEV ? 'app.pace.ios.dev' : 'app.pace.ios',
    supportsTablet: false,
    infoPlist: {
      NSLocationWhenInUseUsageDescription:
        'PACE uses your location only while you record an activity, to measure distance, pace and your route.',
      NSLocationAlwaysAndWhenInUseUsageDescription:
        'Allow background location so PACE keeps recording your activity when the screen is locked or you switch apps. PACE never tracks you when you are not recording.',
      UIBackgroundModes: ['location'],
      ITSAppUsesNonExemptEncryption: false,
    },
    privacyManifests: {
      NSPrivacyTracking: false,
      NSPrivacyCollectedDataTypes: [
        {
          NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypePreciseLocation',
          NSPrivacyCollectedDataTypeLinked: true,
          NSPrivacyCollectedDataTypeTracking: false,
          NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
        },
        {
          NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeEmailAddress',
          NSPrivacyCollectedDataTypeLinked: true,
          NSPrivacyCollectedDataTypeTracking: false,
          NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
        },
      ],
    },
  },
  android: {
    // Android is a future milestone (M9); the shared code is platform-neutral.
    package: 'app.pace.android',
  },
  plugins: [
    'expo-router',
    'expo-sqlite',
    'expo-secure-store',
    'expo-font',
    ['expo-splash-screen', { backgroundColor: '#080B12' }],
    ['expo-build-properties', { ios: { deploymentTarget: '16.4' } }],
    '@maplibre/maplibre-react-native',
  ],
  experiments: { typedRoutes: false },
  extra: {
    // Public configuration only. Never place service-role keys or secrets here.
    supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL,
    supabasePublishableKey: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    apiUrl: process.env.EXPO_PUBLIC_API_URL,
    mapStyleUrl: process.env.EXPO_PUBLIC_MAP_STYLE_URL,
  },
});
