import { defineConfig, devices } from '@playwright/test';
import { E1_API, E1_API_ENV, E1_FAKE_ENV, E1_FAKE_URL, E1_WEB } from './e2e/e1-env';

/** E2E tegen de echte app: API (fixtures) en Vite op eigen poorten, zodat ze niet botsen met andere stukken. */
const API = Number(process.env.HZ_E2E_API_PORT ?? 8780);
const WEB = Number(process.env.HZ_E2E_WEB_PORT ?? 8781);

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${WEB}`, trace: 'retain-on-failure' },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } }],
  webServer: [
    {
      command: 'node_modules/.bin/tsx apps/api/src/index.ts',
      url: `http://127.0.0.1:${API}/api/health`,
      env: {
        HZ_API_PORT: String(API),
        HZ_FIXTURE_SET: 'demo',
        HZ_STORE: 'memory',
        NODE_ENV: 'development',
        HZ_CONTEXT_EXPORT: '',
      },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `apps/web/node_modules/.bin/vite --config apps/web/vite.config.ts apps/web --port ${WEB} --strictPort`,
      url: `http://127.0.0.1:${WEB}/`,
      env: { HZ_API_PORT: String(API), HZ_WEB_PORT: String(WEB) },
      reuseExistingServer: false,
      timeout: 30_000,
    },
    // Stuk E1: nep-autorisatieserver, API met Google-inloggen en OAuth per bron, en een eigen web-server.
    {
      command: 'node_modules/.bin/tsx packages/fake-oauth/src/cli.ts',
      url: `${E1_FAKE_URL}/google/.well-known/openid-configuration`,
      env: E1_FAKE_ENV,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'node_modules/.bin/tsx apps/api/src/index.ts',
      url: `http://127.0.0.1:${E1_API}/api/health`,
      env: E1_API_ENV,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `apps/web/node_modules/.bin/vite --config apps/web/vite.config.ts apps/web --port ${E1_WEB} --strictPort`,
      url: `http://127.0.0.1:${E1_WEB}/`,
      env: { HZ_API_PORT: String(E1_API), HZ_WEB_PORT: String(E1_WEB) },
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
