import { defineConfig } from 'vitest/config';

// Infra-tests draaien echte scripts, Postgres en builds: ruime tijdslimieten.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Superuser voor de Postgres-tests, en na afloop alle hz_e0_*-rollen weer weg (rollen zijn clusterbreed).
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 180_000,
    hookTimeout: 240_000,
  },
});
