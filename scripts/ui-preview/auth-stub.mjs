// Stand-in for Supabase Auth, for the UI preview workflow ONLY (CI, iOS simulator, 127.0.0.1).
//
// The preview build points EXPO_PUBLIC_SUPABASE_URL at this server so Maestro can sign in through
// the app's real sign-in screen and reach the signed-in screens. It answers only the password
// sign-in (POST /auth/v1/token?grant_type=password) for one fixed test account, and refuses
// everything else. Nothing here is shipped in the app; no real account or key is involved.
//
// Usage: node scripts/ui-preview/auth-stub.mjs [port]   (default 54321)
import { createServer } from 'node:http';

const PORT = Number(process.argv[2] ?? 54321);
export const TEST_EMAIL = 'preview@pace.test';
export const TEST_PASSWORD = 'preview-password-1';
const USER_ID = '00000000-0000-4000-8000-000000000001';

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function session() {
  const now = Math.floor(Date.now() / 1000);
  const expiresIn = 24 * 3600;
  const user = {
    id: USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: TEST_EMAIL,
    email_confirmed_at: new Date().toISOString(),
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  // Unsigned token in JWT shape; the app never verifies it (only the PACE API would, and the
  // preview build has none).
  const accessToken = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({
    sub: USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: TEST_EMAIL,
    iat: now,
    exp: now + expiresIn,
  })}.preview`;
  return {
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: expiresIn,
    expires_at: now + expiresIn,
    refresh_token: 'preview-refresh-token',
    user,
  };
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function handler(req, res) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    // Logs the route only: never the body (it carries the test password).
    console.log(`${req.method} ${url.pathname}${url.search}`);
    if (req.method === 'POST' && url.pathname === '/auth/v1/token') {
      const grant = url.searchParams.get('grant_type');
      if (grant === 'refresh_token') return send(res, 200, session());
      if (grant === 'password') {
        let body = {};
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          // fall through to the refusal
        }
        if (body.email === TEST_EMAIL && body.password === TEST_PASSWORD)
          return send(res, 200, session());
        return send(res, 400, {
          code: 400,
          error_code: 'invalid_credentials',
          msg: 'Invalid login credentials',
        });
      }
    }
    if (req.method === 'POST' && url.pathname === '/auth/v1/logout') {
      res.writeHead(204);
      return res.end();
    }
    send(res, 404, { code: 404, msg: 'Not available in the UI preview auth stub' });
  });
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('auth-stub.mjs')) {
  createServer(handler).listen(PORT, '127.0.0.1', () =>
    console.log(`UI preview auth stub on http://127.0.0.1:${PORT}`),
  );
}
