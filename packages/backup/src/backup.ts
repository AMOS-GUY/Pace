import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { scrypt } from '@noble/hashes/scrypt';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, randomBytes, utf8ToBytes } from '@noble/hashes/utils';
import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate';
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  type BackupDocument,
  type BackupPayload,
  backupDocumentSchema,
} from './format';

export class BackupError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid_format'
      | 'checksum_mismatch'
      | 'decryption_failed'
      | 'unsupported_version'
      | 'too_large',
  ) {
    super(message);
  }
}

/** Plain backup magic: "PACEBK" + format byte 0x01 (plain gzip JSON). */
const MAGIC_PLAIN = new Uint8Array([0x50, 0x41, 0x43, 0x45, 0x42, 0x4b, 0x01]);
/** Encrypted backup magic: "PACEBK" + format byte 0x81 (encrypted container). */
const MAGIC_ENCRYPTED = new Uint8Array([0x50, 0x41, 0x43, 0x45, 0x42, 0x4b, 0x81]);
const MAX_BACKUP_BYTES = 512 * 1024 * 1024;

/**
 * Canonical JSON: object keys sorted recursively, so the checksum does not depend on property
 * order (validation libraries may rebuild objects in schema order).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function payloadChecksum(payload: BackupPayload): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalJson(payload))));
}

export function createBackupDocument(
  payload: BackupPayload,
  meta: { createdAt: number; appVersion: string; schemaVersion: number },
): BackupDocument {
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: meta.createdAt,
    appVersion: meta.appVersion,
    schemaVersion: meta.schemaVersion,
    counts: {
      activities: payload.activities.length,
      samples: payload.samples.length,
      events: payload.events.length,
    },
    payloadSha256: payloadChecksum(payload),
    payload,
  };
}

function startsWith(bytes: Uint8Array, magic: Uint8Array): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) return false;
  return true;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Unencrypted, compressed backup bytes (used for local export the user controls). */
export function serializeBackup(doc: BackupDocument): Uint8Array {
  return concat(MAGIC_PLAIN, gzipSync(strToU8(JSON.stringify(doc)), { level: 6 }));
}

/** Parses and fully validates a plain backup, including the payload checksum. */
export function parseBackup(bytes: Uint8Array): BackupDocument {
  if (bytes.length > MAX_BACKUP_BYTES)
    throw new BackupError('Backup file is too large', 'too_large');
  if (startsWith(bytes, MAGIC_ENCRYPTED))
    throw new BackupError('Backup is encrypted; a key is required', 'decryption_failed');
  if (!startsWith(bytes, MAGIC_PLAIN))
    throw new BackupError('Not a PACE backup file', 'invalid_format');
  let json: unknown;
  try {
    json = JSON.parse(strFromU8(gunzipSync(bytes.subarray(MAGIC_PLAIN.length))));
  } catch {
    throw new BackupError('Backup file is corrupted', 'invalid_format');
  }
  const header = json as { formatVersion?: unknown };
  if (typeof header.formatVersion === 'number' && header.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new BackupError('Backup was created by a newer version of PACE', 'unsupported_version');
  }
  const parsed = backupDocumentSchema.safeParse(json);
  if (!parsed.success)
    throw new BackupError(
      `Backup failed validation: ${parsed.error.issues[0]?.message ?? ''}`,
      'invalid_format',
    );
  if (payloadChecksum(parsed.data.payload) !== parsed.data.payloadSha256) {
    throw new BackupError('Backup checksum does not match its contents', 'checksum_mismatch');
  }
  return parsed.data;
}

// ============================================================================ encryption

export interface KdfParams {
  name: 'scrypt';
  N: number;
  r: number;
  p: number;
  saltB64: string;
}

interface EncryptedHeader {
  v: 1;
  cipher: 'xchacha20poly1305';
  /** 'scrypt' = passphrase-derived key; 'raw' = 32-byte key from secure storage. */
  kdf: KdfParams | { name: 'raw'; keyId: string };
  nonceB64: string;
}

/** Default scrypt cost: interactive-grade (≈64 MiB memory), acceptable on modern phones. */
export const DEFAULT_SCRYPT = { N: 2 ** 16, r: 8, p: 1 } as const;

export function deriveKeyFromPassphrase(
  passphrase: string,
  salt: Uint8Array,
  params: { N: number; r: number; p: number } = DEFAULT_SCRYPT,
): Uint8Array {
  if (passphrase.length < 12) throw new Error('Backup passphrase must be at least 12 characters');
  return scrypt(utf8ToBytes(passphrase.normalize('NFKC')), salt, { ...params, dkLen: 32 });
}

/** Non-secret identifier of a raw key, used to tell the user which recovery key a backup needs. */
export function keyFingerprint(key: Uint8Array): string {
  return bytesToHex(sha256(concat(utf8ToBytes('pace-backup-key-id:'), key))).slice(0, 16);
}

export function generateBackupKey(): Uint8Array {
  return randomBytes(32);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Self-contained RFC 4648 base64 (no reliance on platform btoa/atob/Buffer). */
const b64 = {
  encode(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
      out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
      out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '=';
      out += i + 2 < bytes.length ? B64[n & 63]! : '=';
    }
    return out;
  },
  decode(text: string): Uint8Array {
    const clean = text.replace(/=+$/, '');
    if (/[^A-Za-z0-9+/]/.test(clean))
      throw new BackupError('Corrupted backup header', 'invalid_format');
    const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let bits = 0;
    let value = 0;
    let o = 0;
    for (const ch of clean) {
      value = (value << 6) | B64.indexOf(ch);
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[o++] = (value >> bits) & 0xff;
      }
    }
    return out.subarray(0, o);
  },
};

/**
 * Authenticated encryption (XChaCha20-Poly1305, @noble/ciphers — audited). The header is bound
 * as associated data, so tampering with KDF parameters or nonce fails authentication.
 * Layout: MAGIC_ENCRYPTED | u32 header length (BE) | header JSON | ciphertext+tag.
 */
export function encryptBackup(
  plainBackup: Uint8Array,
  key:
    | { kind: 'passphrase'; passphrase: string; scrypt?: { N: number; r: number; p: number } }
    | { kind: 'raw'; key: Uint8Array },
): Uint8Array {
  const nonce = randomBytes(24);
  let k: Uint8Array;
  let kdf: EncryptedHeader['kdf'];
  if (key.kind === 'passphrase') {
    const salt = randomBytes(16);
    const params = key.scrypt ?? DEFAULT_SCRYPT;
    k = deriveKeyFromPassphrase(key.passphrase, salt, params);
    kdf = { name: 'scrypt', ...params, saltB64: b64.encode(salt) };
  } else {
    if (key.key.length !== 32) throw new Error('Backup key must be 32 bytes');
    k = key.key;
    kdf = { name: 'raw', keyId: keyFingerprint(key.key) };
  }
  const header: EncryptedHeader = {
    v: 1,
    cipher: 'xchacha20poly1305',
    kdf,
    nonceB64: b64.encode(nonce),
  };
  const headerBytes = utf8ToBytes(JSON.stringify(header));
  const ciphertext = xchacha20poly1305(k, nonce, headerBytes).encrypt(plainBackup);
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, headerBytes.length, false);
  return concat(MAGIC_ENCRYPTED, len, headerBytes, ciphertext);
}

export function isEncryptedBackup(bytes: Uint8Array): boolean {
  return startsWith(bytes, MAGIC_ENCRYPTED);
}

export function readEncryptedHeader(bytes: Uint8Array): EncryptedHeader {
  if (!isEncryptedBackup(bytes))
    throw new BackupError('Not an encrypted PACE backup', 'invalid_format');
  const len = new DataView(bytes.buffer, bytes.byteOffset + MAGIC_ENCRYPTED.length, 4).getUint32(
    0,
    false,
  );
  if (len > 4096 || MAGIC_ENCRYPTED.length + 4 + len > bytes.length)
    throw new BackupError('Corrupted backup header', 'invalid_format');
  const start = MAGIC_ENCRYPTED.length + 4;
  try {
    return JSON.parse(strFromU8(bytes.subarray(start, start + len))) as EncryptedHeader;
  } catch {
    throw new BackupError('Corrupted backup header', 'invalid_format');
  }
}

export function decryptBackup(
  bytes: Uint8Array,
  key: { kind: 'passphrase'; passphrase: string } | { kind: 'raw'; key: Uint8Array },
): Uint8Array {
  const header = readEncryptedHeader(bytes);
  if (header.v !== 1 || header.cipher !== 'xchacha20poly1305')
    throw new BackupError('Unsupported encryption', 'unsupported_version');
  const len = new DataView(bytes.buffer, bytes.byteOffset + MAGIC_ENCRYPTED.length, 4).getUint32(
    0,
    false,
  );
  const headerBytes = bytes.subarray(MAGIC_ENCRYPTED.length + 4, MAGIC_ENCRYPTED.length + 4 + len);
  const ciphertext = bytes.subarray(MAGIC_ENCRYPTED.length + 4 + len);
  let k: Uint8Array;
  if (header.kdf.name === 'scrypt') {
    if (key.kind !== 'passphrase')
      throw new BackupError('This backup needs its passphrase', 'decryption_failed');
    const { N, r, p } = header.kdf;
    // Bound attacker-controlled cost parameters to avoid denial of service on restore.
    if (N > 2 ** 20 || r > 16 || p > 4)
      throw new BackupError('Backup key parameters are out of range', 'invalid_format');
    k = deriveKeyFromPassphrase(key.passphrase, b64.decode(header.kdf.saltB64), { N, r, p });
  } else {
    if (key.kind !== 'raw')
      throw new BackupError('This backup needs its recovery key', 'decryption_failed');
    k = key.key;
  }
  try {
    return xchacha20poly1305(k, b64.decode(header.nonceB64), headerBytes).decrypt(ciphertext);
  } catch {
    throw new BackupError('Wrong key or the backup was modified', 'decryption_failed');
  }
}

/** Recovery key formatting: 32 bytes as 8 groups of base32-ish hex for the user to store. */
export function formatRecoveryKey(key: Uint8Array): string {
  return bytesToHex(key)
    .toUpperCase()
    .match(/.{1,8}/g)!
    .join('-');
}
export function parseRecoveryKey(text: string): Uint8Array {
  const hex = text.replace(/[^0-9a-fA-F]/g, '');
  if (hex.length !== 64) throw new Error('Recovery key must be 64 hexadecimal characters');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
