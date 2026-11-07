/**
 * pg-boss-worker: jobs in dezelfde Postgres (geen Redis), met herhaalpogingen en tijdslimieten.
 *
 * Twee verbindingen (HZW-020, stuk E2):
 * - pg-boss draait in een eigen schema (standaard `pgboss`) met een eigen verbinding (`connectionString`); in
 *   productie de login hz_boss (sql/boss-login.sql), eigenaar van alleen dat schema. De worker weigert in productie
 *   een HZ_BOSS_DATABASE_URL waarvan de login eigenaar is van app-tabellen (checkBossConnection); hz_app heeft geen
 *   rechten op het schema;
 * - app-tabellen gaan via createDb() als hz_app (`databaseUrl`, in productie de app-login uit sql/app-login.sql).
 *   Jobs die per collega werken zetten zelf withUser(...), zodat RLS ook in de worker geldt.
 */
import PgBoss from 'pg-boss';
import { assertBossLoginAt, createDb } from '@hz/db';
import type { ProviderBundle } from '@hz/providers';
import { QUEUES, telActies, telWeekdoelen, type TelActiesInput } from './jobs';

export interface WorkerOptions {
  /** Verbinding voor pg-boss (eigen schema). Lokaal hz_dev; productie HZ_BOSS_DATABASE_URL. */
  connectionString: string;
  schema?: string;
  /** Verbinding voor app-tabellen via createDb() als hz_app. Standaard dezelfde URL als pg-boss (alleen lokaal). */
  databaseUrl?: string;
  bundle: ProviderBundle;
  log?: (msg: string) => void;
  /** Omgeving voor de productiecontrole (standaard process.env). */
  env?: Record<string, string | undefined>;
}

/**
 * Productiecontrole van de pg-boss-verbinding: de login mag eigenaar zijn van het eigen schema van pg-boss, maar
 * niet van app-tabellen (dus niet de migratierol), geen superuser en geen BYPASSRLS. Gooit UnsafeBossLoginError.
 */
export const checkBossConnection = (connectionString: string, schema: string) =>
  assertBossLoginAt(connectionString, schema);

export async function startWorker(opts: WorkerOptions) {
  const log = opts.log ?? ((m: string) => console.log(`[worker] ${m}`));
  const env = opts.env ?? process.env;
  const schema = opts.schema ?? 'pgboss';
  if (env.NODE_ENV === 'production') {
    if (!opts.databaseUrl || opts.databaseUrl === opts.connectionString)
      throw new Error(
        'worker: in productie zijn DATABASE_URL (app-login) en HZ_BOSS_DATABASE_URL (pg-boss) verschillend',
      );
    await checkBossConnection(opts.connectionString, schema);
  }
  // createDb() controleert in productie zelf de app-login (assertAppLogin) bij elke nieuwe verbinding.
  const app = createDb(opts.databaseUrl ?? opts.connectionString, 4, { env });
  const boss = new PgBoss({ connectionString: opts.connectionString, schema });
  boss.on('error', (e) => log(`fout: ${e.message}`));
  await boss.start();
  await boss.createQueue(QUEUES.telActies, {
    name: QUEUES.telActies,
    retryLimit: 3,
    retryDelay: 5,
    expireInSeconds: 60,
  });
  await boss.work<TelActiesInput>(QUEUES.telActies, async (jobs) => {
    const results = [];
    for (const job of jobs) {
      const r = await telActies(opts.bundle.providers.context, job.data ?? {});
      log(`${QUEUES.telActies}: ${r.open} open, ${r.overDatum} over datum`);
      results.push(r);
    }
    return results.length === 1 ? results[0] : results;
  });
  await boss.createQueue(QUEUES.telWeekdoelen, {
    name: QUEUES.telWeekdoelen,
    retryLimit: 3,
    retryDelay: 5,
    expireInSeconds: 60,
  });
  await boss.work(QUEUES.telWeekdoelen, async () => {
    const r = await telWeekdoelen(app.db);
    log(`${QUEUES.telWeekdoelen}: ${r.open} open bij ${r.gebruikers} collega's (als ${r.rol})`);
    return r;
  });
  return {
    boss,
    db: app.db,
    send: (input: TelActiesInput = {}) => boss.send(QUEUES.telActies, input),
    sendTelWeekdoelen: () => boss.send(QUEUES.telWeekdoelen, {}),
    stop: async () => {
      await boss.stop({ graceful: true, wait: true });
      await app.close();
    },
  };
}
