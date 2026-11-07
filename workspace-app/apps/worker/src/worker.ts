/**
 * pg-boss-worker: jobs in dezelfde Postgres (geen Redis), met herhaalpogingen en tijdslimieten.
 * Jobs die per collega werken zetten zelf withUser(...) zodat RLS ook in de worker geldt.
 */
import PgBoss from 'pg-boss';
import type { ProviderBundle } from '@hz/providers';
import { createDb } from '@hz/db';
import { QUEUES, telActies, type TelActiesInput } from './jobs';
import { createSyncDeps, registerSync, type SyncRuntimeOptions } from './sync-db';

export interface WorkerOptions {
  connectionString: string;
  schema?: string;
  bundle: ProviderBundle;
  log?: (msg: string) => void;
  /** Sync-motor (HZW-036) aan: hoofdsleutel voor tokens en omgeving (HZ_LIVE_*, OAuth-clients). */
  sync?: Omit<SyncRuntimeOptions, 'db'> & { cron?: string | null };
}

export async function startWorker(opts: WorkerOptions) {
  const log = opts.log ?? ((m: string) => console.log(`[worker] ${m}`));
  const boss = new PgBoss({ connectionString: opts.connectionString, schema: opts.schema ?? 'pgboss' });
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
  let syncStop: (() => Promise<void>) | null = null;
  if (opts.sync) {
    const { db, close } = createDb(opts.connectionString, 4);
    const deps = createSyncDeps({ ...opts.sync, db, log: opts.sync.log ?? log });
    const r = await registerSync(boss, deps, db, opts.connectionString, { cron: opts.sync.cron });
    syncStop = async () => {
      await r.stop();
      await close();
    };
    log('sync-motor gestart');
  }
  return {
    boss,
    send: (input: TelActiesInput = {}) => boss.send(QUEUES.telActies, input),
    stop: async () => {
      await boss.stop({ graceful: true, wait: true });
      await syncStop?.();
    },
  };
}
