/**
 * HZW-020 (stuk E2): de worker gebruikt twee verbindingen, zoals in productie. pg-boss draait in een eigen schema met
 * een eigen login hz_boss (sql/boss-login.sql: eigenaar van alleen dat schema); app-tabellen gaan via createDb() als
 * hz_app met de aparte worker-login (sql/worker-login.sql: lid van hz_app en hz_worker). Alleen hz_worker mag de id's
 * van alle collega's opvragen (system_active_user_ids, 0010); de api-login (hz_app_login) niet. In productie weigert
 * de worker een pg-boss-login die eigenaar is van app-tabellen (de migratierol). Eigen, verse database
 * (hz_e2_test_worker_app).
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activeUserIds,
  checkAppLogin,
  createDb,
  createOwnerDb,
  ensureDatabase,
  runMigrations,
  UnsafeBossLoginError,
  upsertUser,
  weekdoelen,
  withPurpose,
  withUser,
  withWorker,
} from '@hz/db';
import { createProviders } from '@hz/providers';
import { QUEUES } from '../src/jobs';
import { checkBossConnection, startWorker } from '../src/worker';

const OWNER_URL =
  process.env.HZ_TEST_DATABASE_URL_WORKER_APP ?? 'postgres://hz_dev:hz_dev@localhost:5432/hz_e2_test_worker_app';
const withLogin = (login: string) => {
  const u = new URL(OWNER_URL);
  const [user, pw] = login.split(':');
  u.username = user!;
  u.password = pw ?? '';
  return u.toString();
};
const APP_URL = withLogin(process.env.HZ_TEST_APP_LOGIN ?? 'hz_app_login:hz_app_login');
const WORKER_URL = withLogin(process.env.HZ_TEST_WORKER_LOGIN ?? 'hz_worker_login:hz_worker_login');
const WORKER_LOGIN = new URL(WORKER_URL).username;
const BOSS_URL = withLogin(process.env.HZ_TEST_BOSS_LOGIN ?? 'hz_boss:hz_boss_test');
const BOSS_LOGIN = new URL(BOSS_URL).username;
const SCHEMA = 'pgboss_e2_test';
const PROD = { NODE_ENV: 'production' };

let w: Awaited<ReturnType<typeof startWorker>>;
const logs: string[] = [];

beforeAll(async () => {
  await ensureDatabase(OWNER_URL, { recreate: true });
  await runMigrations(OWNER_URL);
  // Wat sql/boss-login.sql per database doet (de login zelf bestaat al, zie README): CREATE op de database, zodat
  // pg-boss zijn eigen schema kan maken. Hier als eigenaar van de testdatabase.
  const owner = createOwnerDb(OWNER_URL, 1);
  try {
    const dbName = new URL(OWNER_URL).pathname.slice(1);
    await owner.db.execute(sql.raw(`grant connect, create on database "${dbName}" to "${BOSS_LOGIN}"`));
  } finally {
    await owner.close();
  }
  const seed = createDb(APP_URL, 1);
  try {
    const A = (await upsertUser(seed.db, 'anna@homezero.nl', 'Anna')).id;
    const B = (await upsertUser(seed.db, 'bram@homezero.nl', 'Bram')).id;
    await withUser(seed.db, A, (tx) =>
      tx.insert(weekdoelen).values([
        { userId: A, wat: 'a1', week: '2026-W45' },
        { userId: A, wat: 'a2', week: '2026-W45', status: 'klaar' },
      ]),
    );
    await withUser(seed.db, B, (tx) =>
      tx.insert(weekdoelen).values([
        { userId: B, wat: 'b1', week: '2026-W45' },
        { userId: B, wat: 'b2', week: '2026-W45' },
      ]),
    );
  } finally {
    await seed.close();
  }
  // Zoals in productie: met NODE_ENV=production en de controles aan.
  w = await startWorker({
    connectionString: BOSS_URL,
    schema: SCHEMA,
    databaseUrl: WORKER_URL,
    bundle: createProviders({}),
    log: (m) => logs.push(m),
    env: PROD,
  });
}, 30_000);

afterAll(async () => {
  await w?.stop();
});

async function waitFor(queue: string, id: string) {
  for (let i = 0; i < 80; i++) {
    const job = await w.boss.getJobById(queue, id);
    if (job?.state === 'completed' || job?.state === 'failed') return job;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

describe('worker: pg-boss apart, app-tabellen als hz_app', () => {
  it('een job op app-tabellen draait als hz_app via de worker-login en telt per collega onder RLS', async () => {
    const id = await w.sendTelWeekdoelen();
    const job = await waitFor(QUEUES.telWeekdoelen, id!);
    expect(job?.state).toBe('completed');
    expect(job?.output).toEqual({ gebruikers: 2, open: 3, rol: 'hz_app', login: WORKER_LOGIN });
    expect(logs.some((l) => l.includes('3 open bij 2'))).toBe(true);
  }, 30_000);

  it('de app-verbinding van de worker is geen eigenaar van iets, ook niet van het pg-boss-schema', async () => {
    const r = await w.db.execute<{ cu: string; su: string }>(sql`select current_user as cu, session_user as su`);
    expect(r.rows[0]).toEqual({ cu: 'hz_app', su: WORKER_LOGIN });
    const app = createDb(WORKER_URL, 1);
    const c = await app.pool.connect();
    try {
      expect((await checkAppLogin(c)).ownedRelations).toBe(0);
    } finally {
      c.release();
      await app.close();
    }
  });

  it('pg-boss staat in een eigen schema met eigenaar hz_boss (niet de migratierol, niet hz_app)', async () => {
    const owner = createOwnerDb(OWNER_URL, 1);
    try {
      const s = await owner.db.execute<{ owner: string }>(
        sql`select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = ${SCHEMA}`,
      );
      expect(s.rows[0]!.owner).toBe(BOSS_LOGIN);
      expect(s.rows[0]!.owner).not.toBe(new URL(OWNER_URL).username);
      expect(s.rows[0]!.owner).not.toBe('hz_app');
      // Alles wat pg-boss maakte hoort bij hz_boss en staat in zijn schema; hz_boss bezit niets anders
      const own = await owner.db.execute<{ buiten: number; binnen: number }>(sql`
        select count(*) filter (where n.nspname <> ${SCHEMA})::int as buiten,
               count(*) filter (where n.nspname = ${SCHEMA})::int as binnen
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relowner = (select oid from pg_roles where rolname = ${BOSS_LOGIN}) and n.nspname not like 'pg\_toast%'`);
      expect(own.rows[0]).toMatchObject({ buiten: 0 });
      expect(own.rows[0]!.binnen).toBeGreaterThan(0);
      const inPublic = await owner.db.execute<{ n: number }>(
        sql`select count(*)::int as n from pg_tables where schemaname = 'public' and tablename in ('job', 'queue', 'version')`,
      );
      expect(inPublic.rows[0]!.n).toBe(0);
    } finally {
      await owner.close();
    }
    const e = await w.db.execute(sql.raw(`select * from ${SCHEMA}.job`)).then(
      () => null,
      (x: { code?: string; cause?: { code?: string } }) => x,
    );
    expect(e?.cause?.code ?? e?.code).toBe('42501');
  });
});

describe('worker-rol: alleen de worker-login kent de id’s van alle collega’s (0010)', () => {
  type E = { code?: string; cause?: { code?: string } };
  const codeOf = (e: E | null) => e?.cause?.code ?? e?.code;

  it('de api-login (hz_app_login) kan system_active_user_ids() niet uitvoeren, ook niet met app.purpose', async () => {
    const api = createDb(APP_URL, 1);
    try {
      const plain = await activeUserIds(api.db).then(
        () => null,
        (e: E) => e,
      );
      expect(codeOf(plain)).toBe('42501');
      for (const purpose of ['system', 'auth'] as const) {
        const e = await withPurpose(api.db, purpose, (tx) =>
          tx.execute(sql`select * from system_active_user_ids()`),
        ).then(
          () => null,
          (x: E) => x,
        );
        expect(codeOf(e), purpose).toBe('42501');
      }
      // en worden kan hij het ook niet
      const e = await api.db.execute(sql`set role hz_worker`).then(
        () => null,
        (x: E) => x,
      );
      expect(codeOf(e)).toBe('42501');
    } finally {
      await api.close();
    }
  });

  it('de worker-login wel, als hz_worker; hz_worker zelf heeft geen tabelrechten', async () => {
    const wk = createDb(WORKER_URL, 1);
    try {
      expect((await activeUserIds(wk.db)).length).toBe(2);
      const e = await withWorker(wk.db, (tx) => tx.execute(sql`select * from weekdoelen`)).then(
        () => null,
        (x: E) => x,
      );
      expect(codeOf(e)).toBe('42501');
    } finally {
      await wk.close();
    }
  });

  it('in productie weigert createDb() voor de api een login die lid is van hz_worker; de worker staat hem toe', async () => {
    const asApi = createDb(WORKER_URL, 1, { env: PROD });
    try {
      const e = await asApi.db.execute(sql`select 1`).then(
        () => null,
        (x: Error & { cause?: Error }) => x.cause ?? x,
      );
      expect(e).toMatchObject({ name: 'UnsafeAppLoginError', message: expect.stringMatching(/lid van hz_worker/) });
    } finally {
      await asApi.close();
    }
    const asWorker = createDb(WORKER_URL, 1, { env: PROD, allowRoles: ['hz_worker'] });
    try {
      expect((await asWorker.db.execute(sql`select 1 as x`)).rows[0]).toEqual({ x: 1 });
    } finally {
      await asWorker.close();
    }
    // De api-login zelf is in productie in orde (alleen hz_app)
    const api = createDb(APP_URL, 1, { env: PROD });
    try {
      expect((await api.db.execute(sql`select 1 as x`)).rows[0]).toEqual({ x: 1 });
    } finally {
      await api.close();
    }
  });
});

describe('worker: productiecontrole van de pg-boss-login', () => {
  it('weigert in productie een HZ_BOSS_DATABASE_URL van de migratierol (eigenaar van app-tabellen)', async () => {
    await expect(
      startWorker({
        connectionString: OWNER_URL,
        schema: 'pgboss_e2_geweigerd',
        databaseUrl: WORKER_URL,
        bundle: createProviders({}),
        env: PROD,
      }),
    ).rejects.toMatchObject({ name: 'UnsafeBossLoginError', message: expect.stringMatching(/eigenaar van \d+ tabel/) });
    await expect(checkBossConnection(OWNER_URL, SCHEMA)).rejects.toBeInstanceOf(UnsafeBossLoginError);
    // en er is niets aangemaakt
    const owner = createOwnerDb(OWNER_URL, 1);
    try {
      const r = await owner.db.execute(sql`select 1 from pg_namespace where nspname = 'pgboss_e2_geweigerd'`);
      expect(r.rows).toHaveLength(0);
    } finally {
      await owner.close();
    }
  });

  it('hz_boss mag alleen eigenaar zijn van zijn eigen schema: dat telt niet mee, de rest wel', async () => {
    const ok = await checkBossConnection(BOSS_URL, SCHEMA);
    expect(ok).toMatchObject({ login: BOSS_LOGIN, superuser: false, bypassRls: false, ownedRelations: 0 });
    // Vanuit een ander schema gezien is hz_boss wel eigenaar van tabellen (die van pgboss_e2_test)
    await expect(checkBossConnection(BOSS_URL, 'pgboss_ander')).rejects.toBeInstanceOf(UnsafeBossLoginError);
  });

  it('weigert in productie dezelfde URL voor pg-boss en app-tabellen', async () => {
    await expect(
      startWorker({ connectionString: BOSS_URL, schema: SCHEMA, bundle: createProviders({}), env: PROD }),
    ).rejects.toThrow(/verschillend/);
  });

  it('hz_boss kan niet bij app-tabellen en kan geen hz_app worden', async () => {
    const boss = createOwnerDb(BOSS_URL, 1);
    try {
      for (const q of [sql`select * from weekdoelen`, sql`set role hz_app`, sql`create table public.x (a int)`]) {
        const e = await boss.db.execute(q).then(
          () => null,
          (x: { code?: string; cause?: { code?: string } }) => x,
        );
        expect(e?.cause?.code ?? e?.code).toBe('42501');
      }
    } finally {
      await boss.close();
    }
  });
});
