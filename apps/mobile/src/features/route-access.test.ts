import fs from 'node:fs';
import path from 'node:path';
import type { AuthStatus } from '@/stores/session';
import {
  type AccessState,
  ROOT_ROUTE_GUARDS,
  entryHref,
  isRecordingActive,
  routeAccess,
} from './route-access';

const APP_DIR = path.resolve(__dirname, '../../app');

/** Routes directly under app/, named the way the root layout's Stack.Screen names them. */
function rootRoutes(): string[] {
  const routes: string[] = [];
  const isRouteFile = (f: string): boolean =>
    /\.tsx?$/.test(f) && !f.startsWith('_') && !f.startsWith('+');
  for (const entry of fs.readdirSync(APP_DIR, { withFileTypes: true })) {
    if (entry.isFile()) {
      if (isRouteFile(entry.name)) routes.push(entry.name.replace(/\.tsx?$/, ''));
      continue;
    }
    const dir = path.join(APP_DIR, entry.name);
    if (fs.existsSync(path.join(dir, '_layout.tsx'))) {
      routes.push(entry.name); // a navigator of its own: one screen in the root stack
      continue;
    }
    for (const f of fs.readdirSync(dir)) {
      if (isRouteFile(f)) routes.push(`${entry.name}/${f.replace(/\.tsx?$/, '')}`);
    }
  }
  return routes.sort();
}

const state = (
  status: AuthStatus,
  onboardingComplete = false,
  recordingActive = false,
): AccessState => ({ status, onboardingComplete, recordingActive });

describe('ROOT_ROUTE_GUARDS', () => {
  it('guards every route under app/ except the entry screen', () => {
    const guarded = Object.keys(ROOT_ROUTE_GUARDS).sort();
    expect(rootRoutes()).toEqual(['index', ...guarded].sort());
  });

  it('makes every guarded route render through <Guard> with its guard from this table', () => {
    for (const [route, guard] of Object.entries(ROOT_ROUTE_GUARDS)) {
      const layout = path.join(APP_DIR, route, '_layout.tsx');
      const file = fs.existsSync(layout) ? layout : path.join(APP_DIR, `${route}.tsx`);
      const source = fs.readFileSync(file, 'utf8');
      expect({ route, guards: source.match(/<Guard guard="(\w+)">/g) }).toEqual({
        route,
        guards: [`<Guard guard="${guard}">`],
      });
      // The default export is what expo-router renders: it must be the guarded wrapper.
      expect(source).toMatch(/export default function \w+\(\) \{\s*return \(\s*<Guard /);
    }
  });

  it('keeps the screens of the app behind the signed-in, onboarded guard', () => {
    for (const r of ['(tabs)', 'activity/[id]', 'settings', 'import'] as const) {
      expect(ROOT_ROUTE_GUARDS[r]).toBe('app');
    }
  });
});

describe('routeAccess', () => {
  it('shows nothing but the entry screen in a build without authentication settings', () => {
    for (const onboarding of [false, true]) {
      for (const recording of [false, true]) {
        const a = routeAccess(state('unconfigured', onboarding, recording));
        expect(Object.values(a).every((allowed) => !allowed)).toBe(true);
      }
    }
  });

  it('allows nothing while the session is still loading', () => {
    const a = routeAccess(state('loading', true, true));
    expect(Object.values(a).every((allowed) => !allowed)).toBe(true);
  });

  it('lets a signed-out user reach only the sign-in screens and the auth links', () => {
    // A stored "onboarding complete" flag (e.g. after signing out) must not open the app.
    const a = routeAccess(state('signedOut', true));
    expect(a).toEqual({
      auth: true,
      authLinks: true,
      onboarding: false,
      app: false,
      recording: false,
    });
  });

  it('keeps a signed-in user in onboarding until it is complete', () => {
    expect(routeAccess(state('signedIn', false))).toEqual({
      auth: false,
      authLinks: true,
      onboarding: true,
      app: false,
      recording: false,
    });
  });

  it('opens the app once signed in and onboarded; onboarding stays reachable for editing', () => {
    expect(routeAccess(state('signedIn', true))).toEqual({
      auth: false,
      authLinks: true,
      onboarding: true,
      app: true,
      recording: true,
    });
  });

  it('never closes the screen of an active recording when the session changes', () => {
    expect(routeAccess(state('signedOut', true, true)).recording).toBe(true);
    expect(routeAccess(state('signedIn', false, true)).recording).toBe(true);
    // ...but an active recording opens nothing else.
    expect(routeAccess(state('signedOut', true, true)).app).toBe(false);
  });
});

describe('entryHref', () => {
  it('routes each state from the entry screen', () => {
    expect(entryHref(state('loading'))).toBeNull();
    expect(entryHref(state('unconfigured', true))).toBeNull();
    expect(entryHref(state('signedOut', true))).toBe('/(auth)/welcome');
    expect(entryHref(state('signedIn', false))).toBe('/(onboarding)/profile');
    expect(entryHref(state('signedIn', true))).toBe('/(tabs)');
  });

  it('only ever sends a state to a route it may open', () => {
    const statuses: AuthStatus[] = ['loading', 'unconfigured', 'signedOut', 'signedIn'];
    for (const status of statuses) {
      for (const onboarding of [false, true]) {
        const s = state(status, onboarding);
        const href = entryHref(s);
        if (href === null) continue;
        const group = href.split('/')[1] as keyof typeof ROOT_ROUTE_GUARDS;
        expect(routeAccess(s)[ROOT_ROUTE_GUARDS[group]]).toBe(true);
      }
    }
  });
});

describe('isRecordingActive', () => {
  it('matches the Record tab: anything but ready or saved', () => {
    expect(isRecordingActive(undefined)).toBe(false);
    expect(isRecordingActive('READY')).toBe(false);
    expect(isRecordingActive('SAVED')).toBe(false);
    for (const s of ['ACQUIRING_GPS', 'RECORDING', 'PAUSED', 'FINALIZING', 'PERMISSION_DENIED']) {
      expect(isRecordingActive(s)).toBe(true);
    }
  });
});
