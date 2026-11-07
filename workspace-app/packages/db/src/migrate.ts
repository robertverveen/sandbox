import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { createOwnerDb } from './client';

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');

/**
 * Migraties draaien als de migratierol (eigenaar van de tabellen), met een eigen verbinding.
 * Vereist dat een beheerder eenmalig sql/bootstrap-roles.sql draaide (rol hz_app); anders faalt 0004 met uitleg.
 */
export async function runMigrations(url: string) {
  const { db, close } = createOwnerDb(url, 1);
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await close();
  }
}

/** Maak de database aan als die nog niet bestaat (hz_dev mag databases maken). */
export async function ensureDatabase(url: string, opts: { recreate?: boolean } = {}) {
  const u = new URL(url);
  const name = u.pathname.replace(/^\//, '');
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`ongeldige databasenaam: ${name}`);
  u.pathname = '/postgres';
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  try {
    if (opts.recreate) await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    const r = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!r.rowCount) await c.query(`CREATE DATABASE ${name}`);
  } finally {
    await c.end();
  }
}
