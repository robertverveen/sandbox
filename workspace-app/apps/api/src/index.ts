/** Start de API: `pnpm --filter @hz/api dev`. Poort HZ_API_PORT (standaard 8700). */
import { serve } from '@hono/node-server';
import { createProviders } from '@hz/providers';
import { createApp } from './app';
import { ConfigError, loadConfig } from './config';
import { DbStore, MemoryStore, type AppStore } from './store';

let config;
try {
  config = loadConfig();
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`[api] ${e.message}`);
    process.exit(1);
  }
  throw e;
}

const bundle = createProviders(process.env);
const store: AppStore = config.HZ_STORE === 'db' ? new DbStore(config.DATABASE_URL!) : new MemoryStore(bundle.dataset);
const { app } = createApp({ config, bundle, store });

const server = serve({ fetch: app.fetch, port: config.HZ_API_PORT, hostname: '127.0.0.1' }, (info) => {
  console.log(
    `[api] http://127.0.0.1:${info.port} · fixtures=${bundle.info.fixtureSet} · context=${bundle.info.contextSource} · store=${store.kind}` +
      (bundle.info.live.length ? ` · live=${bundle.info.live.join(',')}` : ''),
  );
});

const stop = async () => {
  server.close();
  await store.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
