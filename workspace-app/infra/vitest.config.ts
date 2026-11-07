import { defineConfig } from 'vitest/config';

// Infra-tests draaien echte scripts, Postgres en builds: ruime tijdslimieten.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 240_000,
  },
});
