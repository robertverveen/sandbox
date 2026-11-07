/**
 * Datatoegang voor de sync-motor (HZW-036, stuk E3). Tabellen in drizzle/0005_e3_sync.sql.
 *
 * - sync_state: SyncStore per collega (cursors, metadata-cache), altijd via withUser (RLS).
 * - sync_jobs: planning per collega en bron. De worker plant met withPurpose('system'); dat ziet alleen
 *   planning (tijden, fouttellers), nooit tokens of inhoud.
 * - sync_events: push-events ontdubbelen (Slack event_id, Gmail messageId, Agenda kanaal + berichtnummer).
 * - pg_notify('hz_events', …): de worker meldt nieuwe data; de API zet dat om in SSE `invalidate`.
 */
import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withPurpose, withUser, type Db } from './client';
import { sealToken } from './crypto';
import { readConnectionToken } from './repo';

export const EVENTS_CHANNEL = 'hz_events';
export const SYNC_CHANNEL = 'hz_sync';

type Row = Record<string, unknown>;
const rows = <T>(r: { rows: unknown[] }) => r.rows as T[];

/** SyncStore op Postgres (zelfde vorm als SyncStore in @hz/providers). */
export function dbSyncStore(db: Db, userId: () => string | undefined) {
  const who = () => {
    const u = userId();
    if (!u) throw new Error('sync_state: geen collega in de scope');
    return u;
  };
  return {
    async get<T>(key: string): Promise<T | null> {
      const u = who();
      const r = await withUser(db, u, (tx) => tx.execute(sql`select value from sync_state where key = ${key}`));
      return (rows<{ value: T }>(r)[0]?.value ?? null) as T | null;
    },
    async set<T>(key: string, value: T): Promise<void> {
      const u = who();
      await withUser(db, u, (tx) =>
        tx.execute(sql`insert into sync_state (user_id, key, value, updated_at)
          values (${u}, ${key}, ${JSON.stringify(value)}::jsonb, now())
          on conflict (user_id, key) do update set value = excluded.value, updated_at = now()`),
      );
    },
    async del(key: string): Promise<void> {
      const u = who();
      await withUser(db, u, (tx) => tx.execute(sql`delete from sync_state where key = ${key}`));
    },
  };
}

/**
 * TokenStore op `connections` (envelope-versleuteld). Verversen werkt alleen de versleutelde velden bij;
 * scopes en account blijven staan. 401 of geweigerd verversen: koppeling en sync op needs_reauth.
 */
export function dbTokenStore(db: Db, masterKey: Buffer) {
  return {
    load: (userId: string, provider: string) => readConnectionToken(db, masterKey, userId, provider),
    async save(userId: string, provider: string, token: string) {
      const s = sealToken(token, masterKey, userId, provider);
      await withUser(db, userId, (tx) =>
        tx.execute(sql`update connections set token_ciphertext = ${s.tokenCiphertext}, token_iv = ${s.tokenIv},
          token_tag = ${s.tokenTag}, dek_wrapped = ${s.dekWrapped}, key_version = ${s.keyVersion}, error = null
          where provider = ${provider}`),
      );
    },
    /** Ontkoppelen: versleuteld token weg (de rij blijft met status disconnected). */
    async clear(userId: string, provider: string) {
      await withUser(db, userId, async (tx) => {
        await tx.execute(sql`update connections set token_ciphertext = null, token_iv = null, token_tag = null, dek_wrapped = null,
          status = 'disconnected' where provider = ${provider}`);
        await tx.execute(
          sql`insert into audit_log (user_id, action, target) values (${userId}, 'connection.token_cleared', ${provider})`,
        );
      });
    },
    async markReauth(userId: string, provider: string, reason: string) {
      await withUser(db, userId, async (tx) => {
        await tx.execute(
          sql`update connections set status = 'needs_reauth', error = ${'opnieuw koppelen: ' + reason.slice(0, 80)} where provider = ${provider}`,
        );
        await tx.execute(
          sql`update sync_jobs set status = 'needs_reauth', last_error = 'token afgewezen' where provider = ${provider}`,
        );
        await tx.execute(
          sql`insert into audit_log (user_id, action, target) values (${userId}, 'connection.needs_reauth', ${provider})`,
        );
      });
    },
  };
}

export interface SyncJobRow {
  userId: string;
  provider: string;
  account: string | null;
  status: 'idle' | 'running' | 'backoff' | 'error' | 'needs_reauth' | 'disconnected';
  failures: number;
  nextRunAt: Date;
  lastRunAt: Date | null;
  lastOkAt: Date | null;
  lastChanged: number;
  lastError: string | null;
  push: Record<string, unknown>;
}
const toJob = (r: Row): SyncJobRow => ({
  userId: String(r.user_id),
  provider: String(r.provider),
  account: (r.account as string | null) ?? null,
  status: r.status as SyncJobRow['status'],
  failures: Number(r.failures),
  nextRunAt: new Date(r.next_run_at as string),
  lastRunAt: r.last_run_at ? new Date(r.last_run_at as string) : null,
  lastOkAt: r.last_ok_at ? new Date(r.last_ok_at as string) : null,
  lastChanged: Number(r.last_changed),
  lastError: (r.last_error as string | null) ?? null,
  push: (r.push as Record<string, unknown>) ?? {},
});

/** Collega's die gesynchroniseerd mogen worden (niet geblokkeerd). */
export async function syncUsers(db: Db): Promise<string[]> {
  const r = await withPurpose(db, 'system', (tx) => tx.execute(sql`select id from users where blocked_at is null`));
  return rows<{ id: string }>(r).map((x) => x.id);
}

/** Gekoppelde bronnen van één collega (eigen transactie, RLS). */
export async function connectedProviders(db: Db, userId: string) {
  const r = await withUser(db, userId, (tx) =>
    tx.execute(sql`select provider, status, account from connections where token_ciphertext is not null`),
  );
  return rows<{ provider: string; status: string; account: string | null }>(r);
}

/** Zorg dat er een planningsrij is per gekoppelde bron; ontkoppelde bronnen gaan eruit. */
export async function ensureSyncJobs(
  db: Db,
  userId: string,
  providers: Array<{ provider: string; account?: string | null }>,
) {
  await withUser(db, userId, async (tx) => {
    for (const p of providers)
      await tx.execute(sql`insert into sync_jobs (user_id, provider, account) values (${userId}, ${p.provider}, ${p.account ?? null})
        on conflict (user_id, provider) do update set account = coalesce(excluded.account, sync_jobs.account),
          status = case when sync_jobs.status = 'disconnected' then 'idle' else sync_jobs.status end`);
    const keep = providers.map((p) => p.provider);
    await tx.execute(
      keep.length
        ? sql`delete from sync_jobs where provider not in (${sql.join(
            keep.map((k) => sql`${k}`),
            sql`, `,
          )})`
        : sql`delete from sync_jobs`,
    );
  });
}

/** Runs die aan de beurt zijn (of die langer dan staleMs op 'running' staan). */
export async function dueSyncJobs(db: Db, now: Date, limit = 50, staleMs = 10 * 60_000): Promise<SyncJobRow[]> {
  const r = await withPurpose(db, 'system', (tx) =>
    tx.execute(sql`select * from sync_jobs
      where (status not in ('needs_reauth', 'disconnected', 'running') and next_run_at <= ${now.toISOString()})
         or (status = 'running' and last_run_at < ${new Date(+now - staleMs).toISOString()})
      order by next_run_at limit ${limit}`),
  );
  return rows<Row>(r).map(toJob);
}

export async function getSyncJob(db: Db, userId: string, provider: string): Promise<SyncJobRow | null> {
  const r = await withUser(db, userId, (tx) => tx.execute(sql`select * from sync_jobs where provider = ${provider}`));
  const x = rows<Row>(r)[0];
  return x ? toJob(x) : null;
}

export async function syncStatus(db: Db, userId: string): Promise<SyncJobRow[]> {
  const r = await withUser(db, userId, (tx) => tx.execute(sql`select * from sync_jobs order by provider`));
  return rows<Row>(r).map(toJob);
}

export async function markSyncRunning(db: Db, userId: string, provider: string, now: Date) {
  await withUser(db, userId, (tx) =>
    tx.execute(
      sql`update sync_jobs set status = 'running', last_run_at = ${now.toISOString()} where provider = ${provider}`,
    ),
  );
}

export interface SyncOutcome {
  status: SyncJobRow['status'];
  failures: number;
  nextRunAt: Date;
  changed?: number;
  ok?: boolean;
  error?: string | null;
  push?: Record<string, unknown>;
}

export async function finishSync(db: Db, userId: string, provider: string, o: SyncOutcome, now: Date) {
  await withUser(db, userId, (tx) =>
    tx.execute(sql`update sync_jobs set status = ${o.status}, failures = ${o.failures}, next_run_at = ${o.nextRunAt.toISOString()},
      last_changed = ${o.changed ?? 0}, last_error = ${o.error ?? null},
      last_ok_at = case when ${!!o.ok} then ${now.toISOString()}::timestamptz else last_ok_at end,
      push = coalesce(${o.push ? JSON.stringify(o.push) : null}::jsonb, push)
      where provider = ${provider}`),
  );
}

/** Push of klik: run zo snel mogelijk (webhook zonder ingelogde collega gebruikt 'system'). */
export async function requestSync(db: Db, userId: string, provider: string, now = new Date()) {
  await withPurpose(db, 'system', (tx) =>
    tx.execute(sql`update sync_jobs set next_run_at = ${now.toISOString()},
      status = case when status in ('error', 'backoff') then status else 'idle' end
      where user_id = ${userId} and provider = ${provider} and status not in ('needs_reauth', 'disconnected')`),
  );
  await notifySync(db, userId, provider);
}

/** Welke collega hoort bij dit externe account (Slack-gebruiker, Google-adres)? */
export async function userByAccount(db: Db, provider: string, account: string): Promise<string | null> {
  const r = await withPurpose(db, 'system', (tx) =>
    tx.execute(
      sql`select user_id from sync_jobs where provider = ${provider} and lower(account) = lower(${account}) limit 1`,
    ),
  );
  return rows<{ user_id: string }>(r)[0]?.user_id ?? null;
}

/** Collega bij een push-kanaal (Agenda): kanaal-id staat in sync_jobs.push.channels. */
export async function userByChannel(db: Db, provider: string, channelId: string): Promise<string | null> {
  const r = await withPurpose(db, 'system', (tx) =>
    tx.execute(
      sql`select user_id from sync_jobs where provider = ${provider} and push -> 'channels' ? ${channelId} limit 1`,
    ),
  );
  return rows<{ user_id: string }>(r)[0]?.user_id ?? null;
}

/** Event bewaren als het nieuw is. false = dubbel (al eerder ontvangen): negeren. */
export async function recordSyncEvent(
  db: Db,
  source: string,
  eventId: string,
  userId: string | null,
  payload: Record<string, unknown> = {},
) {
  const r = await withPurpose(db, 'system', (tx) =>
    tx.execute(sql`insert into sync_events (source, event_id, user_id, payload) values (${source}, ${eventId}, ${userId}, ${JSON.stringify(payload)}::jsonb)
      on conflict (source, event_id) do nothing returning event_id`),
  );
  return rows(r).length === 1;
}

/** Onverwerkte events van een collega ophalen en als verwerkt markeren (in één transactie). */
export async function takeSyncEvents(db: Db, userId: string, source: string) {
  const r = await withUser(db, userId, (tx) =>
    tx.execute(sql`update sync_events set processed_at = now()
      where user_id = ${userId} and source = ${source} and processed_at is null
      returning event_id, payload, received_at`),
  );
  return rows<{ event_id: string; payload: Record<string, unknown>; received_at: string }>(r).sort((a, b) =>
    String(a.received_at).localeCompare(String(b.received_at)),
  );
}

export async function pruneSyncEvents(db: Db, olderThanDays = 7) {
  await withPurpose(db, 'system', (tx) =>
    tx.execute(sql`delete from sync_events where received_at < now() - make_interval(days => ${olderThanDays})`),
  );
}

/** Sleutelvoorvoegsels in sync_state per bron (ontkoppelen wist die data). */
export const SYNC_PREFIX: Record<string, string> = {
  calendar: 'calendar:',
  google_tasks: 'tasks:',
  gmail: 'gmail:',
  slack: 'slack:',
  jira: 'jira:',
  wispr: 'wispr:',
  github: 'github:',
};

/** Ontkoppelen: planning, cursors en metadata van die bron weg. */
export async function wipeSyncData(db: Db, userId: string, provider: string) {
  const prefix = SYNC_PREFIX[provider] ?? `${provider}:`;
  await withUser(db, userId, async (tx) => {
    await tx.execute(sql`delete from sync_state where key like ${prefix + '%'}`);
    await tx.execute(sql`delete from sync_jobs where provider = ${provider}`);
    await tx.execute(sql`delete from sync_events where user_id = ${userId} and source like ${provider + '%'}`);
  });
}

/** Nieuwe data voor een collega: de API maakt er SSE `invalidate` van. */
export async function notifyUser(db: Db, userId: string, keys: string[]) {
  await db.execute(sql`select pg_notify(${EVENTS_CHANNEL}, ${JSON.stringify({ userId, keys })})`);
}

/** Webhook -> worker: deze run nu graag. */
export async function notifySync(db: Db, userId: string, provider: string) {
  await db.execute(sql`select pg_notify(${SYNC_CHANNEL}, ${JSON.stringify({ userId, provider })})`);
}

/** Token voor een webhook (Agenda-kanaal, Gmail Pub/Sub): HMAC van het doel met HZ_HOOK_SECRET. */
export function hookToken(secret: string, scope: string): string {
  return createHmac('sha256', secret).update(`hz-hook:${scope}`).digest('base64url');
}
