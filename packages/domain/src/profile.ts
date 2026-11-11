import type { SportType } from './sport';

export type MeasurementSystem = 'metric' | 'imperial';

export interface UserProfile {
  id: string;
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  measurementSystem: MeasurementSystem;
  language: string;
  timezone: string;
  preferredSports: SportType[];
  heightCm: number | null;
  weightKg: number | null;
  /** Weekly training target distance in metres; null = not set. */
  weeklyTargetDistanceMeters: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface PrivacyPreferences {
  /** Trim this many metres from the start/end of routes on export to protect home locations. */
  exportPrivacyZoneMeters: number;
  crashReportingEnabled: boolean;
}
