/**
 * HZW-020 (stuk E2): de worker gebruikt twee verbindingen. pg-boss draait in een eigen schema met een eigen login
 * (hier de migratierol hz_dev, in productie HZ_BOSS_DATABASE_URL); app-tabellen gaan via createDb() als hz_app, hier
 * met de aparte app-login (sql/app-login.sql), zoals in productie. Eigen, verse database (hz_e2_test_worker_app).
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkAppLogin,
  createDb,
  createOwnerDb,
  ensureDatabase,
  runMigrations,
  upsertUser,
  weekdoelen,
  withUser,
} from '@hz/db';
import { createProviders } from '@hz/providers';
import { QUEUES } from '../src/jobs';
import { startWorker } from '../src/worker';

const OWNER_URL =
  process.env.HZ_TEST_DATABASE_URL_WORKER_APP ?? 'postgres://hz_dev:hz_dev@localhost:5432/hz_e2_test_worker_app';
const LOGIN = process.env.HZ_TEST_APP_LOGIN ?? 'hz_app_login:hz_app_login';
const APP_URL = (() => {
  const u = new URL(OWNER_URL);
  const [user, pw] = LOGIN.split(':');
  u.username = user!;
  u.password = pw ?? '';
  return u.toString();
})();
const SCHEMA = 'pgboss_e2_test';

let w: Awaited<ReturnType<typeof startWorker>>;
const logs: string[] = [];

beforeAll(async () => {
  await ensureDatabase(OWNER_URL, { recreate: true });
  await runMigrations(OWNER_URL);
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
  w = await startWorker({
    connectionString: OWNER_URL,
    schema: SCHEMA,
    databaseUrl: APP_URL,
    bundle: createProviders({}),
    log: (m) => logs.push(m),
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
  it('een job op app-tabellen draait als hz_app via de app-login en telt per collega onder RLS', async () => {
    const id = await w.sendTelWeekdoelen();
    const job = await waitFor(QUEUES.telWeekdoelen, id!);
    expect(job?.state).toBe('completed');
    expect(job?.output).toEqual({ gebruikers: 2, open: 3, rol: 'hz_app', login: 'hz_app_login' });
    expect(logs.some((l) => l.includes('3 open bij 2'))).toBe(true);
  }, 30_000);

  it('de app-verbinding van de worker is geen eigenaar van iets, ook niet van het pg-boss-schema', async () => {
    const r = await w.db.execute<{ cu: string; su: string }>(sql`select current_user as cu, session_user as su`);
    expect(r.rows[0]).toEqual({ cu: 'hz_app', su: 'hz_app_login' });
    const app = createDb(APP_URL, 1);
    const c = await app.pool.connect();
    try {
      expect((await checkAppLogin(c)).ownedRelations).toBe(0);
    } finally {
      c.release();
      await app.close();
    }
  });

  it('pg-boss staat in een eigen schema met een eigen eigenaar; hz_app kan er niet bij', async () => {
    const owner = createOwnerDb(OWNER_URL, 1);
    try {
      const s = await owner.db.execute<{ owner: string }>(
        sql`select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = ${SCHEMA}`,
      );
      expect(s.rows[0]!.owner).toBe(new URL(OWNER_URL).username);
      expect(s.rows[0]!.owner).not.toBe('hz_app');
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
