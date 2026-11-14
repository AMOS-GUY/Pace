# Encrypted backup format

A PACE backup is one gzip-compressed JSON document. Cloud backups, and local ones with a
passphrase or recovery key, wrap it in an authenticated encryption container.

```
plain:      "PACEBK" 0x01 | gzip(JSON document)
encrypted:  "PACEBK" 0x81 | u32 header length | header JSON | XChaCha20-Poly1305(plain backup)
```

- **Encryption:** a key from a passphrase (scrypt) or a 32-byte recovery key. The container
  header (cipher, KDF parameters, nonce) is authenticated as associated data. Container
  version `v: 1` is unchanged.
- **Document format:** what is inside the container. `formatVersion` 1 or 2.

## Format versions

| | Version 1 | **Version 2** (current) |
|---|---|---|
| Written by | PACE builds up to commit `5747af8` | PACE builds from `feature/backup-v2` on |
| Activities, raw GPS samples, recording events (pauses, laps, legs), laps, goals | ✅ | ✅ (unchanged) |
| **Sensor samples** (heart rate, cadence, power) | ❌ not included | ✅ every stored sample |
| Settings | Every row on the device except three names, **including the encrypted auth-session rows (`secure:*`)** | Only the portable allowlist: `preferences`, `profile` |
| Integrity checks | Schema and payload SHA-256 | Schema, payload SHA-256, counts match contents, every sensor sample belongs to an activity in the backup |
| Read by | All PACE builds | Builds with backup format 2 only. Older builds refuse it: "Backup was created by a newer version of PACE". |

**No database migration is needed.** Version 2 uses the existing `sensor_samples` and
`settings` tables.

The app version (`0.1.0`) has not been bumped. When a release includes backup format 2, its
version number is the minimum needed to restore version-2 backups. Record it here.

## What version 2 preserves

**Sensor samples:** every row of `sensor_samples` for every backed-up activity.

| Field | In the backup | Restored as |
|---|---|---|
| Activity | `activityId` | the same activity |
| Type | `heart_rate`, `cadence`, `power` | same |
| Value | the stored number, unrounded (e.g. 87.5 rpm, 0 W) | same |
| Unit | `bpm`, `rpm`, `W` (must match the type) | same |
| Time | `recordedAt` (epoch ms) | same |
| Source device | `sourceDeviceId` or null | same |
| Order | the order they were stored (rowid) | same order |

- **Nothing is added or resampled.** Missing values stay missing, sparse streams stay sparse,
  zeros stay zeros, and an activity with no sensors has none after restore.
- **New row IDs:** row IDs are newly generated, because they are not data.

**Settings:**

| Key | Backed up | Restored | Validation |
|---|---|---|---|
| `preferences` (units, privacy zone, auto-pause, last sport, pool length) | ✅ | ✅ replaces the device's value | Known fields checked; unknown fields from newer builds dropped |
| `profile` (display name, preferred sports, height, weight) | ✅ | ✅ replaces the device's value | Checked |
| `secure:*` (encrypted auth session, from the encrypted key-value store) | ❌ | **never**, not even from version-1 backups that contain it | — |
| `onboarding.completed`, sync and backup bookkeeping, anything else | ❌ | never | — |

A setting that fails validation is ignored and counted in the restore report
(`settingsIgnored`). Restore reloads preferences in the app straight away.

## Restore behaviour (both versions)

- **Additive:** activities already on the device are kept as they are, and are not overwritten.
- **Atomic per activity:**
  - each activity is written in one transaction: activity row, GPS points, events and sensor
    samples, then the derived data (laps, splits, records);
  - if anything fails, none of that activity is written, and the other activities still restore.
- **Version 1:**
  - read as version 1, never as version 2: it restores without sensor samples, because it has
    none;
  - its portable settings are applied under the same allowlist; its `secure:*` rows are
    ignored.
- **Goals and settings:** each is written in one transaction, after the activities. If writing
  them fails, the failure is reported in `otherFailures` (not thrown), the activities already
  restored are kept, and restoring the same backup again completes it. A restore of several
  activities is therefore not all-or-nothing as a whole, by design: it is additive and safe to
  repeat.
- **Report:** `formatVersion`, activities `restored`, `skippedExisting` and `failed`,
  `goalsRestored`, `sensorSamplesRestored`, `settingsRestored`, `settingsIgnored` and
  `otherFailures`.
- **In the app:** the restore message states the backup version, says when an older backup has
  no heart rate, cadence or power (as a warning), and explains kept activities, replaced
  settings and any failure.

## Security

- **Decompression is capped** at 512 MB of JSON, counted while decompressing. A small file that
  expands without limit (a "zip bomb") is refused. Version 1 parsing had no such cap. The
  compressed file is still capped at 512 MB.
- **Strict format detection:**
  - a missing, non-integer or non-positive `formatVersion` is invalid;
  - a version newer than the build is refused as unsupported;
  - both versions are strict: a field the build does not know (in the document, its counts or
    its payload) is refused, never silently dropped;
  - so a version-2 backup relabelled as version 1 is refused, not stripped of its sensor
    samples, and a version-1 backup relabelled as version 2 fails the version-2 schema;
  - empty files, empty or non-object JSON and deeply nested JSON (200,000 levels, tested in
    Node) are refused as invalid without crashing.
- **Validated at creation:** a backup that restore would refuse is never written. Backup creation
  validates the document with the same schema and fails instead.
- **Unchanged:** encryption (XChaCha20-Poly1305 with an authenticated header), scrypt parameter
  bounds, and the passphrase minimum.
- **Not applicable:** a backup is a single document, not an archive, so there are no entries,
  paths or duplicate entries to validate.

Tests: `packages/core/src/backup-v2.test.ts` and `packages/backup/src/backup.test.ts`. The genuine
version-1 backups in `packages/core/src/test-fixtures/v1-backups.ts` were written by the production
code at `5747af8`.

## Performance

Measured on **synthetic data, in Node on the development PC**. This is not iPhone performance,
and has not been measured on a device. Opt-in benchmark:
`PACE_PERF=1 npx jest packages/core/src/backup-perf.test.ts`.

| Scenario | GPS points | Sensor samples | Create (encrypted) | Size | Restore |
|---|---|---|---|---|---|
| 100 activities × 10 min | 60,100 | 180,300 | 9.1 s | 2.17 MB | 9.2 s |
| 1,000 activities × 1 min | 61,000 | 183,000 | 9.9 s | 1.29 MB | 12.5 s |
| 1 activity × 4 h, 1 Hz | 14,401 | 43,203 | 2.9 s | 0.53 MB | 2.5 s |
| 5 activities × 2 h, 1 Hz | 36,005 | 108,015 | 6.1 s | 1.32 MB | 4.9 s |

- **Memory risk:** backups are built and read entirely in memory. Restore grew the Node heap by
  roughly 60–200 MB in these runs; the heap figures are approximate, because garbage collection
  ran during measurement. Very large histories are a memory risk on a phone; streaming is not
  implemented.

