# PACE

**Your Training. Your Data. Your Pace.**

PACE is a local-first endurance sports tracker for iPhone — running, cycling, walking, hiking,
swimming and triathlon. Activities are recorded and stored on the phone first; cloud backup and
sync are optional and end-to-end encrypted.

> Status: foundation through M6 is implemented and tested in software. The native iOS
> build and all GPS behaviour still need validation on a Mac and a physical iPhone before beta.
> See [PROGRESS.md](PROGRESS.md) for exactly what is verified and what is not.

## Repository layout

```text
apps/
  mobile/            Expo SDK 58 / React Native 0.88 iOS app (Expo Router)
    app/             Screens (file-based routes)
    src/             Components, stores, services, hooks, theme
    modules/pace-tracking/   Native Swift recording module (Core Location + durable journal)
    maestro/         UI test flows
  api/               NestJS 11 modular monolith (PostgreSQL, Supabase Auth, S3)
packages/
  domain/            Entities, units, formatting, ids, time-zone bucketing
  gps-engine/        Geodesy, sample validation, filtering, route processing
  sports/            Sport definitions and policies (incl. triathlon legs)
  metrics-engine/    Pace/speed, splits, best efforts, analytics, records, goals
  activity-engine/   Recording state machine, session, replay, coordinator
  database/          Local SQLite schema, migrations, repositories
  formats/           GPX/TCX import, independent FIT decoder, ZIP/gzip archive reader, GPX/CSV export, privacy zones
  backup/            Versioned, checksummed, encrypted backup format
  sync/              Outbox sync engine and conflict rules
  validation/        Zod schemas for trust boundaries
  design-system/     Brand tokens and themes
  core/              Application services (import/export, backup/restore, analytics)
  import-validation/ Developer tooling: validates imports against real exports kept outside the repo (Node only)
infrastructure/      SQL migrations (cloud), Docker, docker-compose
docs/                PRD, architecture, database, GPS engine, API, security, testing, roadmap, decisions
```

## Requirements

| Tool | Version | Needed for |
|---|---|---|
| Node.js | 24 (≥ 22.13) | everything |
| pnpm | 12 (via `corepack enable`) | everything |
| macOS + Xcode 26 + CocoaPods | latest stable | building/running the iOS app |
| Physical iPhone (iOS 16.4+) | — | GPS and background validation |
| PostgreSQL 15+ / S3-compatible storage | — | running the API (docker-compose provided) |

Windows and Linux can develop and test everything except the native iOS build.

## Setup

```bash
corepack enable
pnpm install
pnpm build          # compile shared packages
pnpm test           # 137 tests: packages, mobile logic, API end-to-end (PGlite)
```

### Mobile app (macOS)

```bash
cp .env.example apps/mobile/.env      # keep only the EXPO_PUBLIC_* lines; fill in your values
cd apps/mobile
npx expo prebuild --platform ios
npx expo run:ios --device             # development build on a connected iPhone
```

Expo Go is **not** supported: the app ships a native tracking module. EAS alternatives:
`eas build --profile development --platform ios`.

### API

```bash
docker compose -f infrastructure/docker/docker-compose.yml up -d   # Postgres + MinIO
cp .env.example apps/api/.env                                      # keep the API lines
pnpm build:api
pnpm --filter @pace/api db:migrate
pnpm --filter @pace/api start                                      # http://localhost:3000/api/v1/health
```

### External services you must provide

1. **Supabase project** (Auth). Enable email confirmations, add redirect URLs
   `pace://auth/callback` and `pace://auth/reset-password`.
2. **Map tile provider** with a MapLibre style URL and a licence that permits your usage.
3. **S3-compatible bucket** for encrypted cloud backups (optional).

## Scripts

| Command | What it does |
|---|---|
| `pnpm build` | Build all shared packages (TypeScript project references) |
| `pnpm typecheck` | Packages, API and mobile type-checks |
| `pnpm lint` / `pnpm format` | ESLint / Prettier |
| `pnpm test` | All automated tests |
| `pnpm test:unit` | Packages + mobile logic only |
| `pnpm test:api` | API end-to-end tests |
| `pnpm validate:fit <folder>` | Validate FIT/GPX/TCX/ZIP import against your own exports outside the repository ([guide](docs/REAL_DEVICE_VALIDATION_GUIDE.md)) |

## Documentation

[PRD](docs/PRD.md) · [Architecture](docs/ARCHITECTURE.md) · [Database](docs/DATABASE.md) ·
[GPS engine](docs/GPS_ENGINE.md) · [API](docs/API.md) · [Security](docs/SECURITY.md) ·
[Design system](docs/DESIGN_SYSTEM.md) · [Testing](docs/TESTING.md) · [Roadmap](docs/ROADMAP.md) ·
[Decisions](docs/DECISIONS.md) · [Import validation](docs/IMPORT_VALIDATION.md) ·
[M4.7 release readiness](docs/M4_7_RELEASE_READINESS.md)
