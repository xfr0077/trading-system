/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^better-sqlite3$': '<rootDir>/tests/__mocks__/better-sqlite3.ts',
    '^@wezzcoetzee/grvt$': '<rootDir>/tests/__mocks__/grvt.ts',
  },
};
