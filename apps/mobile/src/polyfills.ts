import 'react-native-url-polyfill/auto';
import { getRandomValues } from 'expo-crypto';

// Shared packages (UUIDs, @noble crypto) use the Web Crypto CSPRNG. Provide it from the
// platform's secure random generator (SecRandomCopyBytes on iOS) via expo-crypto.
const g = globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } };
if (!g.crypto) g.crypto = {};
if (!g.crypto.getRandomValues) {
  g.crypto.getRandomValues = (array: Uint8Array) => getRandomValues(array);
}
