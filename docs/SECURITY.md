# Security & privacy

## Authentication and authorisation

- Supabase Auth (email + password, email verification, password reset via PKCE deep links).
- The app ships only the **publishable** key. The **service-role key exists only on the API**
  and is used solely to delete auth users on account deletion.
- The API verifies every access token: signature (project JWKS for ES256/RS256, or the legacy
  HS256 secret), issuer `<SUPABASE_URL>/auth/v1`, audience `authenticated`, expiry (30 s
  tolerance), UUID subject and `authenticated` role. Tests cover forged, expired, wrong-issuer and
  wrong-audience tokens.
- Every cloud query filters by the token's user id; a foreign activity id returns `id_conflict`
  without data.

## Data at rest

| Data | Protection |
|---|---|
| SQLite database | iOS Data Protection (app sandbox, default class) |
| Auth session | XChaCha20-Poly1305 ciphertext in SQLite; 256-bit key in the Keychain (`AfterFirstUnlockThisDeviceOnly`) |
| Native GPS journal | `completeUntilFirstUserAuthentication` (must be writable while the phone is locked during an activity) |
| Backup recovery key | Keychain, this device only |
| Cloud backups | Encrypted on device before upload; server stores ciphertext + SHA-256 only |

## Backup encryption

Reviewed primitives only: `@noble/ciphers` XChaCha20-Poly1305 (AEAD) and `@noble/hashes` scrypt /
SHA-256 (both independently audited). Container header (format version, KDF parameters, nonce) is
bound as associated data, so tampering fails authentication. Two key modes:

1. **Passphrase** (local files): scrypt N=2¹⁶, r=8, p=1, 16-byte random salt, ≥ 12 characters.
   Attacker-supplied KDF parameters are bounded on restore (DoS protection).
2. **Recovery key** (cloud): random 256-bit key in the Keychain, shown to the user as 64 hex
   characters for safekeeping. Losing both the device and the recovery key means the cloud backup
   cannot be decrypted — by design, PACE cannot read it either.

Plain (unencrypted) backups are never uploaded; the API rejects `encrypted: false`.

## Input handling

- GPX and TCX: size (25 MB) and point (200 000) limits; DOCTYPE/ENTITY declarations refused
  (prevents entity-expansion attacks); every point and sensor value validated; XML-escaped on
  export.
- Archives (ZIP, gzip): streamed, never extracted to disk; entry names are never used as paths
  and names with `..`, absolute paths or control characters are refused; limits apply to bytes
  actually decompressed (25 MB per file, 2 GB per archive, 50 000 entries, 4 GB read), which stops
  ZIP bombs regardless of the sizes an archive claims; nested archives are not opened.
- gzip (`.gz` files and `.gz` entries): the gzip header, CRC-32 and length trailer are verified,
  so a damaged or cut-off file is refused instead of being passed on as a shorter file.
- FIT: read by PACE's own decoder (D22). Input limited to 25 MB and 2 000 000 messages, at most 64
  chained files and 200 000 GPS points. Every chained file is framed and its header and file
  checksums verified before any message is decoded, so a damaged or truncated file imports
  nothing; every read is bounds-checked; malformed structure (undefined messages, messages past
  the end, unknown byte order, zero-size fields, trailing data) is refused; values are at most 255
  bytes and no allocation depends on an unchecked length. Device serial numbers are never stored;
  developer field names from the file are stripped of control characters and shortened before
  they are shown.
- CSV export neutralises spreadsheet formula injection.
- Backups: magic header, size limit (512 MB), schema validation, checksum, version check.
- Native → JS samples are validated with Zod before use.
- SQL is always parameterised; search terms escape LIKE wildcards.

## Location privacy

- Location is requested progressively ("While Using"; "Always" only if the user opts in) with
  explanations before the system prompt.
- No location collection outside a recording; the iOS indicator is visible while recording.
- No live location sharing. Diagnostics and logs never contain coordinates.
- Export privacy zone trims route start/end in shared GPX files, single or in the full export;
  the full export contains coordinates only in its GPX files.
- The full export includes only allow-listed settings (profile, preferences); credentials and
  keys stay in the Keychain, and account/sync identifiers, devices and the sync queue are left
  out.

## Secrets

- `.env` files are git-ignored; `.env.example` has placeholders only.
- No secrets in `app.config.ts` `extra` beyond public values.

## Before commercial launch (open items)

- Independent security review / penetration test of the API.
- Privacy policy, terms of service, data retention and deletion procedure, health-data disclosure
  (when HealthKit ships), App Store privacy labels (a privacy manifest is already declared).
- Sentry (or equivalent) with PII scrubbing; certificate pinning decision.
- Key rotation procedure for the local storage key and Supabase signing keys.
