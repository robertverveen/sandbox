/** Start de API: `pnpm --filter @hz/api dev`. Poort HZ_API_PORT (standaard 8700). */
import { serve } from '@hono/node-server';
import { createDb, dbSyncStore, dbTokenStore, parseMasterKey } from '@hz/db';
import {
  createProviders,
  createUserCredentials,
  currentUserId,
  oauthClientsFromEnv,
  revokeToken,
  type LiveCredentials,
} from '@hz/providers';
import { createApp } from './app';
import { EventBus } from './events';
import { listenSyncEvents } from './sync-hooks';
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

// Live koppelingen (stuk E3): tokens per collega uit Postgres (versleuteld), cursors in sync_state.
const syncDb = config.HZ_STORE === 'db' && config.DATABASE_URL ? createDb(config.DATABASE_URL, 4) : null;
let creds: LiveCredentials | undefined;
const tokens = syncDb && config.HZ_TOKEN_KEY ? dbTokenStore(syncDb.db, parseMasterKey(config.HZ_TOKEN_KEY)) : null;
if (tokens) creds = createUserCredentials({ store: tokens, clients: oauthClientsFromEnv(process.env) });
/** Ontkoppelen: intrekken bij Google of Slack, daarna het versleutelde token wissen (ook als intrekken mislukt). */
const revoke = tokens
  ? async (userId: string, provider: string) => {
      const t = await tokens.load(userId, provider).catch(() => null);
      if (t) await revokeToken(provider, t);
      await tokens.clear(userId, provider);
    }
  : undefined;
const bundle = createProviders(process.env, creds, syncDb ? { store: dbSyncStore(syncDb.db, currentUserId) } : {});
const store: AppStore = config.HZ_STORE === 'db' ? new DbStore(config.DATABASE_URL!) : new MemoryStore(bundle.dataset);
const bus = new EventBus();
const { app } = createApp({
  config,
  bundle,
  store,
  bus,
  sync: {
    db: syncDb?.db ?? null,
    slackSigningSecret: process.env.HZ_SLACK_SIGNING_SECRET,
    hookSecret: process.env.HZ_HOOK_SECRET,
    revoke,
  },
});
const listener = syncDb ? await listenSyncEvents(config.DATABASE_URL!, bus).catch(() => null) : null;

const server = serve({ fetch: app.fetch, port: config.HZ_API_PORT, hostname: '127.0.0.1' }, (info) => {
  console.log(
    `[api] http://127.0.0.1:${info.port} · fixtures=${bundle.info.fixtureSet} · context=${bundle.info.contextSource} · store=${store.kind}` +
      (bundle.info.live.length ? ` · live=${bundle.info.live.join(',')}` : ''),
  );
});

const stop = async () => {
  server.close();
  await listener?.close();
  await syncDb?.close();
  await store.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
