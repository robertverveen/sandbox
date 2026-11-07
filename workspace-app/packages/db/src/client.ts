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
 * withUser(): elke query van een request loopt in een transactie met SET LOCAL app.user_id.
 * withPurpose(): transacties zonder gebruiker. app.purpose opent sinds 0006/0009 niets meer (een GUC kan elke
 * transactie zetten): 'auth' en 'system' geven geen leesrecht op users of sessions, 'index' geen schrijfrecht op
 * context_index. Inloggen en de worker gebruiken SECURITY DEFINER-functies (repo.ts: findSession, upsertUser,
 * activeUserIds, …); schrijven in de contextindex alleen als hz_indexer (createIndexerDb/withIndexer, 0009).
 */
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

function pool(url: string, max: number, role: string | null, onConnect?: PoolHook) {
  // onConnect (pg-pool >= 3.10): async controle op elke nieuwe verbinding; faalt hij, dan faalt de query.
  const cfg = {
    connectionString: url,
    max,
    ...(role ? { options: `-c role=${role}` } : {}),
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
}

/**
 * Wat de login achter DATABASE_URL zelf kan, los van `-c role=hz_app`. De app hoort te verbinden met een login die
 * geen superuser of BYPASSRLS is en geen eigenaar van tabellen (ook niet via een rol waar hij lid van is): dan kan een
 * `RESET ROLE` of `SET ROLE NONE` in een request RLS nooit omzeilen. Zie sql/app-login.sql.
 */
export async function checkAppLogin(
  client: Pick<pg.ClientBase, 'query'>,
  opts: { exceptSchemas?: string[] } = {},
): Promise<AppLoginCheck> {
  const r = await client.query<{ login: string; rolsuper: boolean; rolbypassrls: boolean; owned: number }>(
    `
    select session_user::text as login, r.rolsuper, r.rolbypassrls,
      (select count(*)::int from pg_class c
        where c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
          and c.relnamespace not in ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)
          and c.relnamespace::regnamespace::text not like 'pg\\_toast%'
          and c.relnamespace::regnamespace::text <> all($1::text[])
          and pg_has_role(session_user, c.relowner, 'MEMBER')) as owned
    from pg_roles r where r.rolname = session_user`,
    [opts.exceptSchemas ?? []],
  );
  const row = r.rows[0]!;
  return { login: row.login, superuser: row.rolsuper, bypassRls: row.rolbypassrls, ownedRelations: row.owned };
}

export class UnsafeAppLoginError extends Error {
  constructor(c: AppLoginCheck) {
    const why = [
      c.superuser ? 'is superuser' : '',
      c.bypassRls ? 'heeft BYPASSRLS' : '',
      c.ownedRelations ? `is eigenaar van ${c.ownedRelations} tabel(len) of views (direct of via een rol)` : '',
    ].filter(Boolean);
    super(
      `DATABASE_URL: login "${c.login}" ${why.join(', ')}. In productie verbindt de app met een aparte login die alleen ` +
        `lid is van hz_app (sql/app-login.sql), niet met de migratierol.`,
    );
    this.name = 'UnsafeAppLoginError';
  }
}

/** Gooit UnsafeAppLoginError als de login van deze verbinding RLS zou kunnen omzeilen. */
export async function assertAppLogin(client: Pick<pg.ClientBase, 'query'>) {
  const c = await checkAppLogin(client);
  if (c.superuser || c.bypassRls || c.ownedRelations > 0) throw new UnsafeAppLoginError(c);
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
}

/**
 * Verbinding voor de app: elke sessie draait als hz_app. In NODE_ENV=production controleert elke nieuwe verbinding
 * eerst de login (assertAppLogin): is die eigenaar van tabellen, superuser of BYPASSRLS, dan faalt elke query.
 */
export function createDb(url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, max = 10, opts: CreateDbOptions = {}) {
  const prod = (opts.env ?? process.env).NODE_ENV === 'production';
  const p = pool(url, max, APP_ROLE, prod ? async (c) => void (await assertAppLogin(c)) : undefined);
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
  const p = pool(url, max, INDEX_ROLE, prod ? async (c) => void (await assertAppLogin(c)) : undefined);
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
const setAppRole = sql.raw(`SET LOCAL ROLE ${APP_ROLE}`);

export async function withUser<T>(db: Db, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID.test(userId)) throw new Error('withUser: ongeldige gebruiker');
  return db.transaction(async (tx) => {
    await tx.execute(setAppRole);
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}

/**
 * Transactie als hz_indexer: alleen lezen en de functies context_index_upsert/context_index_delete. Faalt met 42501
 * als de login geen lid is van hz_indexer (zoals de app-login).
 */
export async function withIndexer<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL ROLE ${INDEX_ROLE}`));
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
