/** Start de API: `pnpm --filter @hz/api dev`. Poort HZ_API_PORT (standaard 8700). */
import { serve } from '@hono/node-server';
import { installOps } from '@hz/ops';
import { createProviders } from '@hz/providers';
import { createApp } from './app';
import { ConfigError, loadConfig } from './config';
import { DbStore, MemoryStore, type AppStore } from './store';

// Foutregistratie en logs zonder persoonsgegevens (HZW-007); lokaal uit.
const ops = installOps({ service: 'api' });

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

// In een container luistert de API op alle interfaces (HZ_API_HOST=0.0.0.0); lokaal alleen op 127.0.0.1.
const hostname = process.env.HZ_API_HOST ?? '127.0.0.1';
const server = serve({ fetch: ops.wrapFetch(app.fetch), port: config.HZ_API_PORT, hostname }, (info) => {
  console.log(
    `[api] http://${hostname}:${info.port} · fixtures=${bundle.info.fixtureSet} · context=${bundle.info.contextSource} · store=${store.kind}` +
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
