/**
 * HZW-020 (stuk E2): de app als aparte login. In productie verbindt de app niet als de migratierol, maar als een
 * login die alleen lid is van hz_app: `CREATE ROLE hz_app_login LOGIN NOINHERIT IN ROLE hz_app` (sql/app-login.sql).
 * Dan kan een request met `SET ROLE NONE` of `RESET ROLE` RLS niet omzeilen: zonder hz_app heeft de login geen
 * tabelrechten (NOINHERIT) en hij is nergens eigenaar. createDb() weigert in productie een login die eigenaar is.
 * Sinds 0011 telt app.user_id voor deze login niet: hij ziet alleen rijen van de gebruiker van een geldige sessie
 * (app.session, runWithSession/withSession).
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
  createSession,
  ensureDatabase,
  hashToken,
  runMigrations,
  runWithSession,
  SEARCH_PATH,
  upsertUser,
  UnsafeAppLoginError,
  weekdoelen,
  withPurpose,
  withSession,
  withUser,
  type Db,
} from '../src';
import { eq } from 'drizzle-orm';

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
let hashA: string;
let hashB: string;

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
  // Gebruikers, sessies en rijen klaarzetten als de migratierol (lid van hz_auth en hz_worker); de app-login kan dat
  // niet (zie auth.test.ts, aanvalspad).
  seed = createDb(OWNER_URL, 1);
  A = (await upsertUser(seed.db, 'anna@homezero.nl', 'Anna')).id;
  B = (await upsertUser(seed.db, 'bram@homezero.nl', 'Bram')).id;
  hashA = hashToken((await createSession(seed.db, A, 'vitest-a')).token);
  hashB = hashToken((await createSession(seed.db, B, 'vitest-b')).token);
  for (const [uid, wat] of [
    [A, 'doel-a'],
    [B, 'doel-b'],
  ] as const)
    await withUser(seed.db, uid, (tx) => tx.insert(weekdoelen).values({ userId: uid, wat, week: '2026-W45' }));
}, 30_000);

let seed: ReturnType<typeof createDb>;

afterAll(async () => {
  await app?.close();
  await seed?.close();
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
      expect(await assertAppLogin(c)).toMatchObject({
        login: loginName,
        ownedRelations: 0,
        superuser: false,
        memberOf: [], // geen hz_worker (id's van alle collega's) en geen hz_indexer
      });
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
      // app.user_id alleen: deze login is niemand (0011)
      expect((await c.query('select wat from weekdoelen')).rows).toHaveLength(0);
      await c.query(`select set_config('app.session', '${hashA}', true)`);
      const rows = await c.query('select wat from weekdoelen');
      expect(rows.rows.map((r: { wat: string }) => r.wat)).toEqual(['doel-a']);
      await c.query('SAVEPOINT s1');
      await failsWith(c, 'ALTER TABLE weekdoelen NO FORCE ROW LEVEL SECURITY', '42501', /must be owner/);
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
  });

  it('withUser via deze login: alleen binnen de sessie van A, en A ziet nooit rijen van B', async () => {
    const a = await runWithSession(hashA, () => withUser(db, A, (tx) => tx.select().from(weekdoelen)));
    expect(a.map((r) => r.wat)).toEqual(['doel-a']);
    // binnen de sessie van A om B vragen: niemand
    const ab = await runWithSession(hashA, () => withUser(db, B, (tx) => tx.select().from(weekdoelen)));
    expect(ab).toHaveLength(0);
    // zonder sessie: app.user_id telt niet voor de app-login
    expect(await withUser(db, B, (tx) => tx.select().from(weekdoelen))).toHaveLength(0);
    const none = await db.execute(sql`select * from weekdoelen`);
    expect(none.rows).toHaveLength(0);
  });
});

describe('temp-tabel kan een collega niet nadoen (0013, criticus ronde 5)', () => {
  // Aanval: willekeurige SQL in de request van A maakt op een verbinding uit de pool een tijdelijke tabel met de naam van
  // een app-tabel (drizzle noemt tabellen zonder schema, pg_temp stond vooraan in het zoekpad). De volgende request op
  // die verbinding (van B) zou dan in de tabel van A schrijven en lezen. Pool met max=1: A en B delen gegarandeerd
  // dezelfde verbinding.
  let one: ReturnType<typeof createDb>;
  const pid = async (d: Db) => (await d.execute<{ p: number }>(sql`select pg_backend_pid() as p`)).rows[0]!.p;
  const err = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: PgErr & { cause?: PgErr }) => e.cause ?? e,
    );

  beforeAll(() => {
    one = createDb(loginUrl, 1);
  });
  afterAll(async () => {
    await one?.close();
  });

  it('CREATE TEMP TABLE weekdoelen in de sessie van A: 42501; ook geen temp-view, -sequence of -functie', async () => {
    const before = await pid(one.db);
    for (const stmt of [
      'create temp table weekdoelen (like public.weekdoelen)',
      'create temporary table weekdoelen as select * from public.weekdoelen',
      'create temp view weekdoelen as select * from public.weekdoelen',
      'create temp sequence s1',
      'create table pg_temp.weekdoelen (id uuid)',
      'create function pg_temp.app_user_id() returns uuid language sql as $$ select null::uuid $$',
    ]) {
      const e = await err(withSession(one.db, hashA, (tx) => tx.execute(sql.raw(stmt))));
      expect(e, stmt).not.toBeNull();
      expect(e!.code, stmt).toBe('42501');
      expect(e!.message ?? '', stmt).toMatch(/permission denied to create temporary tables/);
    }
    expect(await pid(one.db)).toBe(before); // nog steeds dezelfde verbinding
  });

  it('de rollen van de app hebben geen TEMP en geen CREATE (database en schema public); checkAppLogin ziet het', async () => {
    const r = await seed.db.execute<{ who: string; temp: boolean; cdb: boolean; cschema: boolean }>(sql`
      select who, has_database_privilege(who, current_database(), 'TEMPORARY') as temp,
        has_database_privilege(who, current_database(), 'CREATE') as cdb,
        has_schema_privilege(who, 'public', 'CREATE') as cschema
      from unnest(array[${loginName}, 'hz_app', 'hz_worker', 'hz_auth', 'hz_indexer']::text[]) as who`);
    for (const x of r.rows) expect(x, x.who).toEqual({ who: x.who, temp: false, cdb: false, cschema: false });
    const c = await one.pool.connect();
    try {
      expect((await checkAppLogin(c)).temp).toBe(false);
      expect((await c.query('show search_path')).rows[0].search_path).toBe(SEARCH_PATH);
    } finally {
      c.release();
    }
  });

  it('B schrijft na A in public.weekdoelen, en A ziet de rij van B in de volgende request niet', async () => {
    const p0 = await pid(one.db);
    // Request van A: probeert te overschaduwen (mislukt) en laat sessie-instellingen achter met een gewone SET
    // (geen SET LOCAL): een ander zoekpad en zijn eigen sessie op sessieniveau.
    await err(
      withSession(one.db, hashA, (tx) => tx.execute(sql`create temp table weekdoelen (like public.weekdoelen)`)),
    );
    await withSession(one.db, hashA, async (tx) => {
      await tx.execute(sql.raw('SET search_path = pg_temp, public'));
      await tx.execute(sql`select set_config('app.session', ${hashA}, false)`);
      await tx.execute(sql`select set_config('app.user_id', ${A}, false)`);
    });
    // Request van B op dezelfde verbinding
    expect(await pid(one.db)).toBe(p0);
    const ins = await withSession(one.db, hashB, async (tx) => {
      const path = (await tx.execute<{ p: string }>(sql`select current_setting('search_path') as p`)).rows[0]!.p;
      const rows = await tx
        .insert(weekdoelen)
        .values({ userId: B, wat: 'GEHEIM VAN B', week: '2026-W45' })
        .returning({ id: weekdoelen.id });
      const where = (
        await tx.execute<{ n: string }>(
          sql`select tableoid::regclass::text as n from weekdoelen where wat = 'GEHEIM VAN B'`,
        )
      ).rows[0]!.n;
      return { path, id: rows[0]!.id, where };
    });
    expect(ins.path).toBe(SEARCH_PATH); // RESET ALL aan het begin van de transactie
    expect(ins.where).toBe('weekdoelen'); // public.weekdoelen, geen pg_temp_N.weekdoelen
    // De rij staat echt in public.weekdoelen (gecontroleerd buiten deze verbinding, namens B als de migratierol)
    const echt = await withUser(seed.db, B, (tx) => tx.select().from(weekdoelen));
    expect(echt.map((r) => r.wat).sort()).toEqual(['GEHEIM VAN B', 'doel-b']);
    // Volgende request van A op dezelfde verbinding: alleen eigen rijen
    expect(await pid(one.db)).toBe(p0);
    const a = await withSession(one.db, hashA, (tx) => tx.select().from(weekdoelen));
    expect(a.map((r) => r.wat)).toEqual(['doel-a']);
    // Een request zonder sessie erft de app.session van A niet (RESET ALL): niemand
    expect(await withUser(one.db, B, (tx) => tx.select().from(weekdoelen))).toHaveLength(0);
    const anon = await withPurpose(one.db, 'system', (tx) => tx.select().from(weekdoelen));
    expect(anon).toHaveLength(0);
    await withUser(seed.db, B, (tx) => tx.delete(weekdoelen).where(eq(weekdoelen.id, ins.id)));
  });

  it('assertAppLogin weigert een login die toch TEMP heeft (bijv. een database van vóór 0013)', async () => {
    // De eigenaar van de testdatabase (de migratierol) verleent het even los aan hz_app.
    const owner = new pg.Client({ connectionString: OWNER_URL });
    await owner.connect();
    const db_ = new URL(OWNER_URL).pathname.slice(1);
    try {
      await owner.query(`GRANT TEMPORARY ON DATABASE ${db_} TO hz_app`);
      const bad = createDb(loginUrl, 1, { env: { NODE_ENV: 'production' } });
      try {
        const e = await err(bad.db.execute(sql`select 1`));
        expect(e).not.toBeNull();
        expect(e!.message ?? '').toMatch(/tijdelijke tabellen/);
      } finally {
        await bad.close();
      }
    } finally {
      await owner.query(`REVOKE TEMPORARY ON DATABASE ${db_} FROM hz_app`);
      await owner.end();
    }
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
      const rows = await withSession(good.db, hashB, (tx) => tx.select().from(weekdoelen));
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

describe('CI maakt de app-login aan', () => {
  it('de workflow draait sql/app-login.sql na bootstrap-roles.sql', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, resolve } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const wf = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.github/workflows/workspace-app.yml');
    const text = readFileSync(wf, 'utf8');
    const boot = text.indexOf('-f packages/db/sql/bootstrap-roles.sql');
    const login = text.indexOf('-v login=hz_app_login -v password=hz_app_login -f packages/db/sql/app-login.sql');
    expect(boot).toBeGreaterThan(0);
    expect(login).toBeGreaterThan(boot);
  });
});
