import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils';
import type { SqlDriver } from '@pace/database';
import * as SecureStore from 'expo-secure-store';
import { strFromU8 } from 'fflate';

const KEY_NAME = 'pace.storage-key.v1';
const OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

async function storageKey(): Promise<Uint8Array> {
  const existing = await SecureStore.getItemAsync(KEY_NAME, OPTS);
  if (existing) return hexToBytes(existing);
  const key = randomBytes(32);
  await SecureStore.setItemAsync(KEY_NAME, bytesToHex(key), OPTS);
  return key;
}

/**
 * Encrypted key-value storage for values too large for the Keychain (e.g. auth sessions).
 * The 256-bit key lives in the iOS Keychain (this device only); ciphertext lives in SQLite.
 */
export class EncryptedKeyValueStore {
  private keyPromise: Promise<Uint8Array> | null = null;
  constructor(private readonly db: SqlDriver) {}

  private key(): Promise<Uint8Array> {
    this.keyPromise ??= storageKey();
    return this.keyPromise;
  }

  async getItem(name: string): Promise<string | null> {
    const row = await this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
      `secure:${name}`,
    ]);
    if (!row) return null;
    try {
      const { n, c } = JSON.parse(row.value) as { n: string; c: string };
      const plain = xchacha20poly1305(await this.key(), hexToBytes(n)).decrypt(hexToBytes(c));
      return strFromU8(plain);
    } catch {
      // Undecryptable (e.g. restored onto another device): treat as absent rather than crash.
      await this.removeItem(name);
      return null;
    }
  }

  async setItem(name: string, value: string): Promise<void> {
    const nonce = randomBytes(24);
    const c = xchacha20poly1305(await this.key(), nonce).encrypt(utf8ToBytes(value));
    await this.db.run(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      [`secure:${name}`, JSON.stringify({ n: bytesToHex(nonce), c: bytesToHex(c) }), Date.now()],
    );
  }

  async removeItem(name: string): Promise<void> {
    await this.db.run('DELETE FROM settings WHERE key = ?', [`secure:${name}`]);
  }
}

/** Keychain helpers for small secrets (backup recovery key). */
export const keychain = {
  get: (name: string) => SecureStore.getItemAsync(name, OPTS),
  set: (name: string, value: string) => SecureStore.setItemAsync(name, value, OPTS),
  remove: (name: string) => SecureStore.deleteItemAsync(name, OPTS),
};
