/**
 * Start de worker: `pnpm --filter @hz/worker dev`.
 * - DATABASE_URL: app-tabellen via createDb() als hz_app (productie: de worker-login, sql/worker-login.sql; lid van
 *   hz_app en hz_worker, niet de login van de api);
 * - HZ_BOSS_DATABASE_URL: pg-boss in een eigen schema met een eigen login hz_boss (sql/boss-login.sql; productie
 *   verplicht en nooit de migratierol: de worker weigert dan te starten; lokaal = DATABASE_URL).
 */
import { createProviders } from '@hz/providers';
import { DEFAULT_DATABASE_URL, ensureDatabase } from '@hz/db';
import { startWorker } from './worker';

const url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const bossUrl = process.env.HZ_BOSS_DATABASE_URL ?? (process.env.NODE_ENV === 'production' ? '' : url);
if (!bossUrl) {
  console.error('[worker] HZ_BOSS_DATABASE_URL ontbreekt: in productie draait pg-boss met een eigen login en schema.');
  process.exit(1);
}
if (process.env.NODE_ENV !== 'production') await ensureDatabase(url);
const w = await startWorker({
  connectionString: bossUrl,
  databaseUrl: url,
  schema: process.env.HZ_BOSS_SCHEMA ?? 'pgboss',
  bundle: createProviders(process.env),
}).catch((e: Error) => {
  console.error(`[worker] start geweigerd: ${e.message}`);
  process.exit(1);
});
await w.send({});
console.log('[worker] gestart; voorbeeldjob context.tel-acties verstuurd');
const stop = async () => {
  await w.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
