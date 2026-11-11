import Constants from 'expo-constants';
import { z } from 'zod';

const schema = z.object({
  supabaseUrl: z.url(),
  supabasePublishableKey: z.string().min(20),
  apiUrl: z.url().optional(),
  mapStyleUrl: z.url().optional(),
});

export type AppConfig = z.infer<typeof schema>;

export type ConfigResult = { ok: true; config: AppConfig } | { ok: false; missing: string[] };

const NAMES: Record<keyof AppConfig, string> = {
  supabaseUrl: 'EXPO_PUBLIC_SUPABASE_URL',
  supabasePublishableKey: 'EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  apiUrl: 'EXPO_PUBLIC_API_URL',
  mapStyleUrl: 'EXPO_PUBLIC_MAP_STYLE_URL',
};

let cached: ConfigResult | null = null;

/** Validates public runtime configuration once at startup with a precise error list. */
export function loadConfig(): ConfigResult {
  if (cached) return cached;
  const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>;
  const raw = Object.fromEntries(
    Object.entries(extra).filter(([, v]) => typeof v === 'string' && v.length > 0),
  );
  const parsed = schema.safeParse(raw);
  cached = parsed.success
    ? { ok: true, config: parsed.data }
    : {
        ok: false,
        missing: [
          ...new Set(
            parsed.error.issues.map(
              (i) => NAMES[i.path[0] as keyof AppConfig] ?? String(i.path[0]),
            ),
          ),
        ],
      };
  return cached;
}
