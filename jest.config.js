/** @type {import('jest').Config} */
const packagesProject = {
  displayName: 'packages',
  testEnvironment: 'node',
  roots: ['<rootDir>/packages'],
  testMatch: ['**/src/**/*.test.ts'],
  transform: {
    '^.+\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
  moduleNameMapper: {
    '^@pace/([a-z-]+)$': '<rootDir>/packages/$1/src/index.ts',
  },
};

/** Pure logic of the mobile app (no React Native runtime needed). UI tests run via Maestro. */
const mobileLogicProject = {
  displayName: 'mobile-logic',
  testEnvironment: 'node',
  roots: ['<rootDir>/apps/mobile/src', '<rootDir>/apps/mobile/modules'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
  moduleNameMapper: {
    '^@pace/([a-z-]+)$': '<rootDir>/packages/$1/src/index.ts',
    '^@/(.*)$': '<rootDir>/apps/mobile/src/$1',
  },
};

module.exports = {
  projects: [packagesProject, mobileLogicProject],
  collectCoverageFrom: ['packages/*/src/**/*.ts', '!**/*.test.ts', '!**/test-fixtures/**'],
};
