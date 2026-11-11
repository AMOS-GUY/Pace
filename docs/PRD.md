# PACE — Product Requirements (summary)

The complete approved master specification (v1.0) is the governing document; this file
summarises it and records how requirements map to the implementation.

## Vision

An affordable, privacy-conscious, technically dependable endurance-sports platform: reliable
recording, meaningful analytics, and full data ownership. Basic recording and export are never
paywalled; no ads in the recording experience.

## Platforms

iOS first (iPhone). Android and Apple Watch are later milestones; shared code is platform-neutral.

## Sports

Running, cycling, walking, hiking (GPS); swimming (pool: manual lengths; open water: GPS with an
explicit limitation notice); triathlon (one activity, five legs).

## Requirement → implementation map

| Area | Where |
|---|---|
| Authentication, profile, units | `apps/mobile/app/(auth)`, `(onboarding)`, `src/services/auth.ts`; API `profiles` |
| Recording lifecycle & state machine | `packages/activity-engine` |
| GPS engine | `packages/gps-engine`, `apps/mobile/modules/pace-tracking` |
| Sport rules, records, auto-pause | `packages/sports` |
| Metrics, splits, analytics, PRs, goals | `packages/metrics-engine`, `packages/core` |
| History, detail, maps | `apps/mobile/app/(tabs)/activities.tsx`, `app/activity/[id].tsx`, `RouteMap` |
| GPX/CSV/JSON backup | `packages/formats`, `packages/backup`, `packages/core` |
| Local storage | `packages/database` |
| Sync & cloud | `packages/sync`, `apps/api` |
| Design system | `packages/design-system`, `apps/mobile/src/components` |

## Non-goals for MVP

Social feeds, followers, leaderboards, messaging, challenges, Apple Watch app, Android app, AI
coaching, subscription management, public route discovery.

## Monetisation (configurable, no prices in code)

PACE Free (recording, history, basic analytics, GPX, manual backup) · PACE Pro (advanced
analytics/plans) · PACE Cloud (automatic backup, multi-device). Entitlements are served by
`GET /entitlements` from configuration; expiring plans never block access to existing data.
