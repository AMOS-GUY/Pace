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
- **Report:** `formatVersion`, activities `restored`, `skippedExisting` and `failed`,
  `goalsRestored`, `sensorSamplesRestored`, `settingsRestored` and `settingsIgnored`.

## Security

- **Decompression is capped** at 512 MB of JSON, counted while decompressing. A small file that
  expands without limit (a "zip bomb") is refused. Version 1 parsing had no such cap. The
  compressed file is still capped at 512 MB.
- **Strict format detection:**
  - a missing, non-integer or non-positive `formatVersion` is invalid;
  - a version newer than the build is refused as unsupported;
  - version-1 payloads and counts are strict, so a version-2 backup relabelled as version 1 is
    refused, not silently stripped of its sensor samples;
  - a version-1 backup relabelled as version 2 fails the version-2 schema.
- **Validated at creation:** a backup that restore would refuse is never written. Backup creation
  validates the document with the same schema and fails instead.
- **Unchanged:** encryption (XChaCha20-Poly1305 with an authenticated header), scrypt parameter
  bounds, and the passphrase minimum.
- **Not applicable:** a backup is a single document, not an archive, so there are no entries,
  paths or duplicate entries to validate.

Tests: `packages/core/src/backup-v2.test.ts` and `packages/backup/src/backup.test.ts`. The genuine
version-1 backups in `packages/core/src/test-fixtures/v1-backups.ts` were written by the production
code at `5747af8`.
