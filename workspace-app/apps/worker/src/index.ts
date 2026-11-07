/**
 * Start de worker: `pnpm --filter @hz/worker dev`.
 * - DATABASE_URL: app-tabellen via createDb() als hz_app (productie: de worker-login, sql/worker-login.sql; lid van
 *   hz_app en hz_worker, niet de login van de api);
 * - HZ_BOSS_DATABASE_URL: pg-boss in een eigen schema met een eigen login hz_boss (sql/boss-login.sql; productie
 *   verplicht en nooit de migratierol: de worker weigert dan te starten; lokaal = DATABASE_URL).
 */
import { createProviders } from '@hz/providers';
import { DEFAULT_DATABASE_URL, ensureDatabase, parseMasterKey } from '@hz/db';
import { startWorker } from './worker';

const url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const bossUrl = process.env.HZ_BOSS_DATABASE_URL ?? (process.env.NODE_ENV === 'production' ? '' : url);
if (!bossUrl) {
  console.error('[worker] HZ_BOSS_DATABASE_URL ontbreekt: in productie draait pg-boss met een eigen login en schema.');
  process.exit(1);
}
if (process.env.NODE_ENV !== 'production') await ensureDatabase(url);
// Sync-motor alleen met een hoofdsleutel (tokens zijn versleuteld) en minstens één live bron (stuk E3).
const liveOn = Object.keys(process.env).some((k) => k.startsWith('HZ_LIVE_') && process.env[k] === '1');
const sync =
  process.env.HZ_TOKEN_KEY && liveOn
    ? { masterKey: parseMasterKey(process.env.HZ_TOKEN_KEY), env: process.env }
    : undefined;
const w = await startWorker({
  connectionString: bossUrl,
  databaseUrl: url,
  schema: process.env.HZ_BOSS_SCHEMA ?? 'pgboss',
  bundle: createProviders(process.env),
  sync,
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

// Beheer (HZW-007): foutregistratie, JSON-logs zonder persoonsgegevens en een hartslag voor de Docker-healthcheck.
const { installOps, startHeartbeat } = await import('@hz/ops');
installOps({ service: 'worker' });
startHeartbeat(process.env.HZ_WORKER_HEARTBEAT);
