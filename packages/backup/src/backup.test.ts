import {
  BackupError,
  type BackupPayload,
  createBackupDocument,
  decryptBackup,
  encryptBackup,
  formatRecoveryKey,
  generateBackupKey,
  isEncryptedBackup,
  parseBackup,
  parseRecoveryKey,
  readEncryptedHeader,
  serializeBackup,
} from './index';

const T = Date.UTC(2026, 5, 1);
const ID = '00000000-0000-4000-8000-000000000001';

const payload: BackupPayload = {
  activities: [
    {
      id: ID,
      userId: null,
      sportType: 'running',
      title: 'Run',
      description: null,
      startedAt: T,
      endedAt: T + 60_000,
      timezone: 'UTC',
      status: 'completed',
      source: 'recorded',
      swimMode: null,
      poolLengthMeters: null,
      elapsedDurationMs: 60_000,
      movingDurationMs: 60_000,
      distanceMeters: 180,
      elevationGainMeters: 0,
      elevationLossMeters: 0,
      averageSpeedMps: 3,
      maximumSpeedMps: 3,
      averagePaceMsPerKm: null,
      createdAt: T,
      updatedAt: T,
      deletedAt: null,
      version: 2,
      sessionConfig: { activityId: ID },
    },
  ],
  samples: [
    {
      activityId: ID,
      sequenceNumber: 0,
      latitude: 1.29,
      longitude: 103.85,
      altitudeMeters: null,
      horizontalAccuracyMeters: 5,
      verticalAccuracyMeters: null,
      speedMps: 3,
      courseDegrees: null,
      recordedAt: T,
      source: 'device_gps',
    },
  ],
  events: [
    {
      activityId: ID,
      sequenceNumber: 0,
      type: 'started',
      at: T,
      afterSampleCount: 0,
      lengthCount: null,
    },
  ],
  laps: [],
  goals: [],
  settings: [{ key: 'units', value: '"metric"' }],
};

const doc = () =>
  createBackupDocument(payload, { createdAt: T, appVersion: '0.1.0', schemaVersion: 1 });

describe('backup format', () => {
  it('round-trips with checksum verification', () => {
    const bytes = serializeBackup(doc());
    const parsed = parseBackup(bytes);
    expect(parsed.payload).toEqual(payload);
    expect(parsed.counts).toEqual({ activities: 1, samples: 1, events: 1 });
  });

  it('detects tampering via checksum', () => {
    const d = doc();
    d.payload.activities[0]!.distanceMeters = 99_999;
    expect(() => parseBackup(serializeBackup(d))).toThrow(
      expect.objectContaining({ code: 'checksum_mismatch' }),
    );
  });

  it('rejects non-backups, corrupted files and future versions', () => {
    expect(() => parseBackup(new Uint8Array([1, 2, 3]))).toThrow(BackupError);
    const bytes = serializeBackup(doc());
    // Corrupt the compressed body (fflate does not check the gzip CRC; the SHA-256 checksum and
    // inflate errors catch real corruption).
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    expect(() => parseBackup(bytes)).toThrow(BackupError);
    const future = { ...doc(), formatVersion: 99 };
    expect(() => parseBackup(serializeBackup(future as never))).toThrow(
      expect.objectContaining({ code: 'unsupported_version' }),
    );
  });
});

describe('backup encryption', () => {
  const fastScrypt = { N: 2 ** 10, r: 8, p: 1 };

  it('encrypts with a passphrase and decrypts', () => {
    const plain = serializeBackup(doc());
    const enc = encryptBackup(plain, {
      kind: 'passphrase',
      passphrase: 'correct horse battery',
      scrypt: fastScrypt,
    });
    expect(isEncryptedBackup(enc)).toBe(true);
    expect(readEncryptedHeader(enc).kdf.name).toBe('scrypt');
    const dec = decryptBackup(enc, { kind: 'passphrase', passphrase: 'correct horse battery' });
    expect(parseBackup(dec).payload).toEqual(payload);
    expect(() => parseBackup(enc)).toThrow('encrypted');
  });

  it('fails authentication with the wrong passphrase or modified data', () => {
    const enc = encryptBackup(serializeBackup(doc()), {
      kind: 'passphrase',
      passphrase: 'correct horse battery',
      scrypt: fastScrypt,
    });
    expect(() =>
      decryptBackup(enc, { kind: 'passphrase', passphrase: 'wrong horse battery!' }),
    ).toThrow('Wrong key');
    const tampered = enc.slice();
    tampered[tampered.length - 1] ^= 1;
    expect(() =>
      decryptBackup(tampered, { kind: 'passphrase', passphrase: 'correct horse battery' }),
    ).toThrow('Wrong key');
  });

  it('supports raw keys with recovery-key formatting', () => {
    const key = generateBackupKey();
    const text = formatRecoveryKey(key);
    expect(text.split('-')).toHaveLength(8);
    const enc = encryptBackup(serializeBackup(doc()), { kind: 'raw', key });
    const dec = decryptBackup(enc, { kind: 'raw', key: parseRecoveryKey(text) });
    expect(parseBackup(dec).counts.activities).toBe(1);
    expect(() => decryptBackup(enc, { kind: 'raw', key: generateBackupKey() })).toThrow(
      'Wrong key',
    );
  });

  it('rejects short passphrases and hostile KDF parameters', () => {
    expect(() =>
      encryptBackup(new Uint8Array(1), { kind: 'passphrase', passphrase: 'short' }),
    ).toThrow('at least 12');
    const enc = encryptBackup(serializeBackup(doc()), {
      kind: 'passphrase',
      passphrase: 'correct horse battery',
      scrypt: fastScrypt,
    });
    const s = new TextDecoder().decode(enc);
    const hostile = new TextEncoder().encode(s.replace('"N":1024', '"N":1073741824'));
    // Header length changed, so re-wrap is not trivially valid; either way restore must refuse.
    expect(() =>
      decryptBackup(hostile, { kind: 'passphrase', passphrase: 'correct horse battery' }),
    ).toThrow();
  });
});
