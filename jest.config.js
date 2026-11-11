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

module.exports = {
  projects: [packagesProject],
  collectCoverageFrom: ['packages/*/src/**/*.ts', '!**/*.test.ts', '!**/test-fixtures/**'],
};
