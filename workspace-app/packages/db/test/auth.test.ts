/**
 * HZW-020 (stuk E2): inloggen zonder open SELECT op users en sessions.
 * app.purpose is een GUC die elke transactie kan zetten; daarom geeft 'auth' of 'system' geen leesrecht meer.
 * Inloggen, sessies en de worker gaan via SECURITY DEFINER-functies die precies één sleutel opzoeken.
 * Sinds 0011 mag alleen hz_auth die functies uitvoeren, en volgt app_user_id() uit een geldige sessie (app.session):
 * het aanvalspad van de criticus (ronde 3) staat in 'aanvalspad: een request kan niemand nadoen'.
 * Eigen, verse database (hz_e2_test_auth) op localhost:5432.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activeUserIds,
  canActAsUser,
  canIndex,
  createAuthDb,
  createDb,
  createIndexerDb,
  deleteContextIndexPath,
  upsertContextIndex,
  withIndexer,
  createOwnerDb,
  createSession,
  ensureDatabase,
  findSession,
  findUserByEmail,
  hashToken,
  revokeOwnSession,
  revokeSession,
  runMigrations,
  runWithSession,
  sessions,
  trackerItems,
  touchSession,
  upsertUser,
  users,
  withAuth,
  withPurpose,
  withSession,
  withUser,
  withWorker,
  deleteContextIndexId,
  type Db,
} from '../src';

const here = dirname(fileURLToPath(import.meta.url));
const URL_ = process.env.HZ_TEST_DATABASE_URL_AUTH ?? 'postgres://hz_dev:hz_dev@localhost:5432/hz_e2_test_auth';
let db: Db;
let close: () => Promise<void>;
let pool: pg.Pool;
let owner: ReturnType<typeof createOwnerDb>;
let A: string;
let B: string;
let tokenA: string;
let tokenB: string;

beforeAll(async () => {
  await ensureDatabase(URL_, { recreate: true });
  await runMigrations(URL_);
  ({ db, close, pool } = createDb(URL_, 4));
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
    const c = await pool.connect();
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
      const r = await withAuth(db, (tx) => tx.execute(sql`select * from auth_session_by_token(${probe})`));
      expect(r.rows, probe).toHaveLength(0);
    }
  });

  it('gebruiker bij e-mail: hoofdletterongevoelig, alleen exacte match', async () => {
    expect((await findUserByEmail(db, 'ANNA@homezero.nl'))?.id).toBe(A);
    expect(await findUserByEmail(db, '%@homezero.nl')).toBeNull();
    expect(await findUserByEmail(db, 'anna@')).toBeNull();
  });

  it('upsert is idempotent, wijzigt een bestaande gebruiker niet en weigert onzin', async () => {
    const again = await upsertUser(db, 'Anna@HomeZero.nl', 'Andere naam');
    expect(again).toMatchObject({ id: A, name: 'Anna', role: 'member' });
    await expect(upsertUser(db, 'geen-adres', 'X')).rejects.toThrow();
  });

  it('sessie maken weigert een ruw token, een verloopdatum in het verleden en een onbekende gebruiker', async () => {
    const future = new Date(Date.now() + 864e5).toISOString();
    const call = (uid: string, hash: string, exp: string) =>
      errOf(
        withAuth(db, (tx) =>
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
    const later = new Date(Date.now() + 20 * 864e5);
    expect(await touchSession(db, tokenB, later)).toBe(true);
    const s = await findSession(db, tokenB);
    expect(Math.abs(s!.session.expiresAt.getTime() - later.getTime())).toBeLessThan(1000);
  });

  it('sessieduur heeft een bovengrens van 30 dagen (touch en aanmaken); een verloopdatum in het verleden weigert', async () => {
    const max = () => Date.now() + 30 * 864e5;
    // touch met 10 jaar: gekapt op 30 dagen
    expect(await touchSession(db, tokenB, new Date(Date.now() + 3650 * 864e5))).toBe(true);
    const s = await findSession(db, tokenB);
    expect(s!.session.expiresAt.getTime()).toBeLessThanOrEqual(max() + 1000);
    expect(s!.session.expiresAt.getTime()).toBeGreaterThan(max() - 60_000);
    // rechtstreeks via de functie, zoals een auth-bibliotheek dat zou doen: zelfde grens
    const direct = await withAuth(db, (tx) =>
      tx.execute<{ ok: boolean }>(
        sql`select auth_touch_session(${hashToken(tokenB)}, now() + interval '400 days') as ok`,
      ),
    );
    expect(direct.rows[0]!.ok).toBe(true);
    const exp = await owner.db.execute<{ days: number }>(
      sql`select extract(epoch from expires_at - now()) / 86400 as days from sessions where token_hash = ${hashToken(tokenB)}`,
    );
    expect(Number(exp.rows[0]!.days)).toBeLessThanOrEqual(30.001);
    // verleden: fout, sessie blijft geldig
    expect(codeOf(await errOf(touchSession(db, tokenB, new Date(Date.now() - 1000))))).toBe('22023');
    expect(await findSession(db, tokenB)).not.toBeNull();
    // aanmaken met 365 dagen: ook gekapt
    const long = await createSession(db, B, 'lang', 365);
    const ls = await findSession(db, long.token);
    expect(ls!.session.expiresAt.getTime()).toBeLessThanOrEqual(max() + 1000);
  });

  it('worker: alleen id’s van actieve collega’s, alleen als hz_worker', async () => {
    // db is hier de migratierol (lid van hz_worker); activeUserIds zet SET LOCAL ROLE hz_worker
    const ids = await activeUserIds(db);
    expect(ids).toEqual(expect.arrayContaining([A, B]));
    const r = await withWorker(db, (tx) => tx.execute(sql`select * from system_active_user_ids()`));
    expect(Object.keys(r.rows[0]!)).toEqual(['system_active_user_ids']);
    // Een gewone request-transactie (hz_app), ook met app.purpose = system of auth: geen recht
    for (const purpose of ['system', 'auth'] as const) {
      const e = await errOf(withPurpose(db, purpose, (tx) => tx.execute(sql`select * from system_active_user_ids()`)));
      expect(codeOf(e), purpose).toBe('42501');
    }
    const e = await errOf(withUser(db, A, (tx) => tx.execute(sql`select * from system_active_user_ids()`)));
    expect(codeOf(e)).toBe('42501');
  });

  it('inloggen schrijft het auditlog via de functie (A ziet zijn eigen regels)', async () => {
    const log = await withUser(db, A, (tx) => tx.execute<{ action: string }>(sql`select action from audit_log`));
    const actions = log.rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['user.created', 'session.created', 'session.revoked']));
  });
});

describe('auth_upsert_user: geen rol van buiten, alleen toegestane domeinen (0008)', () => {
  const asRequest = <T>(fn: (tx: Parameters<Parameters<typeof withUser>[2]>[0]) => Promise<T>) =>
    withUser(db, A, async (tx) => {
      await tx.execute(sql`select set_config('app.purpose', 'auth', true)`);
      return fn(tx);
    });

  it('een gewone request-transactie maakt geen admin buiten het domein en geen sessie voor zo iemand', async () => {
    // De aanval uit ronde 1: auth_upsert_user('evil@example.com', 'x', 'admin') en dan auth_create_session.
    const e1 = await errOf(
      asRequest((tx) => tx.execute(sql`select * from auth_upsert_user('evil@example.com', 'x', 'admin')`)),
    );
    expect(codeOf(e1)).toBe('42883'); // die functie (met rol) bestaat niet meer
    const e2 = await errOf(asRequest((tx) => tx.execute(sql`select * from auth_upsert_user('evil@example.com', 'x')`)));
    expect(codeOf(e2)).toBe('42501');
    for (const evil of [
      'evil@homezero.nl.example.com',
      'evil@example.com',
      'x@sub.homezero.nl',
      'evil@homezero.nl@x.com',
    ])
      expect(codeOf(await errOf(upsertUser(db, evil, 'x'))), evil).not.toBeUndefined();
    const n = await owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from users where email not like '%@homezero.nl'`,
    );
    expect(n.rows[0]!.n).toBe(0);
  });

  it('een nieuwe gebruiker is altijd member en kan zichzelf geen admin maken (alleen de naam wijzigen)', async () => {
    const c = await upsertUser(db, 'cor@homezero.nl', 'Cor');
    expect(c.role).toBe('member');
    for (const set of [{ role: 'admin' as const }, { email: 'baas@homezero.nl' }, { blockedAt: null }]) {
      const e = await errOf(withUser(db, c.id, (tx) => tx.update(users).set(set)));
      expect(codeOf(e), JSON.stringify(set)).toBe('42501');
    }
    await withUser(db, c.id, (tx) => tx.update(users).set({ name: 'Cor de Vries' }));
    expect(await findUserByEmail(db, 'cor@homezero.nl')).toMatchObject({ role: 'member', name: 'Cor de Vries' });
  });

  it('de app kan de domeinlijst niet lezen of uitbreiden', async () => {
    const e1 = await errOf(asRequest((tx) => tx.execute(sql`select * from auth_domains`)));
    expect(codeOf(e1)).toBe('42501');
    const e2 = await errOf(
      asRequest((tx) => tx.execute(sql`insert into auth_domains (domain) values ('example.com')`)),
    );
    expect(codeOf(e2)).toBe('42501');
    const e3 = await errOf(asRequest((tx) => tx.execute(sql`select auth_domain_allowed('x@example.com')`)));
    expect(codeOf(e3)).toBe('42501');
  });

  it('een gebruiker buiten het domein (bijv. van vóór 0008) krijgt geen sessie, en een bestaande sessie werkt niet meer', async () => {
    const x = (
      await owner.db.execute<{ id: string }>(
        sql`insert into users (email, name) values ('oud@example.com', 'Oud') returning id`,
      )
    ).rows[0]!.id;
    expect(await errOf(createSession(db, x, 'oud'))).not.toBeNull();
    // Sessie die er al stond (ingevoegd door de eigenaar) geldt niet meer
    const tok = 'f'.repeat(64);
    await owner.db.execute(
      sql`insert into sessions (user_id, token_hash, expires_at) values (${x}::uuid, ${tok}, now() + interval '1 day')`,
    );
    const r = await withAuth(db, (tx) => tx.execute(sql`select * from auth_session_by_token(${tok})`));
    expect(r.rows).toHaveLength(0);
  });

  it('beheerscript sql/set-role.sql: als migratierol een collega admin maken', async () => {
    const script = readFileSync(join(here, '../sql/set-role.sql'), 'utf8');
    const body = /DO \$\$[\s\S]*END \$\$;/.exec(script)![0];
    const c = await owner.pool.connect();
    try {
      await c.query(`select set_config('hz.email', 'Bram@HomeZero.nl', false), set_config('hz.role', 'admin', false)`);
      await c.query(body);
      await c.query(`select set_config('hz.email', 'niemand@homezero.nl', false)`);
      await expect(c.query(body)).rejects.toThrow(/geen \(unieke\) gebruiker/);
    } finally {
      c.release();
    }
    expect((await findUserByEmail(db, 'bram@homezero.nl'))?.role).toBe('admin');
  });
});

describe('contextindex: schrijven alleen als hz_indexer, niet via app.purpose (0009)', () => {
  const row = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    kind: 'partner',
    slug: 'zonnig',
    path: `partners/zonnig/brief.md`,
    title: 'Zonnig (voorbeeld)',
    body: 'warmtepompen',
    data: {},
    geheim_voor: ['zonnig'],
    commit: 'abc',
    ...extra,
  });
  beforeAll(async () => {
    await upsertContextIndex(db, [
      {
        id: 'partners/zonnig/brief.md',
        kind: 'partner',
        slug: 'zonnig',
        path: 'partners/zonnig/brief.md',
        title: 'Zonnig (voorbeeld)',
        geheimVoor: ['zonnig'],
      },
      {
        id: 'partners/regen/brief.md',
        kind: 'partner',
        slug: 'regen',
        path: 'partners/regen/brief.md',
        title: 'Regen (voorbeeld)',
      },
    ]);
  });

  it('een request-transactie met app.purpose=index wijzigt niets: geen UPDATE, INSERT, DELETE of geheim_voor', async () => {
    for (const q of [
      sql`update context_index set geheim_voor = '{}'`,
      sql`insert into context_index (id, kind, path, title) values ('x', 'overig', 'x.md', 'X')`,
      sql`delete from context_index`,
    ]) {
      const e = await errOf(
        withUser(db, A, async (tx) => {
          await tx.execute(sql`select set_config('app.purpose', 'index', true)`);
          return tx.execute(q);
        }),
      );
      expect(codeOf(e)).toBe('42501');
    }
    const e = await errOf(
      withPurpose(db, 'index', (tx) => tx.execute(sql`update context_index set title = 'gekaapt'`)),
    );
    expect(codeOf(e)).toBe('42501');
    const r = await owner.db.execute<{ g: string[] }>(
      sql`select geheim_voor as g from context_index where id = 'partners/zonnig/brief.md'`,
    );
    expect(r.rows[0]!.g).toEqual(['zonnig']);
  });

  it('hz_app mag context_index_upsert, context_index_delete en context_index_delete_id niet aanroepen, ook niet met app.purpose=index', async () => {
    for (const q of [
      sql`select * from context_index_upsert(${JSON.stringify([row('partners/zonnig/brief.md', { geheim_voor: [] })])}::jsonb)`,
      sql`select context_index_delete('partners/zonnig/brief.md')`,
      sql`select context_index_delete_id('partners/zonnig/brief.md')`,
    ]) {
      const e = await errOf(
        withUser(db, A, async (tx) => {
          await tx.execute(sql`select set_config('app.purpose', 'index', true)`);
          return tx.execute(q);
        }),
      );
      expect(codeOf(e)).toBe('42501');
    }
  });

  it('de app-login (hz_app_login) kan geen hz_indexer worden', async () => {
    const u = new URL(URL_);
    u.username = 'hz_app_login';
    u.password = 'hz_app_login';
    const app = createDb(u.toString(), 1);
    try {
      expect(await canIndex(app.db)).toBe(false);
      const e = await errOf(withIndexer(app.db, (tx) => tx.execute(sql`select 1`)));
      expect(codeOf(e)).toBe('42501');
    } finally {
      await app.close();
    }
  });

  it('de indexer-login (hz_indexer_login) schrijft via de functies; admin.md weigert de database zelf', async () => {
    const u = new URL(URL_);
    u.username = 'hz_indexer_login';
    u.password = 'hz_indexer_login';
    const ix = createIndexerDb(u.toString(), 1);
    try {
      expect(await canIndex(ix.db)).toBe(true);
      const who = await withIndexer(ix.db, (tx) =>
        tx.execute<{ cu: string; su: string }>(sql`select current_user as cu, session_user as su`),
      );
      expect(who.rows[0]).toEqual({ cu: 'hz_indexer', su: 'hz_indexer_login' });
      const up = await withIndexer(ix.db, (tx) =>
        tx.execute<{ row_id: string; was_inserted: boolean }>(
          sql`select * from context_index_upsert(${JSON.stringify([row('partners/zonnig/brief.md'), row('partners/zon/brief.md', { slug: 'zon', path: 'partners/zon/brief.md' })])}::jsonb)`,
        ),
      );
      expect(up.rows.map((x) => [x.row_id, x.was_inserted]).sort()).toEqual([
        ['partners/zon/brief.md', true],
        ['partners/zonnig/brief.md', false],
      ]);
      // Zelfde rijen nog een keer: niets gewijzigd
      const again = await upsertContextIndex(ix.db, [
        {
          id: 'partners/zon/brief.md',
          kind: 'partner',
          slug: 'zon',
          path: 'partners/zon/brief.md',
          title: 'Zonnig (voorbeeld)',
          body: 'warmtepompen',
          geheimVoor: ['zonnig'],
          commit: 'abc',
        },
      ]);
      expect(again).toBe(0);
      for (const bad of [
        row('partners/x/admin.md', { path: 'partners/x/admin.md' }),
        row('partners/x/admin.md#r1', { path: 'partners/x/brief.md' }),
        row('partners/x/ADMIN.md', { path: 'partners/x/ADMIN.md' }),
      ]) {
        const e = await errOf(
          withIndexer(ix.db, (tx) =>
            tx.execute(sql`select * from context_index_upsert(${JSON.stringify([bad])}::jsonb)`),
          ),
        );
        expect(e?.cause?.message ?? e?.message, bad.id).toMatch(/admin\.md/);
      }
      const e2 = await errOf(
        withIndexer(ix.db, (tx) =>
          tx.execute(sql`select * from context_index_upsert(${JSON.stringify([row('y', { kind: 'geheim' })])}::jsonb)`),
        ),
      );
      expect(codeOf(e2)).toBe('22023');
      // Rechtstreeks schrijven mag ook de indexer niet: alleen via de functies
      const e3 = await errOf(withIndexer(ix.db, (tx) => tx.execute(sql`update context_index set title = 'x'`)));
      expect(codeOf(e3)).toBe('42501');
      expect(await deleteContextIndexPath(ix.db, 'partners/zon/brief.md')).toBe(1);
      // Eén rij op zijn sleutel (0010): exact, geen patroon
      expect(await deleteContextIndexId(ix.db, '%')).toBe(0);
      expect(await deleteContextIndexId(ix.db, 'partners/zonnig/brief.md')).toBe(1);
      expect(codeOf(await errOf(deleteContextIndexId(ix.db, ' ')))).toBe('22023');
      expect(codeOf(await errOf(deleteContextIndexPath(ix.db, '%')))).toBe('22023');
    } finally {
      await ix.close();
    }
    const n = await owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from context_index where path ilike '%admin.md'`,
    );
    expect(n.rows[0]!.n).toBe(0);
  });
});

const asLogin = (login: string) => {
  const u = new URL(URL_);
  u.username = login;
  u.password = login;
  return u.toString();
};

describe('aanvalspad: een request kan niemand nadoen (0011, criticus ronde 3)', () => {
  // De api verbindt als hz_app_login (alleen lid van hz_app). Een request van A is een transactie met de geldige sessie
  // van A (app.session). Daarbinnen draait in dit scenario willekeurige SQL (een injectie of een fout in een route).
  let app: ReturnType<typeof createDb>;
  let hashA: string;
  let hashB: string;
  const request = <T>(fn: (tx: Parameters<Parameters<typeof withSession>[2]>[0]) => Promise<T>) =>
    withSession(app.db, hashA, fn);
  // tellen namens B als de migratierol (lid van hz_worker; de eigenaar zelf valt ook onder FORCE RLS)
  const trackerVanB = async () => (await withUser(db, B, (tx) => tx.select().from(trackerItems))).length;

  beforeAll(async () => {
    app = createDb(asLogin('hz_app_login'), 2);
    hashA = hashToken(tokenA);
    hashB = hashToken(tokenB);
    // B heeft 5 tracker-items, A 1 (klaargezet als de migratierol, lid van hz_worker)
    await withUser(db, B, (tx) =>
      tx
        .insert(trackerItems)
        .values([1, 2, 3, 4, 5].map((i) => ({ userId: B, stroom: 'mijn' as const, wat: `geheim van B ${i}` }))),
    );
    await withUser(db, A, (tx) => tx.insert(trackerItems).values({ userId: A, stroom: 'mijn', wat: 'van A' }));
  });
  afterAll(async () => {
    await app?.close();
  });

  it('de login van de api kan hz_auth en hz_worker niet worden', async () => {
    expect(await canActAsUser(app.db)).toBe(false);
    for (const role of ['hz_auth', 'hz_worker', 'hz_indexer']) {
      const e = await errOf(request((tx) => tx.execute(sql.raw(`SET LOCAL ROLE ${role}`))));
      expect(codeOf(e), role).toBe('42501');
    }
  });

  it('id van B opvragen via een raadbaar e-mailadres of via auth_upsert_user: geweigerd', async () => {
    for (const q of [
      sql`select * from auth_user_by_email('bram@homezero.nl')`,
      sql`select * from auth_upsert_user('bram@homezero.nl', '')`,
      sql`select * from auth_upsert_user('nieuw@homezero.nl', '')`,
      sql`select * from auth_session_by_token(${hashB})`,
      sql`select auth_touch_session(${hashB}, null)`,
      sql`select auth_revoke_session(${hashB})`,
    ]) {
      const e = await errOf(request((tx) => tx.execute(q)));
      expect(codeOf(e)).toBe('42501');
      expect(`${e?.cause?.message ?? e?.message}`).toMatch(/permission denied for function/);
    }
    expect(await findSession(db, tokenB)).not.toBeNull(); // B's sessie is niet aangeraakt
  });

  it('ook met het id van B (bijv. uit een log) en app.user_id = B: geen rijen van B, niets schrijven namens B', async () => {
    const r = await request(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${B}, true)`);
      return {
        uid: (await tx.execute<{ u: string | null }>(sql`select app_user_id() as u`)).rows[0]!.u,
        tracker: await tx.select().from(trackerItems),
        users: await tx.select({ id: users.id }).from(users),
      };
    });
    expect(r.uid).toBeNull();
    expect(r.tracker).toHaveLength(0);
    expect(r.users).toHaveLength(0);
    const e = await errOf(
      request(async (tx) => {
        await tx.execute(sql`select set_config('app.user_id', ${B}, true)`);
        await tx.insert(trackerItems).values({ userId: B, stroom: 'mijn', wat: 'vervalst' });
      }),
    );
    expect(codeOf(e)).toBe('42501');
    expect(await trackerVanB()).toBe(5);
  });

  it('app.user_id = B zonder sessie, of met een verzonnen of andermans ingetrokken token: niemand', async () => {
    const probes: Array<string | null> = [null, 'f'.repeat(64), hashToken('geraden'), 'onzin'];
    const revoked = (await createSession(db, B, 'ingetrokken')).token;
    await revokeSession(db, revoked);
    probes.push(hashToken(revoked));
    for (const h of probes) {
      const rows = await app.db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.user_id', ${B}, true)`);
        if (h) await tx.execute(sql`select set_config('app.session', ${h}, true)`);
        return tx.select().from(trackerItems);
      });
      expect(rows, String(h)).toHaveLength(0);
    }
    // via de gewone hulpfunctie, zonder sessie: ook niets
    expect(await withUser(app.db, B, (tx) => tx.select().from(trackerItems))).toHaveLength(0);
  });

  it('auth_create_session voor B vanuit een request: geweigerd, B heeft geen nieuwe sessie', async () => {
    const before = (
      await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from sessions where user_id = ${B}`)
    ).rows[0]!.n;
    const exp = new Date(Date.now() + 864e5).toISOString();
    const e = await errOf(
      request((tx) =>
        tx.execute(sql`select auth_create_session(${B}::uuid, ${hashToken('kaper')}, 'x', ${exp}::timestamptz)`),
      ),
    );
    expect(codeOf(e)).toBe('42501');
    // rechtstreeks een sessierij invoegen kan ook niet (geen INSERT-recht meer)
    const e2 = await errOf(
      request((tx) =>
        tx.insert(sessions).values({ userId: A, tokenHash: hashToken('eigen'), expiresAt: new Date(exp) }),
      ),
    );
    expect(codeOf(e2)).toBe('42501');
    const after = (
      await owner.db.execute<{ n: number }>(sql`select count(*)::int as n from sessions where user_id = ${B}`)
    ).rows[0]!.n;
    expect(after).toBe(before);
  });

  it('met de eigen sessie werkt alles gewoon: A ziet en schrijft alleen zijn eigen rijen', async () => {
    const mine = await request((tx) => tx.select({ wat: trackerItems.wat }).from(trackerItems));
    expect(mine.map((x) => x.wat)).toEqual(['van A']);
    // de api: runWithSession + withUser (DbStore). Om B vragen binnen de sessie van A: niemand.
    expect(
      (await runWithSession(hashA, () => withUser(app.db, A, (tx) => tx.select().from(trackerItems)))).length,
    ).toBe(1);
    expect(await runWithSession(hashA, () => withUser(app.db, B, (tx) => tx.select().from(trackerItems)))).toHaveLength(
      0,
    );
    // eigen sessie intrekken mag (uitloggen op een ander apparaat, via auth_revoke_own_session; 0013), de verloopdatum
    // verschuiven niet
    const other = await createSession(db, A, 'ander apparaat');
    const otherId = (await findSession(db, other.token))!.session.id;
    expect(
      (await request((tx) => tx.execute<{ ok: boolean }>(sql`select auth_revoke_own_session(${otherId}::uuid) as ok`)))
        .rows[0]!.ok,
    ).toBe(true);
    expect(await findSession(db, other.token)).toBeNull();
    const e = await errOf(request((tx) => tx.execute(sql`update sessions set expires_at = now() + interval '1 year'`)));
    expect(codeOf(e)).toBe('42501');
  });

  it('de auth-login (hz_auth_login) kan inloggen en sessies beheren, maar leest geen enkele tabel', async () => {
    const auth = createAuthDb(asLogin('hz_auth_login'), 1);
    try {
      expect((await findUserByEmail(auth.db, 'bram@homezero.nl'))?.id).toBe(B);
      expect((await findSession(auth.db, tokenA))?.user.id).toBe(A);
      expect(await canActAsUser(auth.db)).toBe(false);
      for (const q of [sql`select * from users`, sql`select * from sessions`, sql`select * from tracker_items`]) {
        const e = await errOf(withAuth(auth.db, (tx) => tx.execute(q)));
        expect(codeOf(e)).toBe('42501');
      }
      const e = await errOf(withUser(auth.db, B, (tx) => tx.select().from(trackerItems)));
      expect(codeOf(e)).toBe('42501'); // kan geen hz_app worden
    } finally {
      await auth.close();
    }
  });

  it('de worker-login werkt namens een collega (app.user_id), maar binnen een sessie telt alleen die sessie', async () => {
    const wk = createDb(asLogin('hz_worker_login'), 1, { allowRoles: ['hz_worker'] });
    try {
      expect(await canActAsUser(wk.db)).toBe(true);
      expect(await withUser(wk.db, B, (tx) => tx.select().from(trackerItems))).toHaveLength(5);
      expect(
        await runWithSession(hashA, () => withUser(wk.db, B, (tx) => tx.select().from(trackerItems))),
      ).toHaveLength(0);
      const e = await errOf(findUserByEmail(wk.db, 'bram@homezero.nl'));
      expect(codeOf(e)).toBe('42501'); // de worker-login is geen hz_auth
    } finally {
      await wk.close();
    }
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
    // stuk E1 (0014, rechten 0015): uitnodigingslijst, Google-account, geweigerde login, onboarding, auditregel
    'auth_allowlist_role',
    'auth_apply_allowlist_role',
    'auth_account_lookup',
    'auth_link_account',
    'auth_audit_refusal',
    'auth_user_by_id',
    'auth_init_onboarding',
    'auth_audit_event',
  ];
  /** Wie ze mag uitvoeren: alles hz_auth (0011), behalve de lijst met alle gebruikers-id's (alleen hz_worker, 0010). */
  const GRANTEE: Record<string, string> = { system_active_user_ids: 'hz_worker' };
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

  it('PUBLIC en hz_app mogen ze niet uitvoeren; de auth_*-functies alleen hz_auth, system_active_user_ids alleen hz_worker', async () => {
    const r = await owner.db.execute<{ proname: string; grantee: string }>(sql`
      select p.proname, coalesce(nullif(pg_get_userbyid(a.grantee), '-'), 'PUBLIC') as grantee
      from pg_proc p, aclexplode(p.proacl) a
      where p.pronamespace = 'public'::regnamespace and p.proname = any(${FNS_ARR}::text[]) and a.privilege_type = 'EXECUTE'`);
    for (const f of FNS) {
      const grantees = r.rows.filter((x) => x.proname === f).map((x) => x.grantee);
      const want = GRANTEE[f] ?? 'hz_auth';
      expect(grantees, f).toContain(want);
      expect(grantees, f).not.toContain('hz_app');
      expect(grantees, f).not.toContain(want === 'hz_auth' ? 'hz_worker' : 'hz_auth');
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
    expect(r.rows.map((x) => x.polname).sort()).toEqual([
      'allowlist_definer',
      'audit_definer',
      'auth_accounts_definer',
      'auth_domains_definer',
      'context_index_definer',
      'onboarding_definer',
      'sessions_definer',
      'sync_events_definer',
      'sync_jobs_definer',
      'users_definer',
    ]);
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

describe('uitloggen blijft uitloggen; auditlog en import_keys alleen toevoegen (0013, criticus ronde 5)', () => {
  // De api verbindt als hz_app_login. Willekeurige SQL in de request van A mag een ingetrokken sessie (van A zelf of van
  // een ander) nooit weer geldig maken, en het auditlog niet wijzigen of wissen.
  let app: ReturnType<typeof createDb>;
  let hashA: string;
  const request = <T>(fn: (tx: Parameters<Parameters<typeof withSession>[2]>[0]) => Promise<T>) =>
    withSession(app.db, hashA, fn);
  const validByToken = async (hash: string) =>
    (
      await withAuth(db, (tx) =>
        tx.execute<{ n: number }>(sql`select count(*)::int as n from auth_session_by_token(${hash})`),
      )
    ).rows[0]!.n;

  beforeAll(async () => {
    app = createDb(asLogin('hz_app_login'), 2);
    hashA = hashToken(tokenA);
  });
  afterAll(async () => {
    await app?.close();
  });

  it('een eigen uitgelogde sessie terughalen met UPDATE revoked_at = NULL: geweigerd, de sessie blijft ongeldig', async () => {
    const old = await createSession(db, A, 'oud apparaat');
    const h = hashToken(old.token);
    expect(await revokeSession(db, old.token)).toBe(true);
    expect(await validByToken(h)).toBe(0);
    for (const q of [
      sql`update sessions set revoked_at = null where token_hash = ${h}`,
      sql`update sessions set revoked_at = null`,
      sql`update sessions set revoked_at = now() where token_hash = ${h}`,
    ]) {
      const e = await errOf(request((tx) => tx.execute(q)));
      expect(codeOf(e)).toBe('42501');
      expect(`${e?.cause?.message ?? e?.message}`).toMatch(/permission denied for table sessions/);
    }
    expect(await validByToken(h)).toBe(0);
    expect(await findSession(db, old.token)).toBeNull();
  });

  it('ook de sessie van een ander (B, ingetrokken) terughalen: geweigerd', async () => {
    const t = (await createSession(db, B, 'b-oud')).token;
    await revokeSession(db, t);
    const e = await errOf(
      request((tx) => tx.execute(sql`update sessions set revoked_at = null where token_hash = ${hashToken(t)}`)),
    );
    expect(codeOf(e)).toBe('42501');
    expect(await validByToken(hashToken(t))).toBe(0);
  });

  it('auth_revoke_own_session: alleen een eigen, nog geldige sessie; niet die van B, niet zonder sessie', async () => {
    const b = await createSession(db, B, 'b-telefoon');
    const bId = (await findSession(db, b.token))!.session.id;
    const call = (id: string) =>
      request((tx) => tx.execute<{ ok: boolean }>(sql`select auth_revoke_own_session(${id}::uuid) as ok`));
    expect((await call(bId)).rows[0]!.ok).toBe(false);
    expect(await findSession(db, b.token)).not.toBeNull(); // B is niet uitgelogd
    // zonder geldige sessie (app.user_id = B zonder sessie, de api-login): niemand, dus niets
    const none = await app.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${B}, true)`);
      return tx.execute<{ ok: boolean }>(sql`select auth_revoke_own_session(${bId}::uuid) as ok`);
    });
    expect(none.rows[0]!.ok).toBe(false);
    expect(await findSession(db, b.token)).not.toBeNull();
    // eigen sessie: één keer intrekken lukt, een tweede keer niet (al ingetrokken)
    const a2 = await createSession(db, A, 'a-tablet');
    const a2Id = (await findSession(db, a2.token))!.session.id;
    expect(await runWithSession(hashA, () => revokeOwnSession(app.db, A, a2Id))).toBe(true);
    expect(await runWithSession(hashA, () => revokeOwnSession(app.db, A, a2Id))).toBe(false);
    expect(await findSession(db, a2.token)).toBeNull();
  });

  it('auth_revoke_own_session: SECURITY DEFINER van de migratierol, vast zoekpad, alleen hz_app mag hem uitvoeren', async () => {
    const r = await owner.db.execute<{ sec: boolean; own: string; cfg: string[]; me: string; g: string }>(sql`
      select p.prosecdef as sec, pg_get_userbyid(p.proowner) as own, p.proconfig as cfg, current_user::text as me,
        (select string_agg(coalesce(nullif(pg_get_userbyid(a.grantee), '-'), 'PUBLIC'), ',') from aclexplode(p.proacl) a
               where a.privilege_type = 'EXECUTE' and a.grantee <> p.proowner) as g
      from pg_proc p where p.proname = 'auth_revoke_own_session'`);
    const f = r.rows[0]!;
    expect(f.sec).toBe(true);
    expect(f.own).toBe(f.me);
    expect(f.cfg.join(',')).toMatch(/search_path=pg_catalog, public, pg_temp/);
    expect(f.g).toBe('hz_app');
  });

  it('de trigger houdt het voor iedereen vast, ook voor de migratierol: ingetrokken blijft ingetrokken', async () => {
    const t = (await createSession(db, A, 'trigger')).token;
    await revokeSession(db, t);
    // de eigenaar valt onder FORCE RLS en heeft de definer-regel; de trigger weigert toch
    const e = await errOf(
      owner.db.execute(sql`update sessions set revoked_at = null where token_hash = ${hashToken(t)}`),
    );
    expect(codeOf(e)).toBe('42501');
    expect(`${e?.cause?.message ?? e?.message}`).toMatch(/ingetrokken sessie blijft ingetrokken/);
    const e2 = await errOf(
      owner.db.execute(
        sql`update sessions set token_hash = ${hashToken('ander')} where token_hash = ${hashToken(tokenB)}`,
      ),
    );
    expect(codeOf(e2)).toBe('42501');
    expect(await validByToken(hashToken(t))).toBe(0);
    expect(await findSession(db, tokenB)).not.toBeNull();
  });

  it('hz_app heeft geen UPDATE of DELETE op audit_log en geen DELETE op import_keys (het recht zelf, niet alleen RLS)', async () => {
    const priv = await owner.db.execute<{ t: string; p: string; ok: boolean }>(sql`
      select t, p, has_table_privilege('hz_app', t, p) as ok
      from unnest(array['audit_log','audit_log','audit_log','import_keys','import_keys','sessions','sessions'],
                  array['UPDATE','DELETE','TRUNCATE','DELETE','TRUNCATE','UPDATE','INSERT']) as x(t, p)`);
    for (const r of priv.rows) expect(r.ok, `${r.p} op ${r.t}`).toBe(false);
    expect(
      (
        await owner.db.execute<{ ok: boolean }>(
          sql`select has_column_privilege('hz_app', 'sessions', 'revoked_at', 'UPDATE') as ok`,
        )
      ).rows[0]!.ok,
    ).toBe(false);
    // toevoegen mag nog (voor zichzelf), lezen ook
    expect(
      has(
        await owner.db.execute<{ ok: boolean }>(sql`select has_table_privilege('hz_app', 'audit_log', 'INSERT') as ok`),
      ),
    ).toBe(true);
    for (const q of [
      sql`update audit_log set action = 'gewist'`,
      sql`delete from audit_log`,
      sql`delete from import_keys`,
    ]) {
      const e = await errOf(request((tx) => tx.execute(q)));
      expect(codeOf(e)).toBe('42501');
      expect(`${e?.cause?.message ?? e?.message}`).toMatch(/permission denied for table/);
    }
  });
});

const has = (r: { rows: Array<{ ok: boolean }> }) => r.rows[0]!.ok;
