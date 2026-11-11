import type { Session } from '@supabase/supabase-js';
import { create } from 'zustand';
import { loadConfig } from '@/config/env';
import { getAuthClient } from '@/services/auth';
import { getServices, setCurrentUserId } from '@/services/container';
import { reportError } from '@/services/monitoring';

export type AuthStatus = 'loading' | 'unconfigured' | 'signedOut' | 'signedIn';

interface SessionState {
  status: AuthStatus;
  session: Session | null;
  onboardingComplete: boolean;
  initError: string | null;
  init(): Promise<void>;
  completeOnboarding(): Promise<void>;
}

export const useSession = create<SessionState>((set) => ({
  status: 'loading',
  session: null,
  onboardingComplete: false,
  initError: null,

  async init() {
    try {
      const services = await getServices();
      const onboarding = (await services.settings.get<boolean>('onboarding.completed')) ?? false;
      if (!loadConfig().ok) {
        set({ status: 'unconfigured', onboardingComplete: onboarding });
        return;
      }
      const auth = (await getAuthClient())!;
      // Reads the persisted session without network access, so offline launches work.
      const { data } = await auth.auth.getSession();
      setCurrentUserId(data.session?.user.id ?? null);
      set({
        status: data.session ? 'signedIn' : 'signedOut',
        session: data.session,
        onboardingComplete: onboarding,
      });
      auth.auth.onAuthStateChange((_event, session) => {
        setCurrentUserId(session?.user.id ?? null);
        set({ session, status: session ? 'signedIn' : 'signedOut' });
      });
    } catch (e) {
      reportError(e, { area: 'startup' });
      set({ initError: e instanceof Error ? e.message : String(e), status: 'signedOut' });
    }
  },

  async completeOnboarding() {
    const { settings } = await getServices();
    await settings.set('onboarding.completed', true);
    set({ onboardingComplete: true });
  },
}));
