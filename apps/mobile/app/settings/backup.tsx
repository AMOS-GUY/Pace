import type { BackupDocument } from '@pace/backup';
import { isEncryptedBackup, readEncryptedHeader } from '@pace/backup';
import * as DocumentPicker from 'expo-document-picker';
import { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Text } from '@/components/Text';
import { Banner, Card, ListRow, LoadingState, Screen, SectionHeader } from '@/components/layout';
import { formatDateTime } from '@/features/display';
import { useInvalidateAll } from '@/hooks/queries';
import { isApiConfigured } from '@/services/api';
import {
  type CloudBackup,
  deleteCloudBackup,
  downloadCloudBackup,
  getOrCreateRecoveryKey,
  listCloudBackups,
  readFileBytes,
  setRecoveryKey,
  shareBytes,
  uploadCloudBackup,
} from '@/services/backup-files';
import { getServices } from '@/services/container';
import { usePreferences } from '@/stores/preferences';
import { useTheme } from '@/theme/ThemeProvider';
import { parseRecoveryKey } from '@pace/backup';

export default function BackupSettings() {
  const { spacing } = useTheme();
  const invalidate = useInvalidateAll();
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    tone: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);
  const [cloud, setCloud] = useState<CloudBackup[] | null>(null);
  const [recoveryInput, setRecoveryInput] = useState('');
  const cloudEnabled = isApiConfigured();

  const guard = async (label: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(label);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  };

  const refreshCloud = useCallback(() => {
    if (!cloudEnabled) return;
    listCloudBackups()
      .then(setCloud)
      .catch((e: unknown) =>
        setMessage({ tone: 'error', text: e instanceof Error ? e.message : String(e) }),
      );
  }, [cloudEnabled]);
  useEffect(refreshCloud, [refreshCloud]);

  const applyRestore = async (doc: BackupDocument): Promise<void> => {
    const { backup } = await getServices();
    const report = await backup.restore(doc);
    await invalidate();
    // Restored preferences and profile take effect without restarting the app.
    if (report.settingsRestored.length > 0) await usePreferences.getState().load();
    setMessage({
      tone: report.failed.length ? 'error' : 'success',
      text:
        `Restored ${report.restored} activit${report.restored === 1 ? 'y' : 'ies'}; ${report.skippedExisting} already on this phone were kept.` +
        (report.failed.length
          ? ` ${report.failed.length} could not be restored: ${report.failed[0]!.reason}`
          : ''),
    });
  };

  const createLocal = (): Promise<void> =>
    guard('local', async () => {
      if (passphrase.length < 12)
        throw new Error('Use a passphrase of at least 12 characters to encrypt the file.');
      const { backup } = await getServices();
      const { bytes, document } = await backup.createBackup({ kind: 'passphrase', passphrase });
      await shareBytes(
        `pace-backup-${new Date().toISOString().slice(0, 10)}.pacebackup`,
        bytes,
        'application/octet-stream',
      );
      setMessage({
        tone: 'success',
        text: `Backup of ${document.counts.activities} activities created. Keep the passphrase — it cannot be recovered.`,
      });
    });

  const restoreLocal = (): Promise<void> =>
    guard('restore', async () => {
      const pick = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
      });
      if (pick.canceled || !pick.assets[0]) return;
      const bytes = await readFileBytes(pick.assets[0].uri);
      const { backup } = await getServices();
      let key = null;
      if (isEncryptedBackup(bytes)) {
        const header = readEncryptedHeader(bytes);
        if (header.kdf.name === 'raw')
          key = { kind: 'raw' as const, key: (await getOrCreateRecoveryKey()).key };
        else {
          if (passphrase.length < 12)
            throw new Error('Enter the backup passphrase above, then choose the file again.');
          key = { kind: 'passphrase' as const, passphrase };
        }
      }
      await applyRestore(backup.open(bytes, key));
    });

  const showRecoveryKey = (): Promise<void> =>
    guard('key', async () => {
      const { formatted } = await getOrCreateRecoveryKey();
      Alert.alert(
        'Your recovery key',
        `${formatted}\n\nStore it somewhere safe (e.g. a password manager). You need it to restore cloud backups on a new iPhone.`,
      );
    });

  return (
    <Screen edges={[]}>
      {message ? <Banner tone={message.tone} message={message.text} /> : null}

      <SectionHeader title="Backup file" />
      <Card>
        <Text variant="bodySmall" color="secondary" style={{ marginBottom: spacing.md }}>
          Creates an encrypted file with all your activities, routes and goals. Save it to Files,
          iCloud Drive or send it to your computer. Restoring never overwrites activities already on
          this phone.
        </Text>
        <Input
          label="Passphrase"
          value={passphrase}
          onChangeText={setPassphrase}
          secureTextEntry
          hint="At least 12 characters. Needed to restore."
        />
        <Button
          label="Create backup file"
          icon="archive-outline"
          onPress={() => void createLocal()}
          loading={busy === 'local'}
        />
        <Button
          label="Restore from file"
          variant="secondary"
          onPress={() => void restoreLocal()}
          loading={busy === 'restore'}
          style={{ marginTop: spacing.md }}
        />
      </Card>

      <SectionHeader title="PACE Cloud" />
      {!cloudEnabled ? (
        <Card>
          <Text variant="bodySmall" color="secondary">
            Cloud backup is not configured in this build (EXPO_PUBLIC_API_URL is not set).
          </Text>
        </Card>
      ) : (
        <Card>
          <Text variant="bodySmall" color="secondary" style={{ marginBottom: spacing.md }}>
            Encrypted on this phone with your recovery key before upload; PACE servers only ever
            store ciphertext.
          </Text>
          <Button
            label="Back up now"
            icon="cloud-upload-outline"
            loading={busy === 'cloud'}
            onPress={() =>
              void guard('cloud', async () => {
                const b = await uploadCloudBackup();
                setMessage({
                  tone: 'success',
                  text: `Cloud backup saved (${Math.round(b.sizeBytes / 1024)} KB).`,
                });
                refreshCloud();
              })
            }
          />
          <ListRow
            icon="key-outline"
            label="Show recovery key"
            onPress={() => void showRecoveryKey()}
          />
          {cloud == null ? <LoadingState /> : null}
          {cloud
            ?.filter((b) => b.status === 'complete')
            .map((b) => (
              <ListRow
                key={b.id}
                label={formatDateTime(Date.parse(b.createdAt))}
                value={`${Math.round(b.sizeBytes / 1024)} KB`}
                onPress={() =>
                  Alert.alert(
                    'Cloud backup',
                    'Restore adds missing activities to this phone. Delete removes the backup from PACE Cloud.',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Restore',
                        onPress: () =>
                          void guard('restore', async () => {
                            const bytes = await downloadCloudBackup(b.id);
                            const { backup } = await getServices();
                            await applyRestore(
                              backup.open(bytes, {
                                kind: 'raw',
                                key: (await getOrCreateRecoveryKey()).key,
                              }),
                            );
                          }),
                      },
                      {
                        text: 'Delete',
                        style: 'destructive',
                        onPress: () =>
                          void guard('delete', async () => {
                            await deleteCloudBackup(b.id);
                            refreshCloud();
                          }),
                      },
                    ],
                  )
                }
              />
            ))}
          <Input
            label="Use a recovery key from another phone"
            value={recoveryInput}
            onChangeText={setRecoveryInput}
            autoCapitalize="characters"
            placeholder="XXXXXXXX-XXXXXXXX-…"
          />
          <Button
            label="Save recovery key"
            variant="secondary"
            onPress={() =>
              void guard('key', async () => {
                parseRecoveryKey(recoveryInput);
                await setRecoveryKey(recoveryInput);
                setRecoveryInput('');
                setMessage({
                  tone: 'success',
                  text: 'Recovery key saved to this iPhone’s Keychain.',
                });
              })
            }
          />
        </Card>
      )}
    </Screen>
  );
}
