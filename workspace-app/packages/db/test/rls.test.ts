/**
 * HZW-020: migraties en rij-beveiliging. Verplichte test: gebruiker A ziet nooit rijen van B.
 * Draait tegen een eigen, steeds verse database (hz_fundament_test_db) op localhost:5432.
 */
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPin,
  countQueuedIds,
  deletePin,
  enqueueRepoWrite,
  getPreferences,
  getRepoQueueEntry,
  listPins,
  listRepoQueue,
  savePreferences,
  searchContextIndex,
  upsertContextIndex,
  ALL_TABLES,
  briefings,
  connections,
  contextIndex,
  createDb,
  createOwnerDb,
  ensureDatabase,
  itemState,
  openToken,
  parseMasterKey,
  pins,
  preferences,
  readConnectionToken,
  repoQueue,
  runMigrations,
  saveConnectionToken,
  sealToken,
  upsertUser,
  weekdoelen,
  withPurpose,
  withUser,
  createSession,
  findSession,
  revokeSession,
  auditLog,
  users,
  type Db,
} from '../src';

const URL_ = process.env.HZ_TEST_DATABASE_URL ?? 'postgres://hz_dev:hz_dev@localhost:5432/hz_fundament_test_db';
let db: Db;
let close: () => Promise<void>;
let A: string;
let B: string;

beforeAll(async () => {
  await ensureDatabase(URL_, { recreate: true });
  await runMigrations(URL_);
  ({ db, close } = createDb(URL_, 4));
  A = (await upsertUser(db, 'anna@homezero.nl', 'Anna')).id;
  B = (await upsertUser(db, 'bram@homezero.nl', 'Bram')).id;
  // Voor elke tabel met user_id een rij van A en een rij van B, elk in hun eigen context.
  for (const [uid, tag] of [
    [A, 'a'],
    [B, 'b'],
  ] as const) {
    await withUser(db, uid, async (tx) => {
      await tx.insert(itemState).values({ userId: uid, itemKey: `item-${tag}`, read: true, planDate: '2026-11-09' });
      await tx.insert(pins).values({ userId: uid, kind: 'search', label: `pin-${tag}`, q: `feenstra, ${tag}` });
      await tx.insert(preferences).values({ userId: uid, theme: tag === 'a' ? 'dark' : 'light' });
      await tx.insert(weekdoelen).values({ userId: uid, wat: `doel-${tag}`, week: '2026-W45' });
      await tx.insert(repoQueue).values({
        userId: uid,
        repo: 'persoonlijk',
        kind: 'wachten-op',
        path: 'wachten-op.md',
        op: 'append',
        line: `- [ ] ${tag}`,
      });
      await tx.insert(briefings).values({ userId: uid, date: '2026-11-09', title: `briefing-${tag}`, sections: [] });
      await tx.insert(connections).values({
        userId: uid,
        provider: 'slack',
        ...sealToken(`xoxp-${tag}`, parseMasterKey(randomBytes(32).toString('base64')), uid, 'slack'),
      });
      await tx.insert(auditLog).values({ userId: uid, action: `test-${tag}` });
    });
  }
}, 30_000);

/** Postgres-fout 42501: "new row violates row-level security policy" (Drizzle zet hem in `cause`). */
async function expectRlsDenied(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e as { code?: string; cause?: { code?: string; message?: string } },
  );
  expect(err, 'schrijven had geweigerd moeten worden').not.toBeNull();
  expect(err!.cause?.code ?? err!.code).toBe('42501');
  expect(err!.cause?.message ?? '').toMatch(/row-level security/);
}

afterAll(async () => {
  await close?.();
});

describe('migraties', () => {
  it('zijn idempotent en maken alle tabellen met RLS aan (ENABLE + FORCE)', async () => {
    await runMigrations(URL_);
    const r = await db.execute<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(sql`
      select relname, relrowsecurity, relforcerowsecurity from pg_class
      where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname`);
    const byName = Object.fromEntries(r.rows.map((x) => [x.relname, x]));
    for (const t of ALL_TABLES) {
      expect(byName[t], t).toBeDefined();
      expect(byName[t]!.relrowsecurity, t).toBe(true);
      expect(byName[t]!.relforcerowsecurity, t).toBe(true);
    }
  });

  it('planning heeft één plek: item_state (de losse tabel planning bestaat niet meer)', async () => {
    const r = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_class where relname = 'planning' and relnamespace = 'public'::regnamespace`,
    );
    expect(r.rows[0]!.n).toBe(0);
    const rows = await withUser(db, A, (tx) => tx.select().from(itemState));
    expect(rows[0]!.planDate).toBe('2026-11-09');
  });

  it('extensies voor zoeken staan aan (pg_trgm, unaccent); geen pgvector nodig', async () => {
    const r = await db.execute<{ extname: string }>(sql`select extname from pg_extension`);
    const ext = r.rows.map((x) => x.extname);
    expect(ext).toContain('pg_trgm');
    expect(ext).toContain('unaccent');
  });
});

describe('runtime-rol hz_app: geen superuser, geen BYPASSRLS, eigenaar van niets', () => {
  type Role = { cu: string; su: string; rolsuper: boolean; rolbypassrls: boolean };
  const whoami = sql`select current_user as cu, session_user as su, rolsuper, rolbypassrls from pg_roles where rolname = current_user`;

  it('in withUser en withPurpose is current_user hz_app, zonder superuser of BYPASSRLS', async () => {
    for (const run of [
      (f: (tx: Parameters<Parameters<typeof withUser>[2]>[0]) => Promise<Role>) => withUser(db, A, f),
      (f: (tx: Parameters<Parameters<typeof withUser>[2]>[0]) => Promise<Role>) => withPurpose(db, 'auth', f),
    ]) {
      const r = await run(async (tx) => (await tx.execute<Role>(whoami)).rows[0]!);
      expect(r).toMatchObject({ cu: 'hz_app', rolsuper: false, rolbypassrls: false });
    }
  });

  it('ook buiten een transactie draait een app-verbinding als hz_app', async () => {
    const r = await db.execute<Role>(whoami);
    expect(r.rows[0]).toMatchObject({ cu: 'hz_app', rolsuper: false, rolbypassrls: false });
  });

  it('current_user is geen eigenaar van een enkele tabel (pg_class.relowner <> current_user)', async () => {
    const r = await withUser(db, A, (tx) =>
      tx.execute<{ relname: string; owner: string; cu: string }>(sql`
        select c.relname, pg_get_userbyid(c.relowner) as owner, current_user as cu from pg_class c
        where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')`),
    );
    expect(r.rows.length).toBeGreaterThanOrEqual(ALL_TABLES.length);
    for (const row of r.rows) expect(row.owner, row.relname).not.toBe(row.cu);
    const owned = await withUser(db, A, (tx) =>
      tx.execute<{ n: number }>(sql`
        select count(*)::int as n from pg_class
        where relnamespace = 'public'::regnamespace and relowner = (select oid from pg_roles where rolname = current_user)`),
    );
    expect(owned.rows[0]!.n).toBe(0);
  });

  /** Postgres-fout 42501 "must be owner of table/relation". */
  async function expectNotOwner(stmt: ReturnType<typeof sql.raw>) {
    const err = await withUser(db, A, (tx) => tx.execute(stmt)).then(
      () => null,
      (e: { code?: string; cause?: { code?: string; message?: string } }) => e,
    );
    expect(err, `${stmt.queryChunks.join('')} had geweigerd moeten worden`).not.toBeNull();
    expect(err!.cause?.code ?? err!.code).toBe('42501');
    expect(err!.cause?.message ?? '').toMatch(/must be owner/);
  }

  it('de app-rol kan RLS niet uitzetten: NO FORCE, DISABLE en DROP POLICY worden geweigerd', async () => {
    await expectNotOwner(sql.raw('ALTER TABLE weekdoelen NO FORCE ROW LEVEL SECURITY'));
    await expectNotOwner(sql.raw('ALTER TABLE weekdoelen DISABLE ROW LEVEL SECURITY'));
    await expectNotOwner(sql.raw('DROP POLICY weekdoelen_own ON weekdoelen'));
    await expectNotOwner(sql.raw('ALTER POLICY weekdoelen_own ON weekdoelen USING (true)'));
    await expectNotOwner(sql.raw('CREATE POLICY open_huis ON weekdoelen FOR SELECT USING (true)'));
    const r = await db.execute<{ relforcerowsecurity: boolean }>(
      sql`select relforcerowsecurity from pg_class where relname = 'weekdoelen'`,
    );
    expect(r.rows[0]!.relforcerowsecurity).toBe(true);
  });

  it('zelfs als de eigenaar FORCE uitzet, ziet de app-rol alleen eigen rijen (hz_app is geen eigenaar)', async () => {
    const owner = createOwnerDb(URL_, 1);
    try {
      await owner.db.execute(sql.raw('ALTER TABLE weekdoelen NO FORCE ROW LEVEL SECURITY'));
      const rows = await withUser(db, A, (tx) => tx.select().from(weekdoelen));
      expect(rows.map((r) => r.wat)).toEqual(['doel-a']);
      const none = await db.execute(sql`select * from weekdoelen`);
      expect(none.rows).toHaveLength(0);
    } finally {
      await owner.db.execute(sql.raw('ALTER TABLE weekdoelen FORCE ROW LEVEL SECURITY'));
      await owner.close();
    }
  });

  it('de app-rol kan geen superuser worden (SET ROLE postgres)', async () => {
    const err = await withUser(db, A, (tx) => tx.execute(sql.raw('SET LOCAL ROLE postgres'))).then(
      () => null,
      (e: { cause?: { code?: string } }) => e,
    );
    expect(err?.cause?.code).toBe('42501');
  });
});

describe('rij-beveiliging: A ziet nooit rijen van B', () => {
  const perUser = [
    ['item_state', itemState],
    ['pins', pins],
    ['preferences', preferences],
    ['weekdoelen', weekdoelen],
    ['repo_queue', repoQueue],
    ['briefings', briefings],
    ['connections', connections],
  ] as const;

  for (const [name, table] of perUser) {
    it(`${name}: alleen eigen rijen lezen`, async () => {
      const rows = await withUser(db, A, (tx) => tx.select().from(table));
      expect(rows.length).toBe(1);
      expect(rows.every((r) => r.userId === A)).toBe(true);
    });
  }

  it('A kan geen rij namens B schrijven (WITH CHECK)', async () => {
    await expectRlsDenied(
      withUser(db, A, (tx) => tx.insert(weekdoelen).values({ userId: B, wat: 'kaping', week: '2026-W45' })),
    );
  });

  it('A kan rijen van B niet wijzigen of wissen', async () => {
    const upd = await withUser(db, A, (tx) =>
      tx
        .update(weekdoelen)
        .set({ wat: 'gewijzigd' })
        .where(sql`user_id = ${B}`)
        .returning(),
    );
    const del = await withUser(db, A, (tx) =>
      tx
        .delete(briefings)
        .where(sql`user_id = ${B}`)
        .returning(),
    );
    expect(upd).toHaveLength(0);
    expect(del).toHaveLength(0);
    const still = await withUser(db, B, (tx) => tx.select().from(weekdoelen));
    expect(still[0]!.wat).toBe('doel-b');
  });

  it('zonder app.user_id: geen rijen, ook niet met een zelfgeschreven WHERE', async () => {
    const r = await db.execute(sql`select * from weekdoelen`);
    expect(r.rows).toHaveLength(0);
    const u = await db.execute(sql`select * from users`);
    expect(u.rows).toHaveLength(0);
  });

  it('users: alleen jezelf; het auditlog alleen je eigen regels', async () => {
    const us = await withUser(db, A, (tx) => tx.select().from(users));
    expect(us.map((u) => u.email)).toEqual(['anna@homezero.nl']);
    const log = await withUser(db, A, (tx) => tx.select().from(auditLog));
    expect(log.every((l) => l.userId === A)).toBe(true);
    expect(log.map((l) => l.action)).toContain('test-a');
  });

  it('withUser weigert een ongeldige gebruiker', async () => {
    await expect(withUser(db, "x' or 1=1 --", async () => 1)).rejects.toThrow(/ongeldige/);
  });
});

describe('contextindex: gedeeld lezen, schrijven alleen door de indexer', () => {
  it('hz_app schrijft niet, ook niet met purpose=index (0009); de indexer via de functie wel; iedereen leest', async () => {
    const denied = async (p: Promise<unknown>) => {
      const err = await p.then(
        () => null,
        (e: { code?: string; cause?: { code?: string } }) => e,
      );
      expect(err, 'schrijven had geweigerd moeten worden').not.toBeNull();
      expect(err!.cause?.code ?? err!.code).toBe('42501');
    };
    await denied(
      withUser(db, A, (tx) =>
        tx.insert(contextIndex).values({ id: 'x', kind: 'partner', path: 'partners/x/brief.md', title: 'X' }),
      ),
    );
    await denied(
      withPurpose(db, 'index', (tx) =>
        tx.insert(contextIndex).values({ id: 'x', kind: 'partner', path: 'partners/x/brief.md', title: 'X' }),
      ),
    );
    await upsertContextIndex(db, [
      {
        id: 'zonnig',
        kind: 'partner',
        slug: 'zonnig',
        path: 'partners/zonnig/brief.md',
        title: 'Zonnig Installatie',
        body: 'warmtepompen en thuisbatterijen',
      },
    ]);
    const hits = await withUser(db, A, (tx) =>
      tx
        .select({ id: contextIndex.id })
        .from(contextIndex)
        .where(sql`tsv @@ plainto_tsquery('dutch', 'warmtepomp')`),
    );
    expect(hits.map((h) => h.id)).toEqual(['zonnig']);
    const fuzzy = await withUser(db, B, (tx) =>
      tx
        .select({ id: contextIndex.id })
        .from(contextIndex)
        .where(sql`title % 'Zonig Instalatie'`),
    );
    expect(fuzzy.map((h) => h.id)).toEqual(['zonnig']);
  });
});

describe('koppel-tokens: envelope-versleuteld en aan gebruiker + bron gebonden', () => {
  const key = parseMasterKey(randomBytes(32).toString('base64'));

  it('staat niet leesbaar in de database en komt terug bij de juiste gebruiker', async () => {
    await saveConnectionToken(db, key, A, 'google_tasks', 'ya29.GEHEIM-TOKEN', { scopes: ['tasks'] });
    const raw = await withUser(db, A, (tx) =>
      tx.execute(sql`select * from connections where provider = 'google_tasks'`),
    );
    expect(JSON.stringify(raw.rows)).not.toContain('GEHEIM-TOKEN');
    expect(await readConnectionToken(db, key, A, 'google_tasks')).toBe('ya29.GEHEIM-TOKEN');
    expect(await readConnectionToken(db, key, B, 'google_tasks')).toBeNull();
  });

  it('een gekopieerd token werkt niet voor een andere gebruiker of bron (AAD)', () => {
    const s = sealToken('tok', key, A, 'slack');
    expect(openToken(s, key, A, 'slack')).toBe('tok');
    expect(() => openToken(s, key, B, 'slack')).toThrow();
    expect(() => openToken(s, key, A, 'gmail')).toThrow();
    expect(() => openToken(s, parseMasterKey(randomBytes(32).toString('base64')), A, 'slack')).toThrow();
  });

  it('weigert een ontbrekende of verkeerde hoofdsleutel', () => {
    expect(() => parseMasterKey(undefined)).toThrow(/ontbreekt/);
    expect(() => parseMasterKey(Buffer.from('kort').toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('sessies', () => {
  it('maken, vinden, intrekken; het token staat alleen gehasht opgeslagen', async () => {
    const { token } = await createSession(db, A, 'vitest');
    expect((await findSession(db, token))?.user.email).toBe('anna@homezero.nl');
    const raw = await withUser(db, A, (tx) => tx.execute(sql`select token_hash from sessions`));
    expect(JSON.stringify(raw.rows)).not.toContain(token);
    await revokeSession(db, token);
    expect(await findSession(db, token)).toBeNull();
    expect(await findSession(db, 'onzin')).toBeNull();
  });
});

describe('repo-functies voor de nieuwe routes (per gebruiker, via RLS)', () => {
  it('vastgezette zoekopdrachten: toevoegen, lijst op volgorde, wissen alleen eigen', async () => {
    const p = await addPin(db, A, { kind: 'view', label: 'Wachten op', view: '/tracker?tab=wachten' });
    expect((await listPins(db, A)).map((x) => x.label)).toEqual(['pin-a', 'Wachten op']);
    expect(await deletePin(db, B, p.id)).toBe(false);
    expect(await deletePin(db, A, p.id)).toBe(true);
  });

  it('voorkeuren: thema en agenda-instellingen samenvoegen', async () => {
    await savePreferences(db, B, {
      calendars: { 'lou@group.calendar.google.com': { color: '#f9b20b', scope: 'agenda' } },
    });
    const r = await savePreferences(db, B, { theme: 'dark', calendars: { primary: { scope: 'overal' } } });
    expect(r.theme).toBe('dark');
    expect(Object.keys(r.calendars).sort()).toEqual(['lou@group.calendar.google.com', 'primary']);
    expect((await getPreferences(db, A))!.theme).toBe('dark');
  });

  it('wachtrij: in de rij zetten, status lezen, niet bij een ander', async () => {
    const e = await enqueueRepoWrite(db, A, {
      repo: 'context',
      kind: 'partneractie',
      path: 'partners/zonnig/acties.md',
      op: 'append',
      line: '- [ ] x [eigenaar:: Anna] [datum:: 2026-11-10] [ligt:: bij-ons] [sinds:: 2026-10-30] [bron:: y] [id:: zonnig-20261030-1]',
      slug: 'zonnig',
    });
    expect(e.status).toBe('queued');
    expect((await getRepoQueueEntry(db, A, e.id))!.path).toBe('partners/zonnig/acties.md');
    expect(await getRepoQueueEntry(db, B, e.id)).toBeNull();
    expect(await countQueuedIds(db, A, 'zonnig', '20261030')).toBe(1);
    expect((await listRepoQueue(db, A, 'queued')).length).toBe(2);
  });

  it('contextindex: upsert alleen via de indexer, nooit admin.md; zoeken met full-text en trigram', async () => {
    await upsertContextIndex(db, [
      {
        id: 'stilstroom',
        kind: 'partner',
        slug: 'stilstroom',
        path: 'partners/stilstroom/brief.md',
        title: 'Stilstroom',
        body: 'thuisbatterij offertes',
      },
    ]);
    await expect(
      upsertContextIndex(db, [{ id: 'x', kind: 'overig', path: 'partners/stilstroom/admin.md', title: 'MRR' }]),
    ).rejects.toThrow(/admin\.md/);
    expect((await searchContextIndex(db, B, 'thuisbatterij')).map((r) => r.id)).toContain('stilstroom');
    expect((await searchContextIndex(db, B, 'Stilstrom')).map((r) => r.id)).toContain('stilstroom');
  });
});
