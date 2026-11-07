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

/** Google-bronnen die één gedeelde koppeling 'google' kunnen gebruiken (één OAuth-client, K1). */
export const GOOGLE_SOURCES = ['calendar', 'google_tasks', 'gmail'] as const;
/** Welke verleende scope bij welke Google-bron hoort. */
export const GOOGLE_SCOPE: Record<(typeof GOOGLE_SOURCES)[number], RegExp> = {
  calendar: /auth\/calendar/,
  google_tasks: /auth\/tasks/,
  gmail: /auth\/gmail/,
};
const isGoogleSource = (p: string): p is (typeof GOOGLE_SOURCES)[number] =>
  (GOOGLE_SOURCES as readonly string[]).includes(p);

type Tx = Parameters<Parameters<typeof withUser>[2]>[0];

/**
 * De rij in `connections` die het token voor deze bron echt draagt: een eigen rij met token, anders (Google) de
 * gedeelde rij 'google'. Zonder token: de eigen naam (er valt dan niets in te trekken of af te keuren).
 */
async function tokenRow(tx: Tx, provider: string): Promise<string> {
  const r = await tx.execute(
    sql`select provider from connections where token_ciphertext is not null and provider in (${provider}, 'google')`,
  );
  const have = rows<{ provider: string }>(r).map((x) => x.provider);
  if (have.includes(provider)) return provider;
  if (isGoogleSource(provider) && have.includes('google')) return 'google';
  return provider;
}

/** Planningsrijen die aan een tokenrij hangen ('google' = alle Google-bronnen zonder eigen token). */
async function jobsOf(tx: Tx, row: string): Promise<string[]> {
  if (row !== 'google') return [row];
  const r = await tx.execute(sql`select provider from connections where token_ciphertext is not null`);
  const own = new Set(rows<{ provider: string }>(r).map((x) => x.provider));
  return GOOGLE_SOURCES.filter((g) => !own.has(g));
}

/**
 * TokenStore op `connections` (envelope-versleuteld). Verversen werkt alleen de versleutelde velden bij;
 * scopes en account blijven staan. 401 of geweigerd verversen: koppeling en sync op needs_reauth. Een Google-bron
 * zonder eigen rij gebruikt de gedeelde rij 'google'; afkeuren en wissen raken dan die rij.
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
    /** Ontkoppelen: versleuteld token weg (de rij blijft met status disconnected). Geeft de gewiste rij terug. */
    async clear(userId: string, provider: string): Promise<string> {
      return withUser(db, userId, async (tx) => {
        const row = await tokenRow(tx, provider);
        await tx.execute(sql`update connections set token_ciphertext = null, token_iv = null, token_tag = null, dek_wrapped = null,
          status = 'disconnected' where provider = ${row}`);
        await tx.execute(
          sql`insert into audit_log (user_id, action, target) values (${userId}, 'connection.token_cleared', ${row})`,
        );
        return row;
      });
    },
    async markReauth(userId: string, provider: string, reason: string) {
      await withUser(db, userId, async (tx) => {
        const row = await tokenRow(tx, provider);
        const jobs = await jobsOf(tx, row);
        await tx.execute(
          sql`update connections set status = 'needs_reauth', error = ${'opnieuw koppelen: ' + reason.slice(0, 80)} where provider = ${row}`,
        );
        await tx.execute(
          sql`update sync_jobs set status = 'needs_reauth', last_error = 'token afgewezen' where provider in (${sql.join(
            [row, ...jobs].map((j) => sql`${j}`),
            sql`, `,
          )})`,
        );
        await tx.execute(
          sql`insert into audit_log (user_id, action, target) values (${userId}, 'connection.needs_reauth', ${row})`,
        );
      });
    },
  };
}

export interface DisconnectResult {
  /** Tokens die bij de bron zijn ingetrokken (aantal geslaagde intrekkingen). */
  revoked: number;
  /** Rijen in `connections` waarvan het token is gewist. */
  cleared: string[];
  /** Bronnen waarvan planning, cursors en events zijn gewist. */
  wiped: string[];
  /** Google-bronnen die nog toestemming hadden en nu opnieuw gekoppeld moeten worden (Google trekt alles in). */
  needsReauth: string[];
}

/**
 * Ontkoppelen (keuze 06): token intrekken bij de bron, versleuteld token wissen en de data van die bron wissen.
 *
 * Google kent geen intrekking per scope: het intrekken van één token trekt de hele toestemming van de collega voor
 * onze OAuth-client in (Agenda, Taken en Gmail tegelijk). Ontkoppel je één Google-bron, dan gaan daarom alle
 * Google-tokens van die collega weg (eigen rijen en de gedeelde rij 'google'), wordt de scope van die bron uit
 * `connections.scopes` gehaald en staan de andere Google-bronnen die nog toestemming hadden op needs_reauth.
 * Planning, cursors en events van alle drie de Google-bronnen gaan weg, zodat planSync niets opnieuw aanmaakt.
 * Intrekken dat mislukt blokkeert het ontkoppelen nooit.
 */
export async function disconnectSource(
  db: Db,
  masterKey: Buffer | null,
  userId: string,
  provider: string,
  revoke?: (provider: string, token: string) => Promise<unknown>,
): Promise<DisconnectResult> {
  const out: DisconnectResult = { revoked: 0, cleared: [], wiped: [], needsReauth: [] };
  const google = isGoogleSource(provider);
  const candidates = google ? [provider, ...GOOGLE_SOURCES.filter((g) => g !== provider), 'google'] : [provider];
  const held = await withUser(db, userId, async (tx) => {
    const r = await tx.execute(
      sql`select provider, scopes from connections where token_ciphertext is not null and provider in (${sql.join(
        candidates.map((c) => sql`${c}`),
        sql`, `,
      )})`,
    );
    return rows<{ provider: string; scopes: string[] | null }>(r);
  });
  // Eerst intrekken (met het token in de hand), daarna wissen.
  for (const h of held) {
    if (!revoke || !masterKey) break;
    const t = await readConnectionToken(db, masterKey, userId, h.provider).catch(() => null);
    if (!t) continue;
    const res = await revoke(h.provider === 'google' ? provider : h.provider, t).catch(() => 'failed');
    if (res === 'revoked') out.revoked++;
  }
  const stillGranted = new Set<string>();
  for (const h of held) {
    if (h.provider === provider) continue;
    if (h.provider === 'google') {
      for (const g of GOOGLE_SOURCES)
        if (g !== provider && (h.scopes ?? []).some((s) => GOOGLE_SCOPE[g].test(s))) stillGranted.add(g);
    } else stillGranted.add(h.provider);
  }
  await withUser(db, userId, async (tx) => {
    for (const h of held) {
      let scopes = h.scopes ?? [];
      if (h.provider === 'google' && google) scopes = scopes.filter((s) => !GOOGLE_SCOPE[provider].test(s));
      const reauth =
        h.provider !== provider &&
        (h.provider === 'google' ? GOOGLE_SOURCES.some((g) => stillGranted.has(g)) : stillGranted.has(h.provider));
      await tx.execute(sql`update connections set token_ciphertext = null, token_iv = null, token_tag = null, dek_wrapped = null,
        scopes = ${sql`array[${sql.join(
          scopes.map((s) => sql`${s}`),
          sql`, `,
        )}]::text[]`},
        status = ${reauth ? 'needs_reauth' : 'disconnected'},
        error = ${reauth ? 'Google trekt alle rechten tegelijk in: opnieuw koppelen' : null}
        where provider = ${h.provider}`);
      await tx.execute(
        sql`insert into audit_log (user_id, action, target) values (${userId}, 'connection.token_cleared', ${h.provider})`,
      );
      out.cleared.push(h.provider);
    }
  });
  out.needsReauth = [...stillGranted];
  out.wiped = google ? [...GOOGLE_SOURCES] : [provider];
  for (const w of out.wiped) await wipeSyncData(db, userId, w);
  return out;
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

/** Voornaam van een collega (owner in de contextlaag); alleen de naam, voor de worker ('system'). */
export async function userFirstName(db: Db, userId: string): Promise<string | null> {
  const r = await withPurpose(db, 'system', (tx) =>
    tx.execute(sql`select name, email from users where id = ${userId}`),
  );
  const u = rows<{ name: string | null; email: string }>(r)[0];
  if (!u) return null;
  return (u.name || u.email.split('@')[0] || '').trim().split(/\s+/)[0] || null;
}

/** Gekoppelde bronnen van één collega (eigen transactie, RLS). */
export async function connectedProviders(db: Db, userId: string) {
  const r = await withUser(db, userId, (tx) =>
    tx.execute(sql`select provider, status, account, scopes from connections where token_ciphertext is not null`),
  );
  return rows<{ provider: string; status: string; account: string | null; scopes: string[] | null }>(r);
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

/** Collega's met een Slack-sync die dit kanaal kennen (kanaal-id's staan als metadata in sync_jobs.push). */
export async function usersBySlackChannel(db: Db, channelId: string): Promise<string[]> {
  const r = await withPurpose(db, 'system', (tx) =>
    tx.execute(sql`select user_id from sync_jobs where provider = 'slack' and push -> 'slackChannels' ? ${channelId}`),
  );
  return rows<{ user_id: string }>(r).map((x) => String(x.user_id));
}

/** Alle collega's met een planningsrij voor deze bron (en het externe account erbij). */
export async function usersWithJob(
  db: Db,
  provider: string,
): Promise<Array<{ userId: string; account: string | null }>> {
  const r = await withPurpose(db, 'system', (tx) =>
    tx.execute(sql`select user_id, account from sync_jobs where provider = ${provider}`),
  );
  return rows<{ user_id: string; account: string | null }>(r).map((x) => ({
    userId: String(x.user_id),
    account: x.account,
  }));
}

/** Is er ooit een event van deze bron voor deze collega binnengekomen (dan werkt push echt)? */
export async function hasSyncEvents(db: Db, userId: string, source: string): Promise<boolean> {
  const r = await withUser(db, userId, (tx) =>
    tx.execute(sql`select 1 from sync_events where user_id = ${userId} and source = ${source} limit 1`),
  );
  return rows(r).length > 0;
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
