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
 * withPurpose(): transacties zonder gebruiker, alleen voor inloggen ('auth'), de worker ('system')
 * en de contextindex ('index'); de RLS-regels bepalen wat die mogen.
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

function pool(url: string, max: number, role: string | null) {
  const p = new pg.Pool({ connectionString: url, max, ...(role ? { options: `-c role=${role}` } : {}) });
  // Een verbroken verbinding in rust mag het proces niet laten crashen; de volgende query faalt wel netjes.
  p.on('error', (e) => console.error(`[db] verbinding: ${e.message}`));
  return p;
}

/** Verbinding voor de app: elke sessie draait als hz_app. */
export function createDb(url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, max = 10) {
  const p = pool(url, max, APP_ROLE);
  const db = drizzle(p, { schema });
  return { db, pool: p, close: () => p.end() };
}

/** Verbinding als de migratierol (eigenaar). Alleen voor migraties en beheerscripts, nooit voor requests. */
export function createOwnerDb(url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL, max = 1) {
  const p = pool(url, max, null);
  const db = drizzle(p, { schema });
  return { db, pool: p, close: () => p.end() };
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

export async function withPurpose<T>(db: Db, purpose: Purpose, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(setAppRole);
    await tx.execute(sql`select set_config('app.purpose', ${purpose}, true)`);
    return fn(tx);
  });
}
