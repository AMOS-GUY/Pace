import 'reflect-metadata';
import { PGlite } from '@electric-sql/pglite';
import { Global, type INestApplication, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { drizzle } from 'drizzle-orm/pglite';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { JWT_KEY } from '../src/common/auth';
import { OBJECT_STORAGE, type ObjectStorage } from '../src/common/storage';
import { loadEnv } from '../src/config/env';
import { DB, DB_PING } from '../src/database/database.module';
import { runMigrations } from '../src/database/migrate';
import { configureApp } from '../src/main';
import { schema } from '../src/database/schema';

const SUPABASE_URL = 'https://project.supabase.test';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const ACTIVITY = '33333333-3333-4333-8333-333333333333';

class MemoryStorage implements ObjectStorage {
  objects = new Map<string, number>();
  async presignPut(key: string): Promise<string> {
    return `https://storage.test/put/${encodeURIComponent(key)}`;
  }
  async presignGet(key: string): Promise<string> {
    return `https://storage.test/get/${encodeURIComponent(key)}`;
  }
  async head(key: string): Promise<number | null> {
    return this.objects.get(key) ?? null;
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

let app: INestApplication;
let pg: PGlite;
let storage: MemoryStorage;
let sign: (sub: string, opts?: { exp?: string; aud?: string; iss?: string }) => Promise<string>;
let foreignToken: string;

const activityPayload = (over: Record<string, unknown> = {}) => ({
  id: ACTIVITY,
  sportType: 'running',
  title: 'Morning Run',
  description: null,
  startedAt: Date.UTC(2026, 5, 1, 6),
  endedAt: Date.UTC(2026, 5, 1, 7),
  timezone: 'Asia/Singapore',
  status: 'completed',
  source: 'recorded',
  swimMode: null,
  poolLengthMeters: null,
  elapsedDurationMs: 3_600_000,
  movingDurationMs: 3_500_000,
  distanceMeters: 10_000,
  elevationGainMeters: 40,
  elevationLossMeters: 38,
  averageSpeedMps: 2.857,
  maximumSpeedMps: 4.1,
  averagePaceMsPerKm: 350_000,
  createdAt: Date.UTC(2026, 5, 1, 7),
  updatedAt: Date.UTC(2026, 5, 1, 7),
  deletedAt: null,
  version: 2,
  ...over,
});

beforeAll(async () => {
  pg = new PGlite();
  await runMigrations({ exec: (s) => pg.exec(s), query: (s, p) => pg.query(s, p) });
  const db = drizzle({ client: pg, schema });

  @Global()
  @Module({
    providers: [
      { provide: DB, useValue: db },
      { provide: DB_PING, useValue: async () => void (await pg.query('SELECT 1')) },
    ],
    exports: [DB, DB_PING],
  })
  class TestDatabaseModule {}

  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'ES256' };
  sign = (sub, o = {}) =>
    new SignJWT({ role: 'authenticated', email: `${sub.slice(0, 4)}@example.test` })
      .setProtectedHeader({ alg: 'ES256', kid: 'test' })
      .setSubject(sub)
      .setIssuer(o.iss ?? `${SUPABASE_URL}/auth/v1`)
      .setAudience(o.aud ?? 'authenticated')
      .setIssuedAt()
      .setExpirationTime(o.exp ?? '10m')
      .sign(privateKey);
  const other = await generateKeyPair('ES256');
  foreignToken = await new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'ES256', kid: 'test' })
    .setSubject(USER_A)
    .setIssuer(`${SUPABASE_URL}/auth/v1`)
    .setAudience('authenticated')
    .setExpirationTime('10m')
    .sign(other.privateKey);

  storage = new MemoryStorage();
  const env = loadEnv({
    DATABASE_URL: 'pglite://memory',
    SUPABASE_URL,
    NODE_ENV: 'test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests',
  });
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.create({ env, database: TestDatabaseModule })],
  })
    .overrideProvider(JWT_KEY)
    .useValue(createLocalJWKSet({ keys: [jwk] }))
    .overrideProvider(OBJECT_STORAGE)
    .useValue(storage)
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, '');
  await app.init();
});

afterAll(async () => {
  await app?.close();
  await pg?.close();
});

const http = () => request(app.getHttpServer());
const auth = async (sub = USER_A) => ({ Authorization: `Bearer ${await sign(sub)}` });

describe('configuration', () => {
  it('fails fast with a precise message when configuration is missing', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL[\s\S]*SUPABASE_URL/);
  });
});

describe('public endpoints', () => {
  it('reports health and version without authentication', async () => {
    await http().get('/api/v1/health').expect(200, { status: 'ok', database: 'ok' });
    const v = await http().get('/api/v1/version').expect(200);
    expect(v.body.api).toBe('v1');
  });
});

describe('authentication', () => {
  it('rejects missing, forged, expired and wrong-audience tokens', async () => {
    await http().get('/api/v1/profiles/me').expect(401);
    await http()
      .get('/api/v1/profiles/me')
      .set('Authorization', `Bearer ${foreignToken}`)
      .expect(401);
    const expired = await sign(USER_A, { exp: '-1m' });
    await http().get('/api/v1/profiles/me').set('Authorization', `Bearer ${expired}`).expect(401);
    const wrongAud = await sign(USER_A, { aud: 'anon' });
    await http().get('/api/v1/profiles/me').set('Authorization', `Bearer ${wrongAud}`).expect(401);
    const wrongIss = await sign(USER_A, { iss: 'https://evil.test/auth/v1' });
    const r = await http()
      .get('/api/v1/profiles/me')
      .set('Authorization', `Bearer ${wrongIss}`)
      .expect(401);
    expect(r.body).toEqual({ code: 'invalid_token', message: 'Invalid or expired token' });
  });
});

describe('profiles', () => {
  it('creates idempotently, reads and updates the caller’s profile only', async () => {
    const h = await auth();
    await http().get('/api/v1/profiles/me').set(h).expect(404);
    const created = await http()
      .post('/api/v1/auth/profile')
      .set(h)
      .send({ displayName: 'Ava', measurementSystem: 'metric' })
      .expect(201);
    expect(created.body.displayName).toBe('Ava');
    await http().post('/api/v1/auth/profile').set(h).send({ displayName: 'Other' }).expect(201);
    expect((await http().get('/api/v1/profiles/me').set(h).expect(200)).body.displayName).toBe(
      'Ava',
    );
    const upd = await http()
      .patch('/api/v1/profiles/me')
      .set(h)
      .send({ measurementSystem: 'imperial', preferredSports: ['running'] })
      .expect(200);
    expect(upd.body).toMatchObject({ measurementSystem: 'imperial', preferredSports: ['running'] });
    const bad = await http()
      .patch('/api/v1/profiles/me')
      .set(h)
      .send({ measurementSystem: 'cubits' })
      .expect(400);
    expect(bad.body.code).toBe('validation_error');
    await http()
      .get('/api/v1/profiles/me')
      .set(await auth(USER_B))
      .expect(404);
  });
});

describe('activity sync', () => {
  it('applies, deduplicates, detects conflicts and enforces ownership', async () => {
    const h = await auth();
    const first = await http()
      .post('/api/v1/activities/sync')
      .set(h)
      .send({ activity: activityPayload() })
      .expect(200);
    expect(first.body.status).toBe('applied');
    const dup = await http()
      .post('/api/v1/activities/sync')
      .set(h)
      .send({ activity: activityPayload() })
      .expect(200);
    expect(dup.body.status).toBe('duplicate');

    const newer = await http()
      .post('/api/v1/activities/sync')
      .set(h)
      .send({
        activity: activityPayload({
          title: 'Renamed',
          version: 3,
          updatedAt: Date.UTC(2026, 5, 2),
        }),
      })
      .expect(200);
    expect(newer.body.activity.title).toBe('Renamed');

    const stale = await http()
      .post('/api/v1/activities/sync')
      .set(h)
      .send({
        activity: activityPayload({ title: 'Stale', version: 2, updatedAt: Date.UTC(2026, 5, 3) }),
      })
      .expect(409);
    expect(stale.body.code).toBe('version_conflict');
    expect(stale.body.server.title).toBe('Renamed');

    // Another user cannot read, overwrite or claim the id.
    const hb = await auth(USER_B);
    await http().get(`/api/v1/activities/${ACTIVITY}`).set(hb).expect(404);
    const steal = await http()
      .post('/api/v1/activities/sync')
      .set(hb)
      .send({ activity: activityPayload({ version: 99 }) })
      .expect(409);
    expect(steal.body.code).toBe('id_conflict');
    expect(steal.body.server).toBeUndefined();
  });

  it('accepts idempotent route batches and validates samples', async () => {
    const h = await auth();
    const samples = Array.from({ length: 3 }, (_, i) => ({
      sequenceNumber: i,
      latitude: 1.29 + i * 1e-5,
      longitude: 103.85,
      altitudeMeters: 10,
      horizontalAccuracyMeters: 5,
      verticalAccuracyMeters: 3,
      speedMps: 3,
      courseDegrees: 90,
      recordedAt: Date.UTC(2026, 5, 1, 6) + i * 1000,
      source: 'device_gps',
    }));
    const r1 = await http()
      .post(`/api/v1/activities/${ACTIVITY}/route-batches`)
      .set(h)
      .send({ firstSequence: 0, samples })
      .expect(200);
    expect(r1.body.inserted).toBe(3);
    const r2 = await http()
      .post(`/api/v1/activities/${ACTIVITY}/route-batches`)
      .set(h)
      .send({ firstSequence: 0, samples })
      .expect(200);
    expect(r2.body.inserted).toBe(0);
    await http()
      .post(`/api/v1/activities/${ACTIVITY}/route-batches`)
      .set(h)
      .send({ firstSequence: 0, samples: [{ ...samples[0], latitude: 400 }] })
      .expect(400);
    await http()
      .post(`/api/v1/activities/${ACTIVITY}/route-batches`)
      .set(await auth(USER_B))
      .send({ firstSequence: 0, samples })
      .expect(404);
  });

  it('lists with cursor pagination, edits and tombstones', async () => {
    const h = await auth();
    for (let i = 0; i < 3; i++) {
      await http()
        .post('/api/v1/activities/sync')
        .set(h)
        .send({
          activity: activityPayload({
            id: `44444444-4444-4444-8444-00000000000${i}`,
            startedAt: Date.UTC(2026, 4, 1 + i),
          }),
        })
        .expect(200);
    }
    const p1 = await http().get('/api/v1/activities?limit=2').set(h).expect(200);
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.items[0].id).toBe(ACTIVITY);
    const p2 = await http()
      .get(`/api/v1/activities?limit=2&cursor=${p1.body.nextCursor}`)
      .set(h)
      .expect(200);
    expect(p2.body.items).toHaveLength(2);
    expect(p2.body.nextCursor).toBeNull();

    const edited = await http()
      .patch(`/api/v1/activities/${ACTIVITY}`)
      .set(h)
      .send({ description: 'Tempo' })
      .expect(200);
    expect(edited.body.description).toBe('Tempo');

    await http().delete(`/api/v1/activities/${ACTIVITY}`).set(h).expect(204);
    await http().delete(`/api/v1/activities/${ACTIVITY}`).set(h).expect(204);
    await http().get(`/api/v1/activities/${ACTIVITY}`).set(h).expect(404);
    const resurrect = await http()
      .post('/api/v1/activities/sync')
      .set(h)
      .send({ activity: activityPayload({ version: 50 }) })
      .expect(409);
    expect(resurrect.body.code).toBe('version_conflict');
    const points = await pg.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM route_points WHERE activity_id = $1',
      [ACTIVITY],
    );
    expect(points.rows[0]!.n).toBe(0);
  });
});

describe('backups', () => {
  const body = {
    sizeBytes: 1234,
    checksumSha256: 'a'.repeat(64),
    formatVersion: 1,
    encrypted: true,
  };

  it('requires encryption and enforces size limits', async () => {
    const h = await auth();
    await http()
      .post('/api/v1/backups')
      .set(h)
      .send({ ...body, encrypted: false })
      .expect(400);
    await http()
      .post('/api/v1/backups')
      .set(h)
      .send({ ...body, sizeBytes: 600 * 1024 * 1024 })
      .expect(413);
  });

  it('creates idempotently, verifies upload, lists, downloads and deletes', async () => {
    const h = await auth();
    const c1 = await http()
      .post('/api/v1/backups')
      .set(h)
      .set('Idempotency-Key', 'k1')
      .send(body)
      .expect(201);
    const c2 = await http()
      .post('/api/v1/backups')
      .set(h)
      .set('Idempotency-Key', 'k1')
      .send(body)
      .expect(201);
    expect(c2.body.backup.id).toBe(c1.body.backup.id);
    await http()
      .post('/api/v1/backups')
      .set(h)
      .set('Idempotency-Key', 'k1')
      .send({ ...body, sizeBytes: 99 })
      .expect(409);
    const id = c1.body.backup.id as string;
    const key = decodeURIComponent((c1.body.uploadUrl as string).split('/put/')[1]!);
    expect(key).toBe(`users/${USER_A}/backups/${id}.pacebackup`);

    await http().post(`/api/v1/backups/${id}/complete`).set(h).expect(409); // not uploaded
    storage.objects.set(key, 99);
    await http().post(`/api/v1/backups/${id}/complete`).set(h).expect(409); // wrong size
    storage.objects.set(key, 1234);
    const done = await http().post(`/api/v1/backups/${id}/complete`).set(h).expect(200);
    expect(done.body.backup.status).toBe('complete');

    expect((await http().get('/api/v1/backups').set(h).expect(200)).body.items).toHaveLength(1);
    expect(
      (await http().get(`/api/v1/backups/${id}`).set(h).expect(200)).body.downloadUrl,
    ).toContain('/get/');
    await http()
      .get(`/api/v1/backups/${id}`)
      .set(await auth(USER_B))
      .expect(404);
    await http().delete(`/api/v1/backups/${id}`).set(h).expect(204);
    expect(storage.objects.has(key)).toBe(false);
  });
});

describe('devices and entitlements', () => {
  it('registers devices per user and returns configured entitlements', async () => {
    const h = await auth();
    const d = await http()
      .post('/api/v1/devices')
      .set(h)
      .send({ deviceType: 'heart_rate_monitor', externalIdentifier: 'hrm-1' })
      .expect(201);
    await http()
      .post('/api/v1/devices')
      .set(h)
      .send({ deviceType: 'heart_rate_monitor', externalIdentifier: 'hrm-1' })
      .expect(201);
    expect((await http().get('/api/v1/devices').set(h).expect(200)).body.items).toHaveLength(1);
    expect(
      (
        await http()
          .get('/api/v1/devices')
          .set(await auth(USER_B))
          .expect(200)
      ).body.items,
    ).toHaveLength(0);
    await http().delete(`/api/v1/devices/${d.body.id}`).set(h).expect(204);
    const e = await http().get('/api/v1/entitlements').set(h).expect(200);
    expect(e.body.features).toContain('recording');
  });
});

describe('account deletion', () => {
  it('deletes all of the caller’s data and the auth user', async () => {
    const h = await auth(USER_B);
    await http().post('/api/v1/auth/profile').set(h).send({ displayName: 'Bo' }).expect(201);
    await http()
      .post('/api/v1/activities/sync')
      .set(h)
      .send({ activity: activityPayload({ id: '55555555-5555-4555-8555-555555555555' }) })
      .expect(200);
    const calls: string[] = [];
    const realFetch = global.fetch;
    global.fetch = (async (url: URL | string, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(url)}`);
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    try {
      await http().delete('/api/v1/account').set(h).expect(204);
    } finally {
      global.fetch = realFetch;
    }
    expect(calls).toEqual([`DELETE ${SUPABASE_URL}/auth/v1/admin/users/${USER_B}`]);
    const left = await pg.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM activities WHERE user_id = $1',
      [USER_B],
    );
    expect(left.rows[0]!.n).toBe(0);
    // User A's data is untouched.
    expect(
      (
        await http()
          .get('/api/v1/profiles/me')
          .set(await auth())
          .expect(200)
      ).body.displayName,
    ).toBe('Ava');
  });
});
