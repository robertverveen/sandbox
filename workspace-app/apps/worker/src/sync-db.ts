/**
 * De sync-motor op Postgres: planning (sync_jobs), events, tokens (connections, versleuteld) en cursors
 * (sync_state). Elke collega onder RLS; de planner ziet alleen planning ('system').
 */
import pg from 'pg';
import type PgBoss from 'pg-boss';
import {
  SYNC_CHANNEL,
  connectedProviders,
  dbSyncStore,
  dbTokenStore,
  dueSyncJobs,
  ensureSyncJobs,
  finishSync,
  hookToken,
  getSyncJob,
  markSyncRunning,
  notifyUser,
  pruneSyncEvents,
  syncUsers,
  takeSyncEvents,
  type Db,
} from '@hz/db';
import {
  createProviders,
  createUserCredentials,
  currentUserId,
  oauthClientsFromEnv,
  type ProviderEnv,
} from '@hz/providers';
import { SYNC_QUEUES, runSync, type SyncDeps, type SyncRepo } from './sync';

export function dbSyncRepo(db: Db, masterKey: Buffer): SyncRepo {
  const tokens = dbTokenStore(db, masterKey);
  return {
    getJob: (u, p) => getSyncJob(db, u, p),
    markRunning: (u, p, now) => markSyncRunning(db, u, p, now),
    finish: (u, p, o, now) => finishSync(db, u, p, o, now),
    takeEvents: (u, s) => takeSyncEvents(db, u, s),
    notify: (u, keys) => notifyUser(db, u, keys),
    markReauth: (u, p, r) => tokens.markReauth(u, p, r),
  };
}

/** HMAC voor Agenda-kanalen: de webhook controleert X-Goog-Channel-Token hiermee. */
export const channelToken = (secret: string) => (channelId: string) => hookToken(secret, `calendar:${channelId}`);

export interface SyncRuntimeOptions {
  db: Db;
  masterKey: Buffer;
  env: ProviderEnv;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: (m: string) => void;
}

/** Providers met tokens en cursors uit Postgres, per collega via de scope. */
export function createSyncDeps(o: SyncRuntimeOptions): SyncDeps {
  const store = dbSyncStore(o.db, currentUserId);
  const creds = createUserCredentials({
    store: dbTokenStore(o.db, o.masterKey),
    clients: oauthClientsFromEnv(o.env),
    fetchImpl: o.fetchImpl,
  });
  const bundle = createProviders(o.env, creds, { store, fetchImpl: o.fetchImpl });
  return {
    repo: dbSyncRepo(o.db, o.masterKey),
    providers: bundle.providers,
    store,
    now: o.now,
    log: o.log,
    publicUrl: o.env.HZ_PUBLIC_URL,
    gmailTopic: o.env.HZ_GMAIL_PUBSUB_TOPIC,
    channelToken: o.env.HZ_HOOK_SECRET ? channelToken(o.env.HZ_HOOK_SECRET) : undefined,
  };
}

/**
 * Eén gedeelde Google-koppeling ('google', incrementele toestemming) wordt per bron gesynchroniseerd op basis van de
 * verleende scopes; andere koppelingen zijn één bron.
 */
export function expandConnection(c: { provider: string; account: string | null; scopes?: string[] | null }) {
  if (c.provider !== 'google') return [{ provider: c.provider, account: c.account }];
  const sc = (c.scopes ?? []).join(' ');
  const out: Array<{ provider: string; account: string | null }> = [];
  if (/auth\/calendar/.test(sc)) out.push({ provider: 'calendar', account: c.account });
  if (/auth\/tasks/.test(sc)) out.push({ provider: 'google_tasks', account: c.account });
  if (/auth\/gmail/.test(sc)) out.push({ provider: 'gmail', account: c.account });
  return out;
}

/** Planner: planningsrijen bijwerken uit de koppelingen en wat aan de beurt is als job versturen. */
export async function planSync(db: Db, boss: Pick<PgBoss, 'send'>, now?: Date) {
  for (const userId of await syncUsers(db)) {
    const conns = await connectedProviders(db, userId);
    await ensureSyncJobs(
      db,
      userId,
      conns.filter((c) => c.status === 'connected').flatMap((c) => expandConnection(c)),
    );
  }
  const due = await dueSyncJobs(db, now ?? new Date());
  for (const j of due) await sendRun(boss, j.userId, j.provider);
  await pruneSyncEvents(db);
  return due.length;
}

export const sendRun = (boss: Pick<PgBoss, 'send'>, userId: string, provider: string) =>
  boss.send(SYNC_QUEUES.run, { userId, provider }, { singletonKey: `${userId}:${provider}`, retryLimit: 0 });

/** Registreer de sync-queues in pg-boss; LISTEN hz_sync voor push (run binnen seconden, niet pas bij de planner). */
export async function registerSync(
  boss: PgBoss,
  deps: SyncDeps,
  db: Db,
  connectionString: string,
  opts: { cron?: string | null } = {},
) {
  await boss.createQueue(SYNC_QUEUES.plan, { name: SYNC_QUEUES.plan, retryLimit: 0, expireInSeconds: 120 });
  await boss.createQueue(SYNC_QUEUES.run, { name: SYNC_QUEUES.run, retryLimit: 0, expireInSeconds: 300 });
  await boss.work(SYNC_QUEUES.plan, async () => {
    await planSync(db, boss);
  });
  await boss.work<{ userId: string; provider: string }>(SYNC_QUEUES.run, { batchSize: 1 }, async ([job]) => {
    if (!job) return;
    return runSync(deps, job.data.userId, job.data.provider);
  });
  if (opts.cron !== null) await boss.schedule(SYNC_QUEUES.plan, opts.cron ?? '* * * * *');
  const listener = new pg.Client({ connectionString });
  await listener.connect();
  listener.on('notification', (n) => {
    if (n.channel !== SYNC_CHANNEL || !n.payload) return;
    try {
      const { userId, provider } = JSON.parse(n.payload) as { userId: string; provider: string };
      void sendRun(boss, userId, provider);
    } catch {
      /* ongeldige melding: negeren */
    }
  });
  await listener.query(`LISTEN ${SYNC_CHANNEL}`);
  return { stop: () => listener.end() };
}
