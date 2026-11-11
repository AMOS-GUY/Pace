/**
 * RFC 4122 version 4 UUID generation.
 *
 * Uses the platform CSPRNG (`globalThis.crypto.getRandomValues`). On React Native this
 * is provided by `expo-crypto` / `react-native-get-random-values`, installed by the app.
 */
export type RandomBytesSource = (length: number) => Uint8Array;

interface CryptoLike {
  getRandomValues?: (array: Uint8Array) => Uint8Array;
}

export const defaultRandomBytes: RandomBytesSource = (length) => {
  const c = (globalThis as { crypto?: CryptoLike }).crypto;
  if (!c?.getRandomValues) {
    throw new Error(
      'No cryptographically secure random source (crypto.getRandomValues) is available.',
    );
  }
  return c.getRandomValues(new Uint8Array(length));
};

export function uuidV4(random: RandomBytesSource = defaultRandomBytes): string {
  const b = random(16);
  if (b.length !== 16) throw new Error('Random source returned the wrong number of bytes.');
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
