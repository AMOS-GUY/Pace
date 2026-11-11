import type { MeasurementSystem, SportType } from '@pace/domain';
import { create } from 'zustand';
import { getServices } from '@/services/container';

export interface LocalProfile {
  displayName: string;
  preferredSports: SportType[];
  heightCm: number | null;
  weightKg: number | null;
}

export interface Preferences {
  measurementSystem: MeasurementSystem;
  /** Metres trimmed from route start/end on export. 0 = off. */
  exportPrivacyZoneMeters: number;
  autoPause: Partial<Record<SportType, boolean>>;
  lastSport: SportType;
  poolLengthMeters: number;
}

const DEFAULTS: Preferences = {
  measurementSystem: 'metric',
  exportPrivacyZoneMeters: 0,
  autoPause: {},
  lastSport: 'running',
  poolLengthMeters: 25,
};

interface PreferencesState {
  loaded: boolean;
  prefs: Preferences;
  profile: LocalProfile | null;
  load(): Promise<void>;
  update(patch: Partial<Preferences>): Promise<void>;
  saveProfile(profile: LocalProfile): Promise<void>;
}

export const usePreferences = create<PreferencesState>((set, get) => ({
  loaded: false,
  prefs: DEFAULTS,
  profile: null,
  async load() {
    const { settings } = await getServices();
    const prefs = {
      ...DEFAULTS,
      ...((await settings.get<Partial<Preferences>>('preferences')) ?? {}),
    };
    const profile = await settings.get<LocalProfile>('profile');
    set({ prefs, profile, loaded: true });
  },
  async update(patch) {
    const prefs = { ...get().prefs, ...patch };
    set({ prefs });
    const { settings } = await getServices();
    await settings.set('preferences', prefs);
  },
  async saveProfile(profile) {
    set({ profile });
    const { settings } = await getServices();
    await settings.set('profile', profile);
  },
}));

/** Shorthand for the measurement system. */
export const useUnits = (): MeasurementSystem => usePreferences((s) => s.prefs.measurementSystem);
