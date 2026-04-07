module.exports = {
  preset: 'jest-expo',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  setupFilesAfterEnv: ['./jest-setup.js'],
  testPathIgnorePatterns: ['/node_modules/'],
  watchman: false,
};
