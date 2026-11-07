/**
 * Eén keer per testrun: een Postgres-superuser voor de back-up- en verhuistests, en na afloop opruimen.
 * Rollen zijn clusterbreed (niet per database), dus alles wat de infra-tests maken (hz_e0_*) gaat hier weer weg,
 * ook de tijdelijke testbeheerder zelf. Die krijgt elke run een nieuw, willekeurig wachtwoord.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    hzAdminUrl: string;
  }
}

const ADMIN = 'hz_e0_admin';

async function isSuper(url: string): Promise<boolean> {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try {
    await c.connect();
    const r = await c.query<{ rolsuper: boolean }>('select rolsuper from pg_roles where rolname = current_user');
    return !!r.rows[0]?.rolsuper;
  } catch {
    return false;
  } finally {
    await c.end().catch(() => {});
  }
}

const asPostgres = (sql: string) =>
  spawnSync('su', ['postgres', '-s', '/bin/sh', '-c', 'psql -X -q -v ON_ERROR_STOP=1'], {
    input: sql,
    encoding: 'utf8',
  });

/** Volgorde: HZ_PG_ADMIN_URL; in CI postgres met PGPASSWORD; lokaal als root een tijdelijke hz_e0_admin. */
async function admin(): Promise<{ url: string; temporary: boolean }> {
  if (process.env.HZ_PG_ADMIN_URL) return { url: process.env.HZ_PG_ADMIN_URL, temporary: false };
  if (process.env.PGPASSWORD) {
    const u = `postgres://postgres:${encodeURIComponent(process.env.PGPASSWORD)}@localhost:5432/postgres`;
    if (await isSuper(u)) return { url: u, temporary: false };
  }
  if (process.getuid?.() === 0) {
    const pw = randomBytes(18).toString('hex');
    const r = asPostgres(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${ADMIN}') THEN CREATE ROLE ${ADMIN} LOGIN SUPERUSER; END IF; END $$;\nALTER ROLE ${ADMIN} PASSWORD '${pw}';\n`,
    );
    const url = `postgres://${ADMIN}:${pw}@localhost:5432/postgres`;
    if (r.status === 0 && (await isSuper(url))) return { url, temporary: true };
  }
  return { url: '', temporary: false };
}

/** Alle rollen hz_e0_* weg (behalve de verbonden beheerder), daarna de tijdelijke beheerder zelf. */
export async function cleanupRoles(url: string, temporary: boolean, prefix = 'hz_e0_'): Promise<string[]> {
  if (!/^hz_e0_[a-z0-9_]*$/.test(prefix)) throw new Error(`alleen eigen rollen (hz_e0_...): ${prefix}`);
  const left: string[] = [];
  if (url) {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      const roles = await c.query<{ rolname: string }>(
        'select rolname from pg_roles where starts_with(rolname, $1) and rolname <> current_user order by 1',
        [prefix],
      );
      for (const { rolname } of roles.rows) {
        if (!/^hz_e0_[a-z0-9_]+$/.test(rolname)) continue;
        try {
          await c.query(`DROP OWNED BY ${rolname}`);
          await c.query(`DROP ROLE ${rolname}`);
        } catch {
          left.push(rolname);
        }
      }
    } finally {
      await c.end();
    }
  }
  if (temporary) {
    const r = asPostgres(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${ADMIN}';\nDROP ROLE IF EXISTS ${ADMIN};\n`,
    );
    if (r.status !== 0) left.push(ADMIN);
  }
  return left;
}

export default async function setup(project: TestProject) {
  const a = await admin();
  project.provide('hzAdminUrl', a.url);
  return async () => {
    const left = await cleanupRoles(a.url, a.temporary);
    if (left.length) console.warn(`infra-tests: rollen niet opgeruimd: ${left.join(', ')}`);
  };
}
