/**
 * HZW-020 (stuk E2): de app als aparte login. In productie verbindt de app niet als de migratierol, maar als een
 * login die alleen lid is van hz_app: `CREATE ROLE hz_app_login LOGIN NOINHERIT IN ROLE hz_app` (sql/app-login.sql).
 * Dan kan een request met `SET ROLE NONE` of `RESET ROLE` RLS niet omzeilen: zonder hz_app heeft de login geen
 * tabelrechten (NOINHERIT) en hij is nergens eigenaar. createDb() weigert in productie een login die eigenaar is.
 *
 * Vereist dat een beheerder eenmalig sql/app-login.sql draaide (lokaal en in CI met login/wachtwoord hz_app_login).
 * Eigen, verse database (hz_e2_test_login) op localhost:5432.
 */
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertAppLogin,
  checkAppLogin,
  createDb,
  ensureDatabase,
  runMigrations,
  upsertUser,
  UnsafeAppLoginError,
  weekdoelen,
  withUser,
  type Db,
} from '../src';

const OWNER_URL = process.env.HZ_TEST_DATABASE_URL_LOGIN ?? 'postgres://hz_dev:hz_dev@localhost:5432/hz_e2_test_login';
const LOGIN = process.env.HZ_TEST_APP_LOGIN ?? 'hz_app_login:hz_app_login';
const loginUrl = (() => {
  const u = new URL(OWNER_URL);
  const [user, pw] = LOGIN.split(':');
  u.username = user!;
  u.password = pw ?? '';
  return u.toString();
})();
const loginName = LOGIN.split(':')[0]!;

let app: ReturnType<typeof createDb>;
let db: Db;
let A: string;
let B: string;

beforeAll(async () => {
  await ensureDatabase(OWNER_URL, { recreate: true });
  await runMigrations(OWNER_URL);
  // Ontbreekt de login, dan faalt deze test met uitleg (geen stille skip).
  const probe = new pg.Client({ connectionString: loginUrl });
  await probe.connect().catch((e: Error) => {
    throw new Error(
      `Kan niet verbinden als ${loginName} (${e.message}). Draai eenmalig als beheerder: ` +
        `sudo -u postgres psql -v login=hz_app_login -v password=hz_app_login -f packages/db/sql/app-login.sql`,
    );
  });
  await probe.end();
  app = createDb(loginUrl, 3);
  db = app.db;
  A = (await upsertUser(db, 'anna@homezero.nl', 'Anna')).id;
  B = (await upsertUser(db, 'bram@homezero.nl', 'Bram')).id;
  for (const [uid, wat] of [
    [A, 'doel-a'],
    [B, 'doel-b'],
  ] as const)
    await withUser(db, uid, (tx) => tx.insert(weekdoelen).values({ userId: uid, wat, week: '2026-W45' }));
}, 30_000);

afterAll(async () => {
  await app?.close();
});

type PgErr = { code?: string; message?: string };
async function failsWith(c: pg.PoolClient, stmt: string, code: string, msg: RegExp) {
  const e = await c.query(stmt).then(
    () => null,
    (x: PgErr) => x,
  );
  expect(e, `${stmt} had geweigerd moeten worden`).not.toBeNull();
  expect(e!.code, stmt).toBe(code);
  expect(e!.message ?? '', stmt).toMatch(msg);
}

describe('de login zelf: NOINHERIT, alleen lid van hz_app, eigenaar van niets', () => {
  it('session_user is de login, current_user is hz_app', async () => {
    const r = await db.execute<{ su: string; cu: string }>(sql`select session_user as su, current_user as cu`);
    expect(r.rows[0]).toEqual({ su: loginName, cu: 'hz_app' });
  });

  it('rolinherit = false, geen superuser, geen BYPASSRLS, lid van alleen hz_app', async () => {
    const r = await db.execute<{ rolinherit: boolean; rolsuper: boolean; rolbypassrls: boolean; groups: string }>(sql`
      select r.rolinherit, r.rolsuper, r.rolbypassrls,
        (select string_agg(g.rolname, ',') from pg_auth_members m join pg_roles g on g.oid = m.roleid
          where m.member = r.oid) as groups
      from pg_roles r where r.rolname = session_user`);
    expect(r.rows[0]).toEqual({ rolinherit: false, rolsuper: false, rolbypassrls: false, groups: 'hz_app' });
  });

  it('checkAppLogin: de login is nergens eigenaar van; de migratierol wel', async () => {
    const c = await app.pool.connect();
    try {
      expect(await assertAppLogin(c)).toMatchObject({ login: loginName, ownedRelations: 0, superuser: false });
    } finally {
      c.release();
    }
    const owner = new pg.Client({ connectionString: OWNER_URL });
    await owner.connect();
    try {
      const o = await checkAppLogin(owner);
      expect(o.ownedRelations).toBeGreaterThan(0);
      await expect(assertAppLogin(owner)).rejects.toBeInstanceOf(UnsafeAppLoginError);
    } finally {
      await owner.end();
    }
  });
});

describe('SET ROLE NONE en RESET ROLE in een request: RLS blijft dicht', () => {
  it('na SET ROLE NONE: current_user is de login, geen tabelrechten, geen NO FORCE', async () => {
    const c = await app.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`select set_config('app.user_id', '${A}', true)`);
      await c.query('SET ROLE NONE');
      expect((await c.query('select current_user as cu')).rows[0].cu).toBe(loginName);
      await c.query('SAVEPOINT s1');
      await failsWith(c, 'select * from weekdoelen', '42501', /permission denied/);
      await c.query('ROLLBACK TO SAVEPOINT s1');
      await failsWith(c, 'select * from users', '42501', /permission denied/);
      await c.query('ROLLBACK TO SAVEPOINT s1');
      await failsWith(c, 'ALTER TABLE weekdoelen NO FORCE ROW LEVEL SECURITY', '42501', /must be owner/);
      await c.query('ROLLBACK TO SAVEPOINT s1');
      await failsWith(c, 'ALTER TABLE weekdoelen DISABLE ROW LEVEL SECURITY', '42501', /must be owner/);
      await c.query('ROLLBACK TO SAVEPOINT s1');
      await failsWith(c, 'DROP POLICY weekdoelen_own ON weekdoelen', '42501', /must be owner/);
      await c.query('ROLLBACK TO SAVEPOINT s1');
      await failsWith(c, 'SET ROLE hz_dev', '42501', /permission denied to set role/);
      await c.query('ROLLBACK');
    } finally {
      await c.query('RESET ROLE').catch(() => {});
      c.release();
    }
  });

  it('na RESET ROLE: terug naar hz_app (de startrol), nog steeds alleen eigen rijen en geen NO FORCE', async () => {
    const c = await app.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE NONE');
      await c.query('RESET ROLE');
      const cu = (await c.query('select current_user as cu')).rows[0].cu as string;
      expect(['hz_app', loginName]).toContain(cu);
      await c.query(`select set_config('app.user_id', '${A}', true)`);
      const rows = await c.query('select wat from weekdoelen');
      expect(rows.rows.map((r: { wat: string }) => r.wat)).toEqual(['doel-a']);
      await c.query('SAVEPOINT s1');
      await failsWith(c, 'ALTER TABLE weekdoelen NO FORCE ROW LEVEL SECURITY', '42501', /must be owner/);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  it('withUser via deze login: A ziet nooit rijen van B', async () => {
    const a = await withUser(db, A, (tx) => tx.select().from(weekdoelen));
    expect(a.map((r) => r.wat)).toEqual(['doel-a']);
    const none = await db.execute(sql`select * from weekdoelen`);
    expect(none.rows).toHaveLength(0);
  });
});

describe('createDb() in NODE_ENV=production', () => {
  it('weigert een DATABASE_URL waarvan de login eigenaar is van tabellen (de migratierol)', async () => {
    const bad = createDb(OWNER_URL, 1, { env: { NODE_ENV: 'production' } });
    try {
      const e = await bad.db.execute(sql`select 1`).then(
        () => null,
        (x: Error & { cause?: Error }) => x,
      );
      expect(e).not.toBeNull();
      const msg = `${e!.message} ${e!.cause?.message ?? ''}`;
      expect(msg).toMatch(/eigenaar van \d+ tabel/);
      expect(msg).toMatch(/hz_dev|login/);
    } finally {
      await bad.close();
    }
  });

  it('weigert ook via process.env.NODE_ENV (zonder opties)', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const bad = createDb(OWNER_URL, 1);
    try {
      await expect(bad.db.execute(sql`select 1`)).rejects.toThrow();
    } finally {
      process.env.NODE_ENV = prev;
      await bad.close();
    }
  });

  it('accepteert de aparte login en werkt dan gewoon met RLS', async () => {
    const good = createDb(loginUrl, 1, { env: { NODE_ENV: 'production' } });
    try {
      const rows = await withUser(good.db, B, (tx) => tx.select().from(weekdoelen));
      expect(rows.map((r) => r.wat)).toEqual(['doel-b']);
    } finally {
      await good.close();
    }
  });

  it('buiten productie geen controle (lokaal mag de migratierol als login)', async () => {
    const dev = createDb(OWNER_URL, 1, { env: { NODE_ENV: 'development' } });
    try {
      const r = await dev.db.execute<{ cu: string }>(sql`select current_user as cu`);
      expect(r.rows[0]!.cu).toBe('hz_app');
    } finally {
      await dev.close();
    }
  });
});
