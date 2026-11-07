/**
 * Samenvoegen golf A: de tabellen en functies van stuk E1 (0014/0015) en E3 (0016/0017) onder de rollen van stuk E2.
 * - E1: de inlogfuncties alleen als hz_auth; overal uitloggen vanuit een request (hz_app, binnen de sessie).
 * - E3: planning en push-events van alle collega's (app.purpose = 'system') alleen voor de worker-login (hz_worker),
 *   niet voor de api-login; webhooks in de api via de functies sync_hook_*.
 * Eigen, verse database (hz_merge_test_roles) op localhost:5432; logins met testwachtwoord = loginnaam.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAuthDb,
  createDb,
  createSession,
  ensureDatabase,
  ensureSyncJobs,
  getOnboarding,
  hashToken,
  recordSyncEvent,
  requestSync,
  revokeAllOwnSessions,
  runMigrations,
  runWithSession,
  syncUsers,
  upsertUser,
  userByAccount,
  usersWithJob,
  withPurpose,
  withUser,
  type Db,
} from '../src';
import * as auth from '../src/auth';

const URL_ = process.env.HZ_TEST_DATABASE_URL_MERGE ?? 'postgres://hz_dev:hz_dev@localhost:5432/hz_merge_test_roles';
const asLogin = (login: string) => {
  const u = new URL(URL_);
  u.username = login;
  u.password = login;
  return u.toString();
};

let dev: ReturnType<typeof createDb>;
let api: ReturnType<typeof createDb>;
let worker: ReturnType<typeof createDb>;
let authDb: ReturnType<typeof createAuthDb>;
let A: string;
let B: string;
let tokenA: string;

type Err = { code?: string; cause?: { code?: string } };
const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: Err) => e.code ?? e.cause?.code ?? 'onbekend',
  );

beforeAll(async () => {
  await ensureDatabase(URL_, { recreate: true });
  await runMigrations(URL_);
  dev = createDb(URL_, 2);
  api = createDb(asLogin('hz_app_login'), 2);
  worker = createDb(asLogin('hz_worker_login'), 2);
  authDb = createAuthDb(asLogin('hz_auth_login'), 2);
  A = (await auth.createUser(authDb.db, 'anna@homezero.nl', 'Anna', { onboarding: true })).id;
  B = (await upsertUser(authDb.db, 'bram@homezero.nl', 'Bram')).id;
  tokenA = (await createSession(authDb.db, A, 'vitest-a')).token;
  await ensureSyncJobs(dev.db, A, [{ provider: 'slack', account: 'UANNA' }]);
  await ensureSyncJobs(dev.db, B, [{ provider: 'slack', account: 'UBRAM' }]);
}, 30_000);

afterAll(async () => {
  await Promise.all([dev?.close(), api?.close(), worker?.close(), authDb?.close()]);
});

const allJobs = (db: Db) =>
  withPurpose(db, 'system', async (tx) => (await tx.execute(sql`select user_id from sync_jobs`)).rows.length);

describe('E1 onder de rollen van E2', () => {
  it('de inlogfuncties van E1 werken als hz_auth en niet voor de api-login', async () => {
    expect(await auth.allowlistLookup(authDb.db, 'robert@homezero.nl')).toEqual({ role: 'admin' });
    expect(await codeOf(auth.allowlistLookup(api.db, 'robert@homezero.nl'))).toBe('42501');
    expect(await codeOf(auth.getUserById(api.db, A))).toBe('42501');
    expect((await auth.getUserById(authDb.db, A))?.email).toBe('anna@homezero.nl');
  });

  it('de onboarding-rij bij de eerste login staat er, en alleen Anna ziet hem (binnen haar sessie)', async () => {
    const own = await runWithSession(hashToken(tokenA), () => getOnboarding(api.db, A));
    expect(own?.status).toBe('new');
    expect(await getOnboarding(api.db, A)).toBeNull();
  });

  it('auth_audit_event alleen voor acties over inloggen en sessies', async () => {
    await auth.auditAuthEvent(authDb.db, A, 'session.via', 'vitest');
    expect(await codeOf(auth.auditAuthEvent(authDb.db, A, 'admin.blocked', 'x'))).toBe('22023');
  });

  it('overal uitloggen vanuit een request trekt alleen de eigen sessies in', async () => {
    const tokenB = (await createSession(authDb.db, B, 'vitest-b')).token;
    const second = (await createSession(authDb.db, A, 'vitest-a2')).token;
    // Zonder sessie (de api-login, app.user_id alleen): niemand, dus niets ingetrokken.
    expect(await revokeAllOwnSessions(api.db, A)).toBe(0);
    expect(await runWithSession(hashToken(second), () => revokeAllOwnSessions(api.db, A))).toBe(2);
    const valid = async (t: string) =>
      (
        await authDb.db.transaction(async (tx) => {
          await tx.execute(sql`set local role hz_auth`);
          return tx.execute(sql`select count(*)::int as n from auth_session_by_token(${hashToken(t)})`);
        })
      ).rows[0] as { n: number };
    expect((await valid(tokenA)).n).toBe(0);
    expect((await valid(tokenB)).n).toBe(1);
  });
});

describe('E3 onder de rollen van E2', () => {
  it("app.purpose = 'system' opent sync_jobs alleen voor de worker-login, niet voor de api-login", async () => {
    expect(await allJobs(worker.db)).toBe(2);
    expect(await allJobs(api.db)).toBe(0);
  });

  it('de api-login kan zich niet als hz_worker voordoen of de lijst met collega-ids opvragen', async () => {
    expect(await codeOf(syncUsers(api.db))).toBe('42501');
    expect((await syncUsers(worker.db)).sort()).toEqual([A, B].sort());
  });

  it('webhooks in de api: collega bij een account, event ontdubbelen en run naar voren halen via sync_hook_*', async () => {
    expect(await userByAccount(api.db, 'slack', 'ubram')).toBe(B);
    expect((await usersWithJob(api.db, 'slack')).map((x) => x.userId).sort()).toEqual([A, B].sort());
    expect(await recordSyncEvent(api.db, 'slack', 'Ev1:' + B, B, {})).toBe(true);
    expect(await recordSyncEvent(api.db, 'slack', 'Ev1:' + B, B, {})).toBe(false);
    await withUser(dev.db, B, (tx) =>
      tx.execute(sql`update sync_jobs set next_run_at = now() + interval '1 day' where provider = 'slack'`),
    );
    await requestSync(api.db, B, 'slack');
    const next = await withUser(dev.db, B, async (tx) => {
      const r = await tx.execute(sql`select next_run_at <= now() as due from sync_jobs where provider = 'slack'`);
      return (r.rows[0] as { due: boolean }).due;
    });
    expect(next).toBe(true);
  });

  it('de api-login leest of wijzigt geen planning of events van een ander, ook niet met app.purpose', async () => {
    const r = await withPurpose(api.db, 'system', async (tx) => {
      const ev = await tx.execute(sql`select count(*)::int as n from sync_events`);
      const upd = await tx.execute(sql`update sync_jobs set failures = 99`);
      return { ev: (ev.rows[0] as { n: number }).n, upd: upd.rowCount };
    });
    expect(r).toEqual({ ev: 0, upd: 0 });
  });
});
