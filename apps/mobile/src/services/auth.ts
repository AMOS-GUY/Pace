import { type Session, type SupabaseClient, createClient } from '@supabase/supabase-js';
import * as Linking from 'expo-linking';
import { AppState } from 'react-native';
import { loadConfig } from '@/config/env';
import { getServices } from './container';

let client: SupabaseClient | null = null;

/**
 * Supabase Auth client. Sessions are persisted in encrypted local storage (key in the iOS
 * Keychain), so a previously signed-in user can record offline. Only the publishable key is
 * shipped; all privileged operations happen on the PACE API.
 */
export async function getAuthClient(): Promise<SupabaseClient | null> {
  if (client) return client;
  const cfg = loadConfig();
  if (!cfg.ok) return null;
  const { secureKv } = await getServices();
  client = createClient(cfg.config.supabaseUrl, cfg.config.supabasePublishableKey, {
    auth: {
      storage: {
        getItem: (k) => secureKv.getItem(k),
        setItem: (k, v) => secureKv.setItem(k, v),
        removeItem: (k) => secureKv.removeItem(k),
      },
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
      flowType: 'pkce',
    },
  });
  const c = client;
  AppState.addEventListener('change', (state) => {
    if (state === 'active') void c.auth.startAutoRefresh();
    else void c.auth.stopAutoRefresh();
  });
  return client;
}

async function requireClient(): Promise<SupabaseClient> {
  const c = await getAuthClient();
  if (!c) throw new Error('Authentication is not configured for this build.');
  return c;
}

export const redirectUrl = (path: string): string => Linking.createURL(path);

export async function signUp(
  email: string,
  password: string,
): Promise<{ needsVerification: boolean }> {
  const c = await requireClient();
  const { data, error } = await c.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: redirectUrl('auth/callback') },
  });
  if (error) throw error;
  return { needsVerification: !data.session };
}

export async function resendVerification(email: string): Promise<void> {
  const c = await requireClient();
  const { error } = await c.auth.resend({
    type: 'signup',
    email,
    options: { emailRedirectTo: redirectUrl('auth/callback') },
  });
  if (error) throw error;
}

export async function signIn(email: string, password: string): Promise<Session> {
  const c = await requireClient();
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.session;
}

export async function signOut(): Promise<void> {
  const c = await requireClient();
  // 'local' scope works offline and never blocks on the network.
  const { error } = await c.auth.signOut({ scope: 'local' });
  if (error) throw error;
}

export async function requestPasswordReset(email: string): Promise<void> {
  const c = await requireClient();
  const { error } = await c.auth.resetPasswordForEmail(email, {
    redirectTo: redirectUrl('auth/reset-password'),
  });
  if (error) throw error;
}

export async function exchangeCode(code: string): Promise<void> {
  const c = await requireClient();
  const { error } = await c.auth.exchangeCodeForSession(code);
  if (error) throw error;
}

export async function updatePassword(password: string): Promise<void> {
  const c = await requireClient();
  const { error } = await c.auth.updateUser({ password });
  if (error) throw error;
}

export async function currentAccessToken(): Promise<string | null> {
  const c = await getAuthClient();
  if (!c) return null;
  return (await c.auth.getSession()).data.session?.access_token ?? null;
}

/** Human-readable auth error without leaking internals. */
export function authErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/invalid login credentials/i.test(msg)) return 'Email or password is incorrect.';
  if (/email not confirmed/i.test(msg)) return 'Please verify your email address first.';
  if (/already registered/i.test(msg)) return 'An account with this email already exists.';
  if (/network|fetch/i.test(msg)) return 'No connection. Check your internet and try again.';
  if (/rate limit/i.test(msg)) return 'Too many attempts. Please wait a moment and try again.';
  return msg;
}
