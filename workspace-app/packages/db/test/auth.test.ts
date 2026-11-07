/**
 * HZW-020 (stuk E2): inloggen zonder open SELECT op users en sessions.
 * app.purpose is een GUC die elke transactie kan zetten; daarom geeft 'auth' of 'system' geen leesrecht meer.
 * Inloggen, sessies en de worker gaan via SECURITY DEFINER-functies die precies één sleutel opzoeken.
 * Eigen, verse database (hz_e2_test_auth) op localhost:5432.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activeUserIds,
  createDb,
  createOwnerDb,
  createSession,
  ensureDatabase,
  findSession,
  findUserByEmail,
  hashToken,
  revokeSession,
  runMigrations,
  sessions,
  touchSession,
  upsertUser,
  users,
  withPurpose,
  withUser,
  type Db,
} from '../src';

const URL_ = process.env.HZ_TEST_DATABASE_URL_AUTH ?? 'postgres://hz_dev:hz_dev@localhost:5432/hz_e2_test_auth';
let db: Db;
let close: () => Promise<void>;
let owner: ReturnType<typeof createOwnerDb>;
let A: string;
let B: string;
let tokenA: string;
let tokenB: string;

beforeAll(async () => {
  await ensureDatabase(URL_, { recreate: true });
  await runMigrations(URL_);
  ({ db, close } = createDb(URL_, 4));
  owner = createOwnerDb(URL_, 1);
  A = (await upsertUser(db, 'anna@homezero.nl', 'Anna')).id;
  B = (await upsertUser(db, 'bram@homezero.nl', 'Bram')).id;
  tokenA = (await createSession(db, A, 'vitest-a')).token;
  tokenB = (await createSession(db, B, 'vitest-b')).token;
}, 30_000);

afterAll(async () => {
  await close?.();
  await owner?.close();
});

type Err = { code?: string; message?: string; cause?: { code?: string; message?: string } };
const errOf = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: Err) => e,
  );
const codeOf = (e: Err | null) => e?.cause?.code ?? e?.code;

describe('app.purpose opent niets meer op users en sessions', () => {
  for (const purpose of ['auth', 'system'] as const) {
    it(`withPurpose('${purpose}') ziet geen enkele gebruiker of sessie`, async () => {
      const r = await withPurpose(db, purpose, async (tx) => ({
        u: await tx.select().from(users),
        s: await tx.select().from(sessions),
      }));
      expect(r.u).toHaveLength(0);
      expect(r.s).toHaveLength(0);
    });
  }

  it('een gewone request-transactie die zelf app.purpose=auth zet, ziet alleen zichzelf', async () => {
    const r = await withUser(db, A, async (tx) => {
      await tx.execute(sql`select set_config('app.purpose', 'auth', true)`);
      await tx.execute(sql`select set_config('app.purpose', 'system', false)`);
      await tx.execute(sql`select set_config('app.purpose', 'auth', true)`);
      return {
        purpose: (await tx.execute<{ p: string }>(sql`select current_setting('app.purpose') as p`)).rows[0]!.p,
        u: await tx.select({ email: users.email }).from(users),
        s: await tx.select({ userId: sessions.userId }).from(sessions),
      };
    });
    expect(r.purpose).toBe('auth');
    expect(r.u.map((x) => x.email)).toEqual(['anna@homezero.nl']);
    expect(r.s.length).toBeGreaterThan(0);
    expect(r.s.every((x) => x.userId === A)).toBe(true);
    // ook de sessiewaarde (set_config(..., false)) mag na de transactie niets openen
    const after = await db.execute(sql`select * from users`);
    expect(after.rows).toHaveLength(0);
  });

  it('zonder gebruiker maar met app.purpose=auth op sessieniveau: nog steeds niets', async () => {
    const c = await (db.$client as import('pg').Pool).connect();
    try {
      await c.query(`select set_config('app.purpose', 'auth', false)`);
      expect((await c.query('select * from users')).rows).toHaveLength(0);
      expect((await c.query('select * from sessions')).rows).toHaveLength(0);
    } finally {
      await c.query(`select set_config('app.purpose', '', false)`);
      c.release();
    }
  });

  it('de app kan geen gebruiker rechtstreeks aanmaken of een sessie namens een ander invoegen', async () => {
    const e1 = await errOf(
      withPurpose(db, 'auth', (tx) => tx.insert(users).values({ email: 'kaper@homezero.nl', name: 'Kaper' })),
    );
    expect(codeOf(e1)).toBe('42501');
    const e2 = await errOf(
      withUser(db, A, (tx) =>
        tx.insert(sessions).values({ userId: B, tokenHash: hashToken('x'), expiresAt: new Date(Date.now() + 1e6) }),
      ),
    );
    expect(codeOf(e2)).toBe('42501');
  });

  it('ook het auditlog schrijft een request alleen voor zichzelf', async () => {
    const e = await errOf(
      withUser(db, A, async (tx) => {
        await tx.execute(sql`select set_config('app.purpose', 'auth', true)`);
        await tx.execute(sql`insert into audit_log (user_id, action) values (${B}::uuid, 'vervalst')`);
      }),
    );
    expect(codeOf(e)).toBe('42501');
  });
});

describe('SECURITY DEFINER-functies: precies één sleutel', () => {
  it('sessie bij token: juist token geeft de gebruiker, verkeerd of leeg token niets', async () => {
    expect((await findSession(db, tokenA))?.user.email).toBe('anna@homezero.nl');
    expect((await findSession(db, tokenB))?.user.id).toBe(B);
    expect(await findSession(db, 'onzin')).toBeNull();
    expect(await findSession(db, '')).toBeNull();
  });

  it('geen patroon of ongeldige hash: auth_session_by_token geeft niets terug', async () => {
    for (const probe of ['%', '.*', "' or true --", 'a'.repeat(63), hashToken(tokenA).toUpperCase()]) {
      const r = await withPurpose(db, 'auth', (tx) => tx.execute(sql`select * from auth_session_by_token(${probe})`));
      expect(r.rows, probe).toHaveLength(0);
    }
  });

  it('gebruiker bij e-mail: hoofdletterongevoelig, alleen exacte match', async () => {
    expect((await findUserByEmail(db, 'ANNA@homezero.nl'))?.id).toBe(A);
    expect(await findUserByEmail(db, '%@homezero.nl')).toBeNull();
    expect(await findUserByEmail(db, 'anna@')).toBeNull();
  });

  it('upsert is idempotent, wijzigt een bestaande gebruiker niet en weigert onzin', async () => {
    const again = await upsertUser(db, 'Anna@HomeZero.nl', 'Andere naam', 'admin');
    expect(again).toMatchObject({ id: A, name: 'Anna', role: 'member' });
    await expect(upsertUser(db, 'geen-adres', 'X')).rejects.toThrow();
    await expect(upsertUser(db, 'x@homezero.nl', 'X', 'root' as 'admin')).rejects.toThrow();
  });

  it('sessie maken weigert een ruw token, een verloopdatum in het verleden en een onbekende gebruiker', async () => {
    const future = new Date(Date.now() + 864e5).toISOString();
    const call = (uid: string, hash: string, exp: string) =>
      errOf(
        withPurpose(db, 'auth', (tx) =>
          tx.execute(sql`select auth_create_session(${uid}::uuid, ${hash}, 'x', ${exp}::timestamptz)`),
        ),
      );
    expect(await call(A, 'ruw-token', future)).not.toBeNull();
    expect(await call(A, hashToken('t1'), new Date(Date.now() - 1000).toISOString())).not.toBeNull();
    expect(await call('00000000-0000-0000-0000-000000000000', hashToken('t2'), future)).not.toBeNull();
  });

  it('verlopen, ingetrokken of geblokkeerd: geen sessie', async () => {
    const t1 = (await createSession(db, A, 'verloopt')).token;
    await owner.db.execute(
      sql`update sessions set expires_at = now() - interval '1 minute' where token_hash = ${hashToken(t1)}`,
    );
    expect(await findSession(db, t1)).toBeNull();
    expect(await touchSession(db, t1)).toBe(false);

    const t2 = (await createSession(db, A, 'intrekken')).token;
    expect(await revokeSession(db, t2)).toBe(true);
    expect(await revokeSession(db, t2)).toBe(false);
    expect(await findSession(db, t2)).toBeNull();

    const C = (await upsertUser(db, 'cees@homezero.nl', 'Cees')).id;
    const t3 = (await createSession(db, C, 'blok')).token;
    expect((await findSession(db, t3))?.user.id).toBe(C);
    await owner.db.execute(sql`update users set blocked_at = now() where id = ${C}`);
    expect(await findSession(db, t3)).toBeNull();
    expect(await activeUserIds(db)).not.toContain(C);
  });

  it('glijdende sessie: touch verlengt een geldige sessie', async () => {
    const later = new Date(Date.now() + 90 * 864e5);
    expect(await touchSession(db, tokenB, later)).toBe(true);
    const s = await findSession(db, tokenB);
    expect(Math.abs(s!.session.expiresAt.getTime() - later.getTime())).toBeLessThan(1000);
  });

  it('worker: alleen id’s van actieve collega’s', async () => {
    const ids = await activeUserIds(db);
    expect(ids).toEqual(expect.arrayContaining([A, B]));
    const r = await withPurpose(db, 'system', (tx) => tx.execute(sql`select * from system_active_user_ids()`));
    expect(Object.keys(r.rows[0]!)).toEqual(['system_active_user_ids']);
  });

  it('inloggen schrijft het auditlog via de functie (A ziet zijn eigen regels)', async () => {
    const log = await withUser(db, A, (tx) => tx.execute<{ action: string }>(sql`select action from audit_log`));
    const actions = log.rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['user.created', 'session.created', 'session.revoked']));
  });
});

describe('de functies zelf: eigenaar, rechten en zoekpad', () => {
  const FNS = [
    'auth_user_by_email',
    'auth_upsert_user',
    'auth_create_session',
    'auth_session_by_token',
    'auth_touch_session',
    'auth_revoke_session',
    'system_active_user_ids',
  ];
  const FNS_ARR = `{${FNS.join(',')}}`;

  it('SECURITY DEFINER, eigenaar is de migratierol (niet hz_app), vast search_path', async () => {
    const r = await owner.db.execute<{ proname: string; prosecdef: boolean; owner: string; cfg: string[] | null }>(sql`
      select proname, prosecdef, pg_get_userbyid(proowner) as owner, proconfig as cfg
      from pg_proc where pronamespace = 'public'::regnamespace and proname = any(${FNS_ARR}::text[])`);
    expect(r.rows.map((x) => x.proname).sort()).toEqual([...FNS].sort());
    const me = (await owner.db.execute<{ u: string }>(sql`select current_user as u`)).rows[0]!.u;
    for (const f of r.rows) {
      expect(f.prosecdef, f.proname).toBe(true);
      expect(f.owner, f.proname).toBe(me);
      expect(f.owner).not.toBe('hz_app');
      expect((f.cfg ?? []).join(','), f.proname).toMatch(/search_path=pg_catalog, public, pg_temp/);
    }
  });

  it('PUBLIC mag ze niet uitvoeren; hz_app wel', async () => {
    const r = await owner.db.execute<{ proname: string; grantee: string }>(sql`
      select p.proname, coalesce(nullif(pg_get_userbyid(a.grantee), '-'), 'PUBLIC') as grantee
      from pg_proc p, aclexplode(p.proacl) a
      where p.pronamespace = 'public'::regnamespace and p.proname = any(${FNS_ARR}::text[]) and a.privilege_type = 'EXECUTE'`);
    for (const f of FNS) {
      const grantees = r.rows.filter((x) => x.proname === f).map((x) => x.grantee);
      expect(grantees, f).toContain('hz_app');
      expect(grantees, f).not.toContain('PUBLIC');
    }
    const pub = await owner.db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_proc p, aclexplode(p.proacl) a
      where p.proname = any(${FNS_ARR}::text[]) and a.grantee = 0`);
    expect(pub.rows[0]!.n).toBe(0);
  });

  it('de definer-regels gelden alleen voor de migratierol; hz_app is daar geen lid van', async () => {
    const r = await owner.db.execute<{ polname: string; roles: string }>(sql`
      select polname, (select string_agg(pg_get_userbyid(x), ',') from unnest(polroles) x) as roles
      from pg_policy where polname like '%\_definer'`);
    const me = (await owner.db.execute<{ u: string }>(sql`select current_user as u`)).rows[0]!.u;
    expect(r.rows.map((x) => x.polname).sort()).toEqual(['audit_definer', 'sessions_definer', 'users_definer']);
    for (const p of r.rows) expect(p.roles).toBe(me);
    const m = await db.execute<{ member: boolean }>(sql`select pg_has_role('hz_app', ${me}, 'MEMBER') as member`);
    expect(m.rows[0]!.member).toBe(false);
  });

  it('geen regel op users, sessions of audit_log noemt app.purpose nog', async () => {
    const r = await owner.db.execute<{ polname: string; q: string | null; c: string | null }>(sql`
      select polname, pg_get_expr(polqual, polrelid) as q, pg_get_expr(polwithcheck, polrelid) as c
      from pg_policy where polrelid in ('users'::regclass, 'sessions'::regclass, 'audit_log'::regclass)`);
    expect(r.rows.length).toBeGreaterThan(0);
    for (const p of r.rows) expect(`${p.q} ${p.c}`, p.polname).not.toMatch(/app_purpose/);
  });
});
