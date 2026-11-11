// Expo's default Metro config detects the pnpm workspace and watches packages/* automatically.
// Workspace packages expose TypeScript sources through the "react-native" export condition.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

module.exports = config;
