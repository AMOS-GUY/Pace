import { formatRecoveryKey, generateBackupKey, parseRecoveryKey } from '@pace/backup';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import { File, Paths } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';
import * as Sharing from 'expo-sharing';
import { api } from './api';
import { getServices } from './container';
import { keychain } from './secure-storage';

const RECOVERY_KEY = 'pace.backup.recovery-key.v1';

/** Writes bytes to a cache file and opens the share sheet. */
export async function shareBytes(
  fileName: string,
  bytes: Uint8Array | string,
  mimeType: string,
): Promise<void> {
  const file = new File(Paths.cache, fileName);
  if (file.exists) file.delete();
  file.create();
  file.write(bytes);
  if (!(await Sharing.isAvailableAsync()))
    throw new Error('Sharing is not available on this device');
  await Sharing.shareAsync(file.uri, { mimeType });
}

export async function readFileBytes(uri: string): Promise<Uint8Array> {
  return new File(uri).bytes();
}

/**
 * Cloud backups are always encrypted on the device with a 256-bit recovery key held in the
 * Keychain. The server stores ciphertext only and can never read activity data. The user is
 * shown the recovery key once and must keep it to restore on a new phone.
 */
export async function getOrCreateRecoveryKey(): Promise<{
  key: Uint8Array;
  formatted: string;
  created: boolean;
}> {
  const existing = await keychain.get(RECOVERY_KEY);
  if (existing) {
    const key = parseRecoveryKey(existing);
    return { key, formatted: formatRecoveryKey(key), created: false };
  }
  const key = generateBackupKey();
  const formatted = formatRecoveryKey(key);
  await keychain.set(RECOVERY_KEY, formatted);
  return { key, formatted, created: true };
}

export async function setRecoveryKey(formatted: string): Promise<void> {
  parseRecoveryKey(formatted); // validates
  await keychain.set(RECOVERY_KEY, formatted.trim().toUpperCase());
}

export interface CloudBackup {
  id: string;
  createdAt: string;
  sizeBytes: number;
  checksumSha256: string;
  formatVersion: number;
  status: 'pending' | 'complete';
}

export async function uploadCloudBackup(): Promise<CloudBackup> {
  const { backup } = await getServices();
  const { key } = await getOrCreateRecoveryKey();
  const { bytes } = await backup.createBackup({ kind: 'raw', key });
  const checksumSha256 = bytesToHex(sha256(bytes));
  const created = await api<{ backup: CloudBackup; uploadUrl: string }>('/backups', {
    method: 'POST',
    body: { sizeBytes: bytes.length, checksumSha256, formatVersion: 1, encrypted: true },
    idempotencyKey: checksumSha256,
  });
  const body = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const put = await expoFetch(created.uploadUrl, {
    method: 'PUT',
    body,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  if (!put.ok) throw new Error(`Upload failed (${put.status})`);
  return (
    await api<{ backup: CloudBackup }>(`/backups/${created.backup.id}/complete`, { method: 'POST' })
  ).backup;
}

export async function listCloudBackups(): Promise<CloudBackup[]> {
  return (await api<{ items: CloudBackup[] }>('/backups')).items;
}

export async function downloadCloudBackup(id: string): Promise<Uint8Array> {
  const { downloadUrl, backup } = await api<{ downloadUrl: string; backup: CloudBackup }>(
    `/backups/${id}`,
  );
  const res = await expoFetch(downloadUrl);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytesToHex(sha256(bytes)) !== backup.checksumSha256)
    throw new Error('Downloaded backup is corrupted (checksum mismatch)');
  return bytes;
}

export async function deleteCloudBackup(id: string): Promise<void> {
  await api(`/backups/${id}`, { method: 'DELETE' });
}
