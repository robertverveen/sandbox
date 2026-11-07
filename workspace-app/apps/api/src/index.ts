/** Start de API: `pnpm --filter @hz/api dev`. Poort HZ_API_PORT (standaard 8700). */
import { serve } from '@hono/node-server';
import { createDb, dbSyncStore, dbTokenStore, disconnectSource, parseMasterKey } from '@hz/db';
import { installOps } from '@hz/ops';
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

// Live koppelingen (stuk E3): tokens per collega uit Postgres (versleuteld), cursors in sync_state.
const syncDb = config.HZ_STORE === 'db' && config.DATABASE_URL ? createDb(config.DATABASE_URL, 4) : null;
let creds: LiveCredentials | undefined;
const tokens = syncDb && config.HZ_TOKEN_KEY ? dbTokenStore(syncDb.db, parseMasterKey(config.HZ_TOKEN_KEY)) : null;
if (tokens) creds = createUserCredentials({ store: tokens, clients: oauthClientsFromEnv(process.env) });
/**
 * Ontkoppelen: intrekken bij Google of Slack, daarna het versleutelde token en de sync-data wissen (ook als intrekken
 * mislukt). Een Google-bron zonder eigen rij gebruikt de gedeelde koppeling 'google'; Google trekt dan alles in.
 */
const masterKey = config.HZ_TOKEN_KEY ? parseMasterKey(config.HZ_TOKEN_KEY) : null;
const revoke = syncDb
  ? (userId: string, provider: string) =>
      disconnectSource(syncDb.db, masterKey, userId, provider, (p, t) => revokeToken(p, t))
  : undefined;
const bundle = createProviders(process.env, creds, syncDb ? { store: dbSyncStore(syncDb.db, currentUserId) } : {});
const store: AppStore =
  config.HZ_STORE === 'db'
    ? new DbStore(config.DATABASE_URL!, config.HZ_AUTH_DATABASE_URL)
    : new MemoryStore(bundle.dataset);
const bus = new EventBus();
const { app } = createApp({
  config,
  bundle,
  store,
  bus,
  sync: {
    db: syncDb?.db ?? null,
    slackSigningSecret: process.env.HZ_SLACK_SIGNING_SECRET,
    slackAppToken: process.env.HZ_SLACK_APP_TOKEN,
    hookSecret: process.env.HZ_HOOK_SECRET,
    revoke,
  },
});
const listener = syncDb ? await listenSyncEvents(config.DATABASE_URL!, bus).catch(() => null) : null;

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
  await listener?.close();
  await syncDb?.close();
  await store.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
