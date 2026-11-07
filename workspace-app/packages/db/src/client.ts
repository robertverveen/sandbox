/**
 * Verbinding en transacties met rij-beveiliging.
 *
 * Rollen (HZW-020):
 * - de migratierol (lokaal en in CI `hz_dev`) is eigenaar van alle tabellen en draait alleen migraties
 *   (createOwnerDb, runMigrations);
 * - de runtime-rol `hz_app` (NOLOGIN, NOBYPASSRLS, eigenaar van niets) is waar de app als werkt. createDb()
 *   start elke verbinding als hz_app (`-c role=hz_app`), en withUser/withPurpose doen daarbovenop per
 *   transactie `SET LOCAL ROLE hz_app`. Zo kan geen app-query RLS uitzetten of een policy weggooien.
 *
 * withUser(): elke query loopt in een transactie met SET LOCAL app.user_id, en in een request ook app.session (de
 * sha256-hash van het sessietoken; runWithSession). Sinds 0011 leidt app_user_id() de gebruiker af uit app.session
 * via de geldige sessie; app.user_id alleen telt zonder sessie, en alleen voor een login die lid is van hz_worker
 * (worker, importscript). De api-login kan dus niemand nadoen door app.user_id te zetten.
 * withPurpose(): transacties zonder gebruiker. app.purpose opent sinds 0006/0009 niets meer (een GUC kan elke
 * transactie zetten): 'auth' en 'system' geven geen leesrecht op users of sessions, 'index' geen schrijfrecht op
 * context_index. Inloggen en sessies alleen als hz_auth (createAuthDb/withAuth, 0011; repo.ts: findSession,
 * upsertUser, …); schrijven in de contextindex alleen als hz_indexer (createIndexerDb/withIndexer, 0009); de id's
 * van alle collega's alleen als hz_worker (withWorker, 0010; alleen de worker-login is daar lid van).
 *
 * Een verbinding uit de pool erft niets van de vorige request (0013): geen rol van de app mag tijdelijke tabellen maken,
 * elke verbinding start met search_path=public,pg_temp, en elke transactie van de hulpfuncties begint met RESET ALL.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Purpose = 'auth' | 'system' | 'index';

export const DEFAULT_DATABASE_URL = 'postgres://hz_dev:hz_dev@localhost:5432/hz_fundament';
/** De runtime-rol. Vast: de migraties verlenen hem zijn rechten (drizzle/0004_app_role.sql). */
export const APP_ROLE = 'hz_app';

type PoolHook = (client: pg.PoolClient) => Promise<void>;

/**
 * Zoekpad van elke verbinding: pg_temp expliciet achteraan. Standaard zoekt Postgres eerst in pg_temp; een tijdelijke
 * tabel met de naam van een app-tabel zou dan de echte tabel overschaduwen voor elke latere request op die verbinding
 * (drizzle noemt tabellen zonder schema). Sinds 0013 mag geen rol van de app nog tijdelijke tabellen maken; dit is de
 * tweede slot op de deur.
 */
export const SEARCH_PATH = 'public,pg_temp';

/** De opstartopties (libpq `options`) van een verbinding met deze rol. */
export function connectionOptions(role: string | null) {
  return [role ? `-c role=${role}` : '', `-c search_path=${SEARCH_PATH}`].filter(Boolean).join(' ');
}

function pool(url: string, max: number, role: string | null, onConnect?: PoolHook) {
  // onConnect (pg-pool >= 3.10): async controle op elke nieuwe verbinding; faalt hij, dan faalt de query.
  const cfg = {
    connectionString: url,
    max,
    options: connectionOptions(role),
    ...(onConnect ? { onConnect } : {}),
  };
  const p = new pg.Pool(cfg as pg.PoolConfig);
  // Een verbroken verbinding in rust mag het proces niet laten crashen; de volgende query faalt wel netjes.
  p.on('error', (e) => console.error(`[db] verbinding: ${e.message}`));
  return p;
}

/** Uitkomst van checkAppLogin: wat de login van de verbinding (session_user) kan. */
export interface AppLoginCheck {
  login: string;
  superuser: boolean;
  bypassRls: boolean;
  /** Tabellen, views en sequences waarvan de login eigenaar is, direct of via lidmaatschap (SET ROLE). */
  ownedRelations: number;
  /** Bijzondere rollen waar de login lid van is (hz_worker, hz_indexer, hz_auth); de api-login hoort bij geen ervan. */
  memberOf: string[];
  /** Mag de login (of een rol waar hij lid van is) tijdelijke tabellen maken in deze database? Hoort false (0013). */
  temp: boolean;
}

/** Rollen met een eigen recht naast hz_app; een login mag er alleen lid van zijn als dat zo bedoeld is. */
export const SPECIAL_ROLES = ['hz_worker', 'hz_indexer', 'hz_auth'] as const;

/**
 * Wat de login achter DATABASE_URL zelf kan, los van `-c role=hz_app`. De app hoort te verbinden met een login die
 * geen superuser of BYPASSRLS is en geen eigenaar van tabellen (ook niet via een rol waar hij lid van is): dan kan een
 * `RESET ROLE` of `SET ROLE NONE` in een request RLS nooit omzeilen. Zie sql/app-login.sql.
 */
export async function checkAppLogin(
  client: Pick<pg.ClientBase, 'query'>,
  opts: { exceptSchemas?: string[] } = {},
): Promise<AppLoginCheck> {
  const r = await client.query<{
    login: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
    owned: number;
    member_of: string[] | null;
    temp: boolean;
  }>(
    `
    select session_user::text as login, r.rolsuper, r.rolbypassrls,
      (has_database_privilege(session_user, current_database(), 'TEMPORARY')
        or exists (select 1 from pg_roles g where pg_has_role(session_user, g.oid, 'MEMBER') and g.rolname <> session_user
                   and has_database_privilege(g.oid, current_database(), 'TEMPORARY'))) as temp,
      array(select g.rolname::text from pg_roles g
             where g.rolname = any($2::text[]) and pg_has_role(session_user, g.oid, 'MEMBER')
             order by 1) as member_of,
      (select count(*)::int from pg_class c
        where c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
          and c.relnamespace not in ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
          and c.relnamespace::regnamespace::text not like 'pg\\_toast%'
          and c.relnamespace::regnamespace::text <> all($1::text[])
          and pg_has_role(session_user, c.relowner, 'MEMBER')) as owned
    from pg_roles r where r.rolname = session_user`,
    [opts.exceptSchemas ?? [], [...SPECIAL_ROLES]],
  );
  const row = r.rows[0]!;
  return {
    login: row.login,
    superuser: row.rolsuper,
    bypassRls: row.rolbypassrls,
    ownedRelations: row.owned,
    memberOf: row.member_of ?? [],
    temp: row.temp,
  };
}

export class UnsafeAppLoginError extends Error {
  constructor(c: AppLoginCheck, forbidden: string[] = []) {
    const why = [
      c.superuser ? 'is superuser' : '',
      c.bypassRls ? 'heeft BYPASSRLS' : '',
      c.ownedRelations ? `is eigenaar van ${c.ownedRelations} tabel(len) of views (direct of via een rol)` : '',
      forbidden.length ? `is lid van ${forbidden.join(', ')} (hoort bij een andere login)` : '',
      c.temp ? 'mag tijdelijke tabellen maken (TEMP; draai de migraties, 0013)' : '',
    ].filter(Boolean);
    super(
      `DATABASE_URL: login "${c.login}" ${why.join(', ')}. In productie verbindt de app met een aparte login die alleen ` +
        `lid is van hz_app (sql/app-login.sql), niet met de migratierol.`,
    );
    this.name = 'UnsafeAppLoginError';
  }
}

/**
 * Gooit UnsafeAppLoginError als de login van deze verbinding RLS zou kunnen omzeilen, of lid is van een bijzondere
 * rol (hz_worker, hz_indexer, hz_auth) die niet in `allowRoles` staat. Zo weigert de api in productie een login waarmee
 * een request namens een collega zou kunnen werken (hz_worker), sessies zou kunnen maken (hz_auth) of de gedeelde index
 * zou kunnen wijzigen (hz_indexer).
 */
export async function assertAppLogin(client: Pick<pg.ClientBase, 'query'>, opts: { allowRoles?: string[] } = {}) {
  const c = await checkAppLogin(client);
  const forbidden = c.memberOf.filter((r) => !(opts.allowRoles ?? []).includes(r));
  if (c.superuser || c.bypassRls || c.ownedRelations > 0 || forbidden.length || c.temp)
    throw new UnsafeAppLoginError(c, forbidden);
  return c;
}

export class UnsafeBossLoginError extends Error {
  constructor(c: AppLoginCheck, schema: string) {
    const why = [
      c.superuser ? 'is superuser' : '',
      c.bypassRls ? 'heeft BYPASSRLS' : '',
      c.ownedRelations
        ? `is eigenaar van ${c.ownedRelations} tabel(len) of views buiten schema ${schema} (direct of via een rol)`
        : '',
    ].filter(Boolean);
    super(
      `HZ_BOSS_DATABASE_URL: login "${c.login}" ${why.join(', ')}. In productie draait pg-boss met een eigen login ` +
        `die alleen eigenaar is van schema ${schema} (sql/boss-login.sql), niet met de migratierol.`,
    );
    this.name = 'UnsafeBossLoginError';
  }
}

/**
 * Controle voor de pg-boss-verbinding van de worker: zoals assertAppLogin, maar eigenaar zijn van het eigen
 * pg-boss-schema mag (dat is precies de bedoeling). Eigenaar van app-tabellen (of lid van de migratierol): fout.
 */
export async function assertBossLogin(client: Pick<pg.ClientBase, 'query'>, schema: string) {
  const c = await checkAppLogin(client, { exceptSchemas: [schema] });
  if (c.superuser || c.bypassRls || c.ownedRelations > 0) throw new UnsafeBossLoginError(c, schema);
  return c;
}

/** assertBossLogin op een eigen, korte verbinding naar `url` (de worker vóór pg-boss start). */
export async function assertBossLoginAt(url: string, schema: string) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await assertBossLogin(c, schema);
  } finally {
    await c.end();
  }
}

export interface CreateDbOptions {
  /** Omgeving voor de productiecontrole (standaard process.env). */
  env?: Record<string, string | undefined>;
  /**
   * Bijzondere rollen waar de login in productie lid van mag zijn. De api: geen (standaard). De worker: ['hz_worker']
   * (sql/worker-login.sql), voor activeUserIds() en werken namens een collega.
   */
  allowRoles?: string[];
}

/**
 * Verbinding voor de app: elke sessie draait als hz_app. In NODE_ENV=production controleert elke nieuwe verbinding
 * eerst de login (assertAppLogin): is die eigenaar van tabellen, superuser of BYPASSRLS, dan faalt elke query.
 */
export function createDb(url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, max = 10, opts: CreateDbOptions = {}) {
  const prod = (opts.env ?? process.env).NODE_ENV === 'production';
  const allowRoles = opts.allowRoles ?? [];
  const p = pool(url, max, APP_ROLE, prod ? async (c) => void (await assertAppLogin(c, { allowRoles })) : undefined);
  const db = drizzle(p, { schema });
  return { db, pool: p, close: () => p.end() };
}

/** Verbinding als de migratierol (eigenaar). Alleen voor migraties en beheerscripts, nooit voor requests. */
export function createOwnerDb(url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, max = 1) {
  const p = pool(url, max, null);
  const db = drizzle(p, { schema });
  return { db, pool: p, close: () => p.end() };
}

/** De rol die in de contextindex mag schrijven (alleen via context_index_upsert/-delete; migratie 0009). */
export const INDEX_ROLE = 'hz_indexer';

/**
 * Verbinding voor de indexer (indexjob van de contextlaag, importscript): elke sessie draait als hz_indexer. In
 * productie een eigen login die alleen lid is van hz_indexer (sql/indexer-login.sql, HZ_INDEX_DATABASE_URL); dezelfde
 * productiecontrole als createDb(). Lokaal mag het de migratierol zijn (die is lid van hz_indexer).
 */
export function createIndexerDb(
  url = process.env.HZ_INDEX_DATABASE_URL ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  max = 2,
  opts: CreateDbOptions = {},
) {
  const prod = (opts.env ?? process.env).NODE_ENV === 'production';
  const p = pool(
    url,
    max,
    INDEX_ROLE,
    prod ? async (c) => void (await assertAppLogin(c, { allowRoles: [INDEX_ROLE] })) : undefined,
  );
  const db = drizzle(p, { schema });
  return { db, pool: p, close: () => p.end() };
}

/** Kan de login van deze verbinding hz_indexer worden? (De app-login kan dat niet.) */
export async function canIndex(db: Db): Promise<boolean> {
  const r = await db.execute<{ ok: boolean }>(
    sql`select coalesce(pg_has_role(session_user, ${INDEX_ROLE}, 'MEMBER'), false) as ok`,
  );
  return r.rows[0]?.ok === true;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Begin van elke transactie van de hulpfuncties: eerst RESET ALL (wat een vorige request op deze verbinding met een
 * gewone SET op sessieniveau achterliet, zoals search_path of app.session, telt niet), dan de rol voor deze transactie.
 * RESET ALL laat de rol zelf staan; die zet SET LOCAL ROLE.
 */
const beginAs = (role: string) => sql.raw(`RESET ALL; SET LOCAL ROLE ${role}`);
const setAppRole = beginAs(APP_ROLE);

const HASH = /^[0-9a-f]{64}$/;
const sessionContext = new AsyncLocalStorage<{ tokenHash: string }>();

/**
 * Alles wat `fn` (ook asynchroon) via withUser doet, hoort bij deze sessie: withUser zet dan ook app.session. Zo bindt
 * de api elke request aan het sessietoken uit de cookie (sessie-middleware), zonder dat elke repo-functie het token
 * hoeft door te geven. `tokenHash`: hashToken(token), nooit het token zelf.
 */
export function runWithSession<T>(tokenHash: string, fn: () => T): T {
  if (!HASH.test(tokenHash)) throw new Error('runWithSession: alleen een sha256-hash (64 hex) van het token');
  return sessionContext.run({ tokenHash }, fn);
}

/** De sessie-hash van de lopende request (runWithSession), of null. */
export const currentSessionHash = () => sessionContext.getStore()?.tokenHash ?? null;

/**
 * Transactie als hz_app voor één collega. Binnen runWithSession zet hij ook app.session: app_user_id() geeft dan alleen
 * de gebruiker van die sessie, en niemand als `userId` daar niet bij hoort. Zonder sessie telt `userId` alleen voor
 * een login die lid is van hz_worker (worker, importscript, lokaal de migratierol); de api-login ziet dan niets.
 */
export async function withUser<T>(db: Db, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID.test(userId)) throw new Error('withUser: ongeldige gebruiker');
  const hash = currentSessionHash();
  return db.transaction(async (tx) => {
    await tx.execute(setAppRole);
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    if (hash) await tx.execute(sql`select set_config('app.session', ${hash}, true)`);
    return fn(tx);
  });
}

/** Transactie als hz_app voor de gebruiker van één sessie (alleen app.session; zonder geldige sessie: niemand). */
export async function withSession<T>(db: Db, tokenHash: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!HASH.test(tokenHash)) throw new Error('withSession: alleen een sha256-hash (64 hex) van het token');
  return db.transaction(async (tx) => {
    await tx.execute(setAppRole);
    await tx.execute(sql`select set_config('app.session', ${tokenHash}, true)`);
    return fn(tx);
  });
}

/** Mag de login van deze verbinding namens een collega werken met app.user_id (lid van hz_worker)? */
export async function canActAsUser(db: Db): Promise<boolean> {
  const r = await db.execute<{ ok: boolean }>(
    sql`select coalesce(pg_has_role(session_user, 'hz_worker', 'MEMBER'), false) as ok`,
  );
  return r.rows[0]?.ok === true;
}

/** De rol voor inloggen en sessies (alleen de auth_*-functies; migratie 0011). */
export const AUTH_ROLE = 'hz_auth';

/**
 * Verbinding voor inloggen en sessies: de sessie-middleware van de api en de adapter van de auth-bibliotheek. Elke
 * sessie draait als hz_auth (geen tabelrechten, alleen de auth_*-functies). In productie een eigen login die alleen
 * lid is van hz_auth (sql/auth-login.sql, HZ_AUTH_DATABASE_URL); dezelfde productiecontrole als createDb(). Lokaal mag
 * het de migratierol zijn (die is lid van hz_auth).
 */
export function createAuthDb(
  url = process.env.HZ_AUTH_DATABASE_URL ?? process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
  max = 4,
  opts: CreateDbOptions = {},
) {
  const prod = (opts.env ?? process.env).NODE_ENV === 'production';
  const p = pool(
    url,
    max,
    AUTH_ROLE,
    prod ? async (c) => void (await assertAppLogin(c, { allowRoles: [AUTH_ROLE] })) : undefined,
  );
  const db = drizzle(p, { schema });
  return { db, pool: p, close: () => p.end() };
}

/**
 * Transactie als hz_auth: alleen de auth_*-functies. Faalt met 42501 als de login geen lid is van hz_auth (zoals de
 * api-login hz_app_login en de worker-login).
 */
export async function withAuth<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(beginAs(AUTH_ROLE));
    return fn(tx);
  });
}

/**
 * Transactie als hz_indexer: alleen lezen en de functies context_index_upsert/context_index_delete. Faalt met 42501
 * als de login geen lid is van hz_indexer (zoals de app-login).
 */
export async function withIndexer<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(beginAs(INDEX_ROLE));
    return fn(tx);
  });
}

/** De rol die system_active_user_ids() mag uitvoeren (migratie 0010); alleen de worker-login is er lid van. */
export const WORKER_ROLE = 'hz_worker';

/**
 * Transactie als hz_worker: geen tabelrechten, alleen system_active_user_ids(). Faalt met 42501 als de login geen lid
 * is van hz_worker (zoals de api-login hz_app_login).
 */
export async function withWorker<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(beginAs(WORKER_ROLE));
    return fn(tx);
  });
}

export async function withPurpose<T>(db: Db, purpose: Purpose, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(setAppRole);
    await tx.execute(sql`select set_config('app.purpose', ${purpose}, true)`);
    return fn(tx);
  });
}
