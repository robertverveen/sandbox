/**
 * HZW-021: import uit het prototype (artifact-opslag) naar de database van één collega.
 * Zelftest uit stories.json: "Import is idempotent; aantallen voor en na kloppen".
 * Synthetische export (test/fixtures/prototype-export.json, afgeleid van de demodata van het prototype); nooit echte data.
 * Eigen, verse database (hz_e2_test_import) op localhost:5432.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyImport,
  briefings,
  contextIndex,
  auditLog,
  createDb,
  createOwnerDb,
  ensureDatabase,
  findUserByEmail,
  formatReport,
  importPrototype,
  itemState,
  normalizeExport,
  pins,
  planImport,
  readExport,
  runMigrations,
  deletePin,
  listPins,
  setItemState,
  trackerItems,
  updateWeekdoel,
  upsertUser,
  weekdoelen,
  withPurpose,
  withUser,
  type Db,
  type ExportCollections,
  type ImportReport,
  trackerItemVisible,
  upsertContextIndex,
  deleteContextIndexPath,
} from '../src';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures/prototype-export.json');
const URL_ = process.env.HZ_TEST_DATABASE_URL_IMPORT ?? 'postgres://hz_dev:hz_dev@localhost:5432/hz_e2_test_import';
const ROBERT = 'robert@homezero.nl';

let db: Db;
let close: () => Promise<void>;
let cols: ExportCollections;

beforeAll(async () => {
  await ensureDatabase(URL_, { recreate: true });
  await runMigrations(URL_);
  ({ db, close } = createDb(URL_, 3));
  cols = readExport(FIXTURE);
}, 30_000);

afterAll(async () => {
  await close?.();
});

/** Alle rijen van een collega per tabel (via RLS), plus de gedeelde contextindex. */
async function totals(userId: string) {
  const n = (t: typeof trackerItems | typeof weekdoelen | typeof itemState | typeof pins | typeof briefings) =>
    withUser(
      db,
      userId,
      async (tx) => ((await tx.select({ n: sql<number>`count(*)::int` }).from(t)) as [{ n: number }])[0].n,
    );
  const ctx = await withUser(
    db,
    userId,
    async (tx) => ((await tx.select({ n: sql<number>`count(*)::int` }).from(contextIndex)) as [{ n: number }])[0].n,
  );
  return {
    tracker_items: await n(trackerItems),
    weekdoelen: await n(weekdoelen),
    item_state: await n(itemState),
    pins: await n(pins),
    briefings: await n(briefings),
    context_index: ctx,
  };
}

/**
 * Totaal over de hele database: gebruikers, auditregels en rijen in de per-collega-tabellen. Gebruikers als de
 * migratierol (regel users_definer); de rest per gebruiker via withUser (de migratierol is lid van hz_worker).
 */
async function counts() {
  const owner = createOwnerDb(URL_, 1);
  try {
    const ids = (await owner.db.execute<{ id: string }>(sql`select id from users order by id`)).rows.map((r) => r.id);
    let audit = 0;
    let rows = 0;
    for (const id of ids) {
      audit += await withUser(
        db,
        id,
        async (tx) => ((await tx.select({ n: sql<number>`count(*)::int` }).from(auditLog)) as [{ n: number }])[0].n,
      );
      const t = await totals(id);
      rows += t.tracker_items + t.weekdoelen + t.item_state + t.pins + t.briefings;
    }
    return { users: ids.length, audit, rows };
  } finally {
    await owner.close();
  }
}

const EXPECTED = { tracker_items: 14, weekdoelen: 7, item_state: 15, pins: 2, briefings: 2, context_index: 10 };

describe('export lezen', () => {
  it('JSON-bestand met collections: elke collectie met zijn docs', () => {
    expect(Object.keys(cols).sort()).toEqual(
      [
        'briefings',
        'commitments',
        'context_acties',
        'context_partners',
        'context_persoonlijk',
        'context_status',
        'iets_anders',
        'itemstate',
        'processed',
        'weekdoelen',
      ].sort(),
    );
    expect(cols.commitments).toHaveLength(22);
    expect(cols.itemstate!.find((d) => d.id === 'tk:g1')!.data).toMatchObject({ plan: '2026-11-02', moved: 1 });
  });

  it('ook als lijst van {id, data} of {id, ...velden}; meta-velden op het hoogste niveau tellen niet', () => {
    const c = normalizeExport({
      exportedAt: '2026-10-30',
      commitments: [
        { id: 'a', data: { wat: 'A' } },
        { id: 'b', wat: 'B', stroom: 'voornemen' },
      ],
      itemstate: { k: { read: true } },
    });
    expect(c).toEqual({
      commitments: [
        { id: 'a', data: { wat: 'A' } },
        { id: 'b', data: { wat: 'B', stroom: 'voornemen' } },
      ],
      itemstate: [{ id: 'k', data: { read: true } }],
    });
    expect(() => normalizeExport({ commitments: [{ wat: 'zonder id' }] })).toThrow(/geen id/);
    expect(() => normalizeExport([])).toThrow(/JSON-object/);
  });

  it('een map met per collectie <id>.json (zoals de contextexport) geeft hetzelfde als het bestand', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hz-e2-export-'));
    try {
      const raw = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { collections: Record<string, Record<string, unknown>> };
      for (const [c, docs] of Object.entries(raw.collections)) {
        mkdirSync(join(dir, c));
        for (const [id, data] of Object.entries(docs)) writeFileSync(join(dir, c, `${id}.json`), JSON.stringify(data));
      }
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ commitments: ['x'] }));
      const fromDir = readExport(dir);
      const sortDocs = (x: ExportCollections) =>
        Object.fromEntries(
          Object.entries(x).map(([k, v]) => [k, [...v].sort((p, q) => p.id.localeCompare(q.id))] as const),
        );
      expect(sortDocs(fromDir)).toEqual(sortDocs(cols));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('plan: export naar rijen (zonder database)', () => {
  it('aantallen per tabel en elk doc verantwoord (gebruikt of overgeslagen met reden)', () => {
    const p = planImport(cols);
    expect({
      tracker_items: p.tracker.length,
      weekdoelen: p.weekdoelen.length,
      item_state: p.itemState.length,
      pins: p.pins.length,
      briefings: p.briefings.length,
      context_index: p.contextIndex.length,
    }).toEqual(EXPECTED);
    for (const [c, n] of Object.entries(p.voor))
      expect((p.gebruikt[c] ?? 0) + p.overgeslagen.filter((s) => s.collectie === c).length, c).toBe(n);
    expect(p.overgeslagen.map((s) => `${s.collectie}/${s.id}`).sort()).toEqual(
      [
        'briefings/b-2026-10-29-oud',
        'briefings/b-zonder-datum',
        'commitments/bad-leeg',
        'commitments/bad-stroom',
        'context_partners/kapot',
        'context_persoonlijk/aangehouden',
        'context_persoonlijk/taken',
        'context_persoonlijk/wachten-op',
        'iets_anders/x',
      ].sort(),
    );
  });

  it('toezeggingen: velden uit het prototype op hun kolom, de rest in extra; stroom ontbreekt = mijn', () => {
    const p = planImport(cols);
    const dc3 = p.tracker.find((t) => t.legacyId === 'dc3')!;
    expect(dc3).toMatchObject({
      stroom: 'mijn',
      wat: 'Rekenvoorbeeld thuisbatterij naar Feenstra sturen',
      aan: 'Femke',
      org: 'Feenstra',
      deadline: '2026-10-29',
      srcKey: 'sl_CFE_1761650000.000100',
      citaat: 'Ik stuur je het rekenvoorbeeld',
      created: '2026-10-27',
      bron: { label: 'Meeting · Feenstra check-in' },
    });
    expect(dc3.extra).toEqual({ week: null, health: null, bewijsregel: { type: 'geen' } });
    expect(p.tracker.find((t) => t.legacyId === 'dc4')).toMatchObject({ planDate: '2026-11-02', moved: 1 });
    expect(p.tracker.find((t) => t.legacyId === 'zonder-stroom')!.stroom).toBe('mijn');
    expect(p.tracker.find((t) => t.legacyId === 'ov1')!.overgezet).toBe(true);
    expect(p.tracker.find((t) => t.legacyId === 'bad-status')!.status).toBe('open');
    expect(p.waarschuwingen.some((w) => w.includes('bad-status'))).toBe(true);
  });

  it('weekdoelen en roadmap: checks gefilterd op geldige gezondheid, outcomeNote bewaard in extra', () => {
    const p = planImport(cols);
    const by = (id: string) => p.weekdoelen.find((w) => w.legacyId === id)!;
    expect(by('dr1').soort).toBe('roadmap');
    expect(by('dg00')).toMatchObject({ status: 'klaar', outcome: 'gehaald', health: 'af', closedAt: '2026-10-23' });
    expect(by('dg00').extra).toEqual({ outcomeNote: 'Live op 23 okt' });
    expect(by('dg1').extra).toEqual({ lastCheck: '2026-10-29' });
    expect(by('dg2').checks).toEqual([{ d: '2026-10-29', h: 'oranje' }]);
    expect(by('weekdoelen:wk-extra')).toMatchObject({ week: '2026-W45', soort: 'weekdoel' });
  });

  it('itemstatus: _pins naar pins (zonder dubbelen), processed samengevoegd, de nieuwste briefing per dag', () => {
    const p = planImport(cols);
    expect(p.pins.map((x) => [x.q, x.label])).toEqual([
      ['feenstra, offerte', 'Feenstra · offerte'],
      ['tonzon, tijdlijn', 'TonZon · tijdlijn'],
    ]);
    const st = (k: string) => p.itemState.find((s) => s.itemKey === k)!;
    expect(st('wm:r1').processed).toBe(true);
    expect(st('wm:r2')).toMatchObject({ processed: true });
    expect(st('tk:g1')).toMatchObject({ planDate: '2026-11-02', moved: 1 });
    expect(st('sl_CFE_1761660000.000200')).toMatchObject({ read: true, answeredBy: 'Lisanne' });
    expect(st('_aang-2026-10-28-x').extra).toMatchObject({ keuze: 'privé' });
    expect(p.briefings.find((b) => b.date === '2026-10-29')!.title).toBe('☀️ Briefing do 29 okt');
  });

  it('briefing: velden zonder kolom en secties die niet in de vaste vorm passen, blijven bewaard in extra', () => {
    const raw = {
      briefings: [
        {
          id: 'b-extra',
          data: {
            date: '2026-11-03',
            title: 'Briefing di 3 nov',
            bron: 'routine',
            stats: { mails: 4, slack: 9 },
            leeg: null,
            sections: [
              { items: [{ url: 'https://example.com/a', text: 'Volgorde telt niet' }], title: 'Vandaag' },
              { title: 'Met meer', icon: '☀', items: [{ text: 'x', prio: 1 }, 'los item'] },
            ],
          },
        },
        {
          id: 'b-netjes',
          data: { date: '2026-11-04', title: 'Netjes', sections: [{ title: 'A', items: [{ text: 't' }] }] },
        },
      ],
    } satisfies ExportCollections;
    const p = planImport(raw);
    const b = p.briefings.find((x) => x.date === '2026-11-03')!;
    expect(b.extra).toEqual({
      bron: 'routine',
      stats: { mails: 4, slack: 9 },
      leeg: null,
      sections: raw.briefings[0]!.data.sections,
    });
    expect(b.sections).toEqual([
      { title: 'Vandaag', items: [{ text: 'Volgorde telt niet', url: 'https://example.com/a' }] },
      { title: 'Met meer', items: [{ text: 'x' }] },
    ]);
    expect(p.waarschuwingen.join('\n')).toMatch(
      /b-extra: veld\(en\) bron, stats, leeg hebben geen kolom, bewaard in extra/,
    );
    expect(p.waarschuwingen.join('\n')).toMatch(/b-extra: sections past niet volledig/);
    // een briefing die precies past: lege extra, geen waarschuwing
    expect(p.briefings.find((x) => x.date === '2026-11-04')!.extra).toEqual({});
    expect(p.waarschuwingen.join('\n')).not.toMatch(/b-netjes/);
  });

  it('gtask zoals het prototype hem schrijft: object {id, tasklist} (planCommit) of tekst "gtask:<id>" (c-gtask)', () => {
    const p = planImport(cols);
    const t = (id: string) => p.tracker.find((x) => x.legacyId === id)!;
    // planCommit(): patch.gtask = await gtaskAdd(...) = {id, tasklist}
    expect(t('gt-plan')).toMatchObject({ gtask: 'tk-demo-1', planDate: '2026-11-03', naar: 'taken.md' });
    expect(t('gt-plan').extra!.gtask).toEqual({ tasklist: 'L' });
    // taskFromCommit(): 'gtask:' + id
    expect(t('old-gt').gtask).toBe('abc');
    expect(t('old-gt').extra).toEqual({});
    // findId() vond geen id: geen kolomwaarde, maar de hele waarde blijft in extra (en het item blijft verborgen)
    expect(t('gt-noid').gtask).toBeNull();
    expect(t('gt-noid').extra!.gtask).toEqual({ id: null, tasklist: 'L' });
    expect(p.waarschuwingen).toContain('commitments/gt-noid: veld gtask past niet in zijn kolom, bewaard in extra');
    // Geen gtask: niets in extra
    expect(t('dc3').gtask).toBeNull();
    expect('gtask' in t('dc3').extra!).toBe(false);
  });

  it('de vondst van de criticus: {stroom:mijn, gtask:{id,tasklist}} en itemstate {read, handledBy} gaan niet verloren', () => {
    const p = planImport({
      commitments: [{ id: 'x1', data: { wat: 'Taak', stroom: 'mijn', gtask: { id: 't2', tasklist: 'demo' } } }],
      itemstate: [{ id: 'sl_C1_1.2', data: { read: true, handledBy: 'Lisanne', at: 1793264400000 } }],
    });
    expect(p.tracker[0]).toMatchObject({ gtask: 't2', extra: { gtask: { tasklist: 'demo' } } });
    expect(trackerItemVisible({ ...p.tracker[0]!, bron: null, overgezet: false } as never)).toBe(false);
    expect(p.itemState[0]).toMatchObject({ read: true, answeredBy: 'Lisanne', extra: {} });
  });

  it('itemstatus: handledBy (wat het prototype schrijft) naar answered_by; answeredBy blijft een alias', () => {
    const p = planImport(cols);
    const st = (k: string) => p.itemState.find((s) => s.itemKey === k)!;
    expect(st('sl_CFE_1761670000.000300')).toMatchObject({ read: true, answeredBy: 'Lisanne', extra: {} });
    expect(st('sl_CFE_1761660000.000200')).toMatchObject({ answeredBy: 'Lisanne', extra: {} });
    // Beide, verschillend: handledBy wint, answeredBy blijft in extra
    const both = planImport({ itemstate: [{ id: 'k', data: { handledBy: 'A', answeredBy: 'B' } }] }).itemState[0]!;
    expect(both).toMatchObject({ answeredBy: 'A', extra: { answeredBy: 'B' } });
    // De andere setState-velden uit het prototype in extra
    expect(st('sl_CFE_1761690000.000400').extra).toEqual({ reacted: 'eyes' });
    expect(st('wm:r3').extra).toEqual({ recapSession: 'gestart' });
    expect(st('wm:r4')).toMatchObject({ processed: true, extra: { added: 2 } });
    expect(st('_post-2026-W44-review').extra).toEqual({ done: true, skipped: false });
    expect(st('_nudge-repo').extra).toEqual({ until: '2026-11-05' });
    expect(st('_taak-1a2b3c').extra).toEqual({ done: 'gtask' });
    expect(st('_goals-2026-W45').extra).toEqual({ skip: true });
  });

  it('toezeggingen uit Inhalen (itemToCommit): src = item-sleutel, bron met key, bewijsregel en bewijs bewaard', () => {
    const p = planImport(cols);
    const i = p.tracker.find((x) => x.legacyId === 'inbox1')!;
    expect(i).toMatchObject({
      stroom: 'aan_mij',
      status: 'waarschijnlijk_klaar',
      srcKey: 'sl_CFE_1761680000.000500',
      bewijs: 'Slack-bericht van jou met “sync”',
      bron: { key: 'sl_CFE_1761680000.000500', label: 'Slack · #feenstra-hz' },
    });
    expect(i.extra!.bewijsregel).toEqual({ type: 'slack', to: '', keywords: ['sync'] });
    // Een object als src (meegenomen weekdoel: {from}) gaat bij een weekdoel naar extra
    expect(p.weekdoelen.find((w) => w.legacyId === 'wd-mee')!.extra!.src).toEqual({ from: 'dg0' });
    // srcOf()-object als src bij een toezegging: key naar de kolom, de rest naar extra
    const o = planImport({
      commitments: [{ id: 'y', data: { wat: 'Y', stroom: 'aan_mij', src: { key: 'gm:1', label: 'Mail', url: null } } }],
    }).tracker[0]!;
    expect(o).toMatchObject({ srcKey: 'gm:1', extra: { src: { label: 'Mail', url: null } } });
  });

  it('een doorgeschoven weekdoel (stroom mijn) houdt week, outcome, outcomeNote, checks en lastCheck in extra', () => {
    const p = planImport(cols);
    const w = p.tracker.find((x) => x.legacyId === 'wd-door')!;
    expect(w.stroom).toBe('mijn');
    expect(w.extra).toMatchObject({
      week: '2026-W43',
      outcome: 'doorgeschoven',
      outcomeNote: 'Pas na de mailing',
      lastCheck: '2026-10-22',
      checks: [
        { d: '2026-10-22', h: 'oranje', note: '' },
        { d: '2026-10-24', h: 'oranje', note: 'Pas na de mailing' },
      ],
    });
    // en checks met een onbekende gezondheid blijven bij een weekdoel bewaard
    expect(p.weekdoelen.find((x) => x.legacyId === 'dg2')!.extra!.checksOngeldig).toEqual([
      { d: '2026-10-29', h: 'paars' },
    ]);
  });

  it('een onleesbare waarde gaat met waarschuwing naar extra, niet stil weg', () => {
    const p = planImport({
      commitments: [{ id: 'z', data: { wat: 'Z', stroom: 'mijn', deadline: 'volgende week', moved: 'twee' } }],
    });
    expect(p.tracker[0]).toMatchObject({
      deadline: null,
      moved: 0,
      extra: { deadline: 'volgende week', moved: 'twee' },
    });
    expect(p.waarschuwingen).toEqual([
      'commitments/z: veld deadline past niet in zijn kolom, bewaard in extra',
      'commitments/z: veld moved past niet in zijn kolom, bewaard in extra',
    ]);
  });

  it('contextlaag: partners, projecten, meetings en acties als indexrijen; geheim_voor mee; nooit admin.md', () => {
    const p = planImport(cols);
    const ids = p.contextIndex.map((r) => r.id);
    expect(ids).toContain('partners/feenstra/brief.md');
    expect(ids).toContain('partners/feenstra/meetings/2026-10-29-werksessie-zsb-flow-robert.md');
    expect(ids).toContain('partners/feenstra/acties.md#feenstra-20261029-2');
    expect(ids).toContain('partners/tonzon/acties.md#regel-1');
    expect(ids).toContain('projecten/installateursnetwerk/brief.md');
    expect(ids).toContain('projecten/installateursnetwerk/acties.md#installateursnetwerk-20261001-1');
    expect(p.contextIndex.find((r) => r.slug === 'sunergy')!.geheimVoor).toEqual(['tonzon']);
    expect(p.contextIndex.every((r) => r.commit === 'demo123')).toBe(true);
    expect(ids.some((i) => /admin\.md/.test(i))).toBe(false);
    expect(p.status?.geexporteerd).toBe('2026-10-30T07:20:00+01:00');
  });
});

describe('import in Postgres (RLS, als hz_app)', () => {
  let first: ImportReport;
  let robert: string;

  it('eerste run: aantallen voor en na kloppen per tabel', async () => {
    first = await importPrototype(db, { email: ROBERT, name: 'Robert', collections: cols });
    robert = first.gebruiker.id!;
    expect(first.klopt).toBe(true);
    for (const [t, n] of Object.entries(EXPECTED)) {
      expect(first.tabellen[t as keyof typeof EXPECTED], t).toMatchObject({
        verwacht: n,
        nieuw: n,
        na: n,
        klopt: true,
      });
    }
    expect(await totals(robert)).toEqual(EXPECTED);
    expect(first.voor).toMatchObject({ commitments: 22, itemstate: 15, briefings: 4, processed: 2 });
    expect(Object.values(first.verantwoord).every((v) => v.klopt)).toBe(true);
  });

  it('tweede run met dezelfde export: niets nieuw, niets bijgewerkt, zelfde aantallen (idempotent)', async () => {
    const before = await totals(robert);
    const second = await importPrototype(db, { email: ROBERT, collections: cols });
    expect(second.gebruiker.id).toBe(robert);
    expect(second.klopt).toBe(true);
    for (const [t, n] of Object.entries(EXPECTED))
      expect(second.tabellen[t as keyof typeof EXPECTED], t).toMatchObject({
        verwacht: n,
        nieuw: 0,
        bijgewerkt: 0,
        ongewijzigd: n,
        na: n,
      });
    expect(await totals(robert)).toEqual(before);
  });

  it('ook een derde run vanuit een map-export verandert niets', async () => {
    const r = await importPrototype(db, { email: ROBERT, exportPath: FIXTURE });
    expect(Object.values(r.tabellen).every((t) => t.nieuw === 0 && t.bijgewerkt === 0)).toBe(true);
    expect(await totals(robert)).toEqual(EXPECTED);
  });

  it('de rijen kloppen met het prototype (tracker, weekdoelen, briefing, planning)', async () => {
    const t = await withUser(db, robert, (tx) => tx.select().from(trackerItems).where(eq(trackerItems.legacyId, 'q1')));
    expect(t[0]).toMatchObject({
      stroom: 'aan_mij',
      aan: 'Lisanne',
      reminder: '2026-11-03',
      naar: 'wachten-op.md',
      bron: { label: 'Slack · DM', url: 'https://example.slack.com/archives/D1/p1' },
    });
    const w = await withUser(db, robert, (tx) => tx.select().from(weekdoelen).where(eq(weekdoelen.legacyId, 'dg0')));
    expect(w[0]).toMatchObject({ health: 'oranje', week: '2026-W43' });
    expect(w[0]!.checks).toEqual([{ d: '2026-10-22', h: 'oranje', note: 'Wacht op input Lisanne' }]);
    const b = await withUser(db, robert, (tx) => tx.select().from(briefings).where(eq(briefings.date, '2026-10-30')));
    expect(b[0]!.sections).toHaveLength(3);
    expect(b[0]!.createdAt.toISOString()).toBe('2026-10-30T06:14:00.000Z');
    const s = await withUser(db, robert, (tx) => tx.select().from(itemState).where(eq(itemState.itemKey, 'tk:g1')));
    expect(s[0]).toMatchObject({ planDate: '2026-11-02', moved: 1, backlog: false });
  });

  it('in de database: gtask-id en tasklist, answered_by uit handledBy; gekoppelde taken niet zichtbaar', async () => {
    const all = await withUser(db, robert, (tx) => tx.select().from(trackerItems));
    const gp = all.find((t) => t.legacyId === 'gt-plan')!;
    expect(gp).toMatchObject({ gtask: 'tk-demo-1', extra: expect.objectContaining({ gtask: { tasklist: 'L' } }) });
    const zichtbaar = all.filter(trackerItemVisible).map((t) => t.legacyId);
    for (const id of ['gt-plan', 'gt-noid', 'old-gt']) expect(zichtbaar).not.toContain(id);
    expect(zichtbaar).toContain('inbox1');
    const [st] = await withUser(db, robert, (tx) =>
      tx.select().from(itemState).where(eq(itemState.itemKey, 'sl_CFE_1761670000.000300')),
    );
    expect(st).toMatchObject({ read: true, answeredBy: 'Lisanne', extra: {} });
  });

  it('een wijziging in de app na de export blijft staan; app-rijen zonder legacy-id raakt de import niet', async () => {
    await setItemState(db, robert, 'sl_CFE_1761650000.000100', { read: false });
    const [own] = await withUser(db, robert, (tx) =>
      tx.insert(weekdoelen).values({ userId: robert, wat: 'Eigen doel uit de app', week: '2026-W45' }).returning(),
    );
    const r = await importPrototype(db, { email: ROBERT, collections: cols });
    expect(r.tabellen.item_state).toMatchObject({ nieuw: 0, bijgewerkt: 0, inAppGewijzigd: 1, na: 15 });
    const s = await withUser(db, robert, (tx) =>
      tx.select().from(itemState).where(eq(itemState.itemKey, 'sl_CFE_1761650000.000100')),
    );
    expect(s[0]!.read).toBe(false);
    const still = await withUser(db, robert, (tx) => tx.select().from(weekdoelen).where(eq(weekdoelen.id, own!.id)));
    expect(still[0]!.wat).toBe('Eigen doel uit de app');
    expect(r.tabellen.weekdoelen).toMatchObject({ verwacht: 7, na: 7, klopt: true });
  });

  it('een nieuwere export werkt alleen de gewijzigde rijen bij', async () => {
    const next = structuredClone(cols);
    next.commitments!.find((d) => d.id === 'dc4')!.data.wat = 'Isolatierekenmodel nalopen met Lisanne';
    next.commitments!.push({ id: 'nieuw1', data: { wat: 'Nieuwe belofte', stroom: 'mijn', status: 'open' } });
    const r = await importPrototype(db, { email: ROBERT, collections: next });
    expect(r.tabellen.tracker_items).toMatchObject({ verwacht: 15, nieuw: 1, bijgewerkt: 1, ongewijzigd: 13, na: 15 });
    expect(r.klopt).toBe(true);
    const [dc4] = await withUser(db, robert, (tx) =>
      tx.select().from(trackerItems).where(eq(trackerItems.legacyId, 'dc4')),
    );
    expect(dc4!.wat).toBe('Isolatierekenmodel nalopen met Lisanne');
    // terug naar de vaste export voor de volgende tests
    await withUser(db, robert, (tx) => tx.delete(trackerItems).where(eq(trackerItems.legacyId, 'nieuw1')));
    await importPrototype(db, { email: ROBERT, collections: cols });
  });

  it('opnieuw importeren zet een in de app aangepast weekdoel niet terug (dezelfde en een nieuwere export)', async () => {
    // De fout uit ronde 1: health rood + notitie via PATCH /api/weekdoelen/:id, daarna opnieuw importeren.
    const [dg1] = await withUser(db, robert, (tx) =>
      tx.select().from(weekdoelen).where(eq(weekdoelen.legacyId, 'dg1')),
    );
    expect(dg1).toMatchObject({ health: 'groen', wat: 'Isolatieflow TonZon live op acceptatie' });
    const patched = await updateWeekdoel(db, robert, dg1!.id, { health: 'rood', note: 'vast' }, '2026-11-06');
    expect(patched!.updatedAt.getTime()).toBeGreaterThan(patched!.importedAt!.getTime());
    const appChecks = [...dg1!.checks, { d: '2026-11-06', h: 'rood', note: 'vast' }];
    const check = async () => {
      const [w] = await withUser(db, robert, (tx) => tx.select().from(weekdoelen).where(eq(weekdoelen.id, dg1!.id)));
      expect(w).toMatchObject({ health: 'rood', checks: appChecks, wat: 'Isolatieflow TonZon live op acceptatie' });
    };

    // 1. Dezelfde export: de app wint, het verslag zegt "overgeslagen: in app gewijzigd", niet "bijgewerkt".
    const same = await importPrototype(db, { email: ROBERT, collections: cols });
    expect(same.klopt).toBe(true);
    expect(same.tabellen.weekdoelen).toMatchObject({
      verwacht: 7,
      nieuw: 0,
      bijgewerkt: 0,
      inAppGewijzigd: 1,
      ongewijzigd: 6,
      na: 7,
    });
    await check();
    const txt = formatReport(same);
    expect(txt).toMatch(/overgeslagen:/);
    expect(txt).toMatch(/in app gewijzigd/);
    expect(txt).toMatch(/weekdoelen\s+7\s+0\s+0\s+6\s+1\s+0\s+7/);
    expect(txt).toMatch(/item_state\s+15\s+0\s+0\s+14\s+1\s+0\s+15/); // de leesstatus uit de vorige test
    expect(txt).toMatch(/De app wint: 2 rij/);

    // 2. Een nieuwere export die dg1 (anders) en dg2 wijzigt: dg1 blijft zoals in de app, dg2 wordt bijgewerkt.
    const next = structuredClone(cols);
    const d1 = next.commitments!.find((d) => d.id === 'dg1')!.data;
    d1.health = 'groen';
    d1.wat = 'Isolatieflow TonZon live op productie';
    d1.checks = [...(d1.checks as unknown[]), { d: '2026-11-05', h: 'groen' }];
    next.commitments!.find((d) => d.id === 'dg2')!.data.health = 'groen';
    const newer = await importPrototype(db, { email: ROBERT, collections: next });
    expect(newer.klopt).toBe(true);
    expect(newer.tabellen.weekdoelen).toMatchObject({ bijgewerkt: 1, inAppGewijzigd: 1, ongewijzigd: 5, na: 7 });
    await check();
    const [dg2] = await withUser(db, robert, (tx) =>
      tx.select().from(weekdoelen).where(eq(weekdoelen.legacyId, 'dg2')),
    );
    expect(dg2!.health).toBe('groen');
    // dg2 kwam uit de import: niet als "in app gewijzigd" gemarkeerd
    expect(dg2!.updatedAt.getTime()).toBe(dg2!.importedAt!.getTime());

    // 3. Terug naar de vaste export: dg1 blijft van de app, dg2 terug naar oranje.
    const back = await importPrototype(db, { email: ROBERT, collections: cols });
    expect(back.tabellen.weekdoelen).toMatchObject({ bijgewerkt: 1, inAppGewijzigd: 1 });
    await check();
  });

  it('ook tracker-items: in de app gewijzigd blijft staan, in de app verwijderd komt niet terug', async () => {
    // Zoals het Tracker-stuk een item bijwerkt (als hz_app, onder RLS). updated_at zet de trigger.
    await withUser(db, robert, (tx) =>
      tx.update(trackerItems).set({ status: 'klaar', closedAt: '2026-11-06' }).where(eq(trackerItems.legacyId, 'dc3')),
    );
    await withUser(db, robert, (tx) => tx.delete(trackerItems).where(eq(trackerItems.legacyId, 'b1')));
    const [w] = await withUser(db, robert, (tx) => tx.select().from(weekdoelen).where(eq(weekdoelen.legacyId, 'dr1')));
    await withUser(db, robert, (tx) => tx.delete(weekdoelen).where(eq(weekdoelen.id, w!.id)));
    const pin = (await listPins(db, robert)).find((x) => x.q === 'tonzon, tijdlijn')!;
    expect(await deletePin(db, robert, pin.id)).toBe(true);

    const next = structuredClone(cols);
    next.commitments!.find((d) => d.id === 'dc3')!.data.wat = 'Rekenvoorbeeld thuisbatterij (nieuwe tekst)';
    next.commitments!.find((d) => d.id === 'b1')!.data.wat = 'Ook gewijzigd in de export';
    for (const c of [cols, next]) {
      const r = await importPrototype(db, { email: ROBERT, collections: c });
      expect(r.klopt).toBe(true);
      expect(r.tabellen.tracker_items).toMatchObject({ verwacht: 14, inAppGewijzigd: 1, inAppVerwijderd: 1, na: 13 });
      expect(r.tabellen.weekdoelen).toMatchObject({ inAppVerwijderd: 1, na: 6 });
      expect(r.tabellen.pins).toMatchObject({ nieuw: 0, inAppVerwijderd: 1, ongewijzigd: 1, na: 1 });
      const [dc3] = await withUser(db, robert, (tx) =>
        tx.select().from(trackerItems).where(eq(trackerItems.legacyId, 'dc3')),
      );
      expect(dc3).toMatchObject({ status: 'klaar', wat: 'Rekenvoorbeeld thuisbatterij naar Feenstra sturen' });
      const b1 = await withUser(db, robert, (tx) =>
        tx.select().from(trackerItems).where(eq(trackerItems.legacyId, 'b1')),
      );
      expect(b1).toEqual([]);
      expect((await listPins(db, robert)).map((x) => x.q)).toEqual(['feenstra, offerte']);
    }
  });

  it('rij-beveiliging: een andere collega ziet niets van Roberts import en zijn eigen import raakt Robert niet', async () => {
    const anna = (await upsertUser(db, 'anna@homezero.nl', 'Anna')).id;
    expect(await totals(anna)).toMatchObject({ tracker_items: 0, weekdoelen: 0, item_state: 0, pins: 0, briefings: 0 });
    const small: ExportCollections = {
      commitments: [{ id: 'dc3', data: { wat: 'Annas belofte met hetzelfde doc-id', stroom: 'mijn' } }],
    };
    const r = await importPrototype(db, { email: 'anna@homezero.nl', collections: small });
    expect(r.tabellen.tracker_items).toMatchObject({ nieuw: 1, na: 1 });
    const [mine] = await withUser(db, robert, (tx) =>
      tx.select().from(trackerItems).where(eq(trackerItems.legacyId, 'dc3')),
    );
    expect(mine!.wat).toBe('Rekenvoorbeeld thuisbatterij naar Feenstra sturen');
    const annas = await withUser(db, anna, (tx) => tx.select().from(trackerItems));
    expect(annas.map((x) => x.wat)).toEqual(['Annas belofte met hetzelfde doc-id']);
  });

  it('briefing met velden zonder kolom: extra staat in de database en een tweede run verandert niets', async () => {
    const c: ExportCollections = {
      briefings: [{ id: 'b-x', data: { date: '2026-11-05', title: 'B', sections: [], stem: 'kort', meta: { v: 2 } } }],
    };
    const g = (await upsertUser(db, 'gijs@homezero.nl', 'Gijs')).id;
    const r1 = await importPrototype(db, { email: 'gijs@homezero.nl', collections: c });
    expect(r1.tabellen.briefings).toMatchObject({ nieuw: 1, na: 1, klopt: true });
    const [row] = await withUser(db, g, (tx) => tx.select().from(briefings));
    expect(row!.extra).toEqual({ stem: 'kort', meta: { v: 2 } });
    const r2 = await importPrototype(db, { email: 'gijs@homezero.nl', collections: c });
    expect(r2.tabellen.briefings).toMatchObject({ nieuw: 0, bijgewerkt: 0, ongewijzigd: 1 });
  });

  it('proefdraai voor een nieuwe collega: doorgerekend, maar geen gebruiker, auditregel of rij aangemaakt', async () => {
    const before = await counts();
    const r = await importPrototype(db, { email: 'cees@homezero.nl', collections: cols, dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.klopt).toBe(true);
    expect(r.gebruiker).toEqual({ id: null, email: 'cees@homezero.nl' });
    expect(r.tabellen.tracker_items).toMatchObject({ verwacht: 14, nieuw: 14, na: 14 });
    expect(r.waarschuwingen.join('\n')).toMatch(/cees@homezero\.nl bestaat nog niet/);
    expect(await findUserByEmail(db, 'cees@homezero.nl')).toBeNull();
    expect(await counts()).toEqual(before);
    // de echte import daarna geeft dezelfde aantallen
    const echt = await importPrototype(db, { email: 'cees@homezero.nl', collections: cols });
    for (const t of ['tracker_items', 'weekdoelen', 'item_state', 'pins', 'briefings'] as const)
      expect(echt.tabellen[t], t).toMatchObject({ verwacht: r.tabellen[t].verwacht, nieuw: r.tabellen[t].nieuw });
  });

  it('proefdraai voor een bestaande collega: echt doorgerekend in de database en teruggedraaid', async () => {
    const u = (await upsertUser(db, 'fien@homezero.nl', 'Fien')).id;
    const before = await counts();
    const r = await importPrototype(db, { email: 'fien@homezero.nl', collections: cols, dryRun: true });
    expect(r.gebruiker.id).toBe(u);
    expect(r.klopt).toBe(true);
    expect(r.tabellen.tracker_items).toMatchObject({ verwacht: 14, nieuw: 14, na: 14 });
    expect(await totals(u)).toMatchObject({ tracker_items: 0, weekdoelen: 0, item_state: 0, pins: 0, briefings: 0 });
    expect(await counts()).toEqual(before);
  });

  it('de contextindex schrijft alleen de indexer (purpose index) en weigert admin.md', async () => {
    const plan = planImport({});
    plan.contextIndex = [{ id: 'partners/x/admin.md', kind: 'overig', path: 'partners/x/admin.md', title: 'MRR' }];
    const u = (await upsertUser(db, ROBERT, '')).id;
    await expect(applyImport(db, { id: u, email: ROBERT }, plan)).rejects.toThrow(/admin\.md/);
    const n = await withPurpose(db, 'index', (tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(contextIndex)
        .where(sql`path like '%admin.md'`),
    );
    expect(n[0]!.n).toBe(0);
  });

  it('verslag: aantallen leesbaar, zonder de inhoud van toezeggingen of briefings', () => {
    const txt = formatReport(first);
    expect(txt).toMatch(/Aantallen kloppen/);
    expect(txt).toMatch(/tracker_items\s+14\s+14/);
    expect(txt).not.toContain('Rekenvoorbeeld');
    expect(txt).not.toContain('Briefing vr 30 okt');
  });
});

describe('contextindex: opnieuw importeren ruimt verdwenen partners, meetings en acties op (als hz_indexer)', () => {
  const ctxRows = async () =>
    (await withPurpose(db, 'index', (tx) => tx.select({ id: contextIndex.id }).from(contextIndex)))
      .map((r) => r.id)
      .sort();
  const without = () => {
    const next = structuredClone(cols);
    next.context_partners = next.context_partners!.filter((d) => d.id !== 'sunergy');
    const fe = next.context_partners.find((d) => d.id === 'feenstra')!;
    (fe.data as { meetings: unknown[] }).meetings = [];
    const acties = next.context_acties!.find((d) => d.id === 'feenstra')!.data as { acties: Array<{ id?: string }> };
    acties.acties = acties.acties.filter((a) => a.id !== 'feenstra-20261029-2');
    return next;
  };

  it('verdwenen bestanden (partner, meeting) en acties gaan eruit; andere indexrijen (product, besluit) blijven', async () => {
    await importPrototype(db, { email: ROBERT, collections: cols });
    // Rijen van de indexjob die deze import niet maakt: nooit opruimen
    await upsertContextIndex(db, [
      { id: 'product/jira/HOM-1.md', kind: 'product', path: 'product/jira/HOM-1.md', title: 'Epic (voorbeeld)' },
      { id: 'organisatie/besluiten/x.md', kind: 'besluit', path: 'organisatie/besluiten/x.md', title: 'Besluit' },
    ]);
    const before = await ctxRows();
    expect(before).toContain('partners/sunergy/brief.md');
    expect(before).toContain('partners/feenstra/meetings/2026-10-29-werksessie-zsb-flow-robert.md');
    expect(before).toContain('partners/feenstra/acties.md#feenstra-20261029-2');

    // Proefdraai: verslag zegt wat eruit gaat, de index blijft gelijk
    const dry = await importPrototype(db, { email: ROBERT, collections: without(), dryRun: true });
    expect(dry.context.opgeruimd?.paden).toContain('partners/sunergy/brief.md');
    expect(await ctxRows()).toEqual(before);

    const r = await importPrototype(db, { email: ROBERT, collections: without() });
    expect(r.klopt).toBe(true);
    expect(r.context.opgeruimd).toEqual({
      paden: expect.arrayContaining([
        'partners/sunergy/brief.md',
        'partners/feenstra/meetings/2026-10-29-werksessie-zsb-flow-robert.md',
      ]),
      sleutels: ['partners/feenstra/acties.md#feenstra-20261029-2'],
    });
    const after = await ctxRows();
    expect(after.filter((x) => x.startsWith('partners/sunergy/'))).toEqual([]);
    expect(after).not.toContain('partners/feenstra/meetings/2026-10-29-werksessie-zsb-flow-robert.md');
    expect(after).not.toContain('partners/feenstra/acties.md#feenstra-20261029-2');
    expect(after).toContain('partners/feenstra/brief.md');
    expect(after).toContain('product/jira/HOM-1.md');
    expect(after).toContain('organisatie/besluiten/x.md');
    expect(r.tabellen.context_index.verwijderd).toBe(before.length - after.length);
    expect(formatReport(r)).toMatch(/Contextindex opgeruimd: \d+ rij/);

    // Nog een keer: niets meer op te ruimen
    const again = await importPrototype(db, { email: ROBERT, collections: without() });
    expect(again.tabellen.context_index).toMatchObject({ nieuw: 0, bijgewerkt: 0, verwijderd: 0 });
  });

  it('een export zonder contextcollecties ruimt niets op; meer dan de helft weg kan alleen geforceerd', async () => {
    const n0 = (await ctxRows()).length;
    const noCtx = Object.fromEntries(Object.entries(cols).filter(([k]) => !k.startsWith('context_')));
    const a = await importPrototype(db, { email: ROBERT, collections: noCtx });
    expect(a.tabellen.context_index.verwijderd).toBe(0);
    expect((await ctxRows()).length).toBe(n0);

    // Terug naar de volledige export (zodat er meer dan 10 rijen in scope zijn), dan een export met één partner
    await importPrototype(db, { email: ROBERT, collections: cols });
    const full = await ctxRows();
    const one = structuredClone(cols);
    one.context_partners = one.context_partners!.filter((d) => d.id === 'tonzon');
    one.context_acties = one.context_acties!.filter((d) => d.id === 'tonzon');
    const guarded = await importPrototype(db, { email: ROBERT, collections: one });
    expect(guarded.context.nietOpgeruimd).toMatch(/niet opgeruimd/);
    expect(guarded.waarschuwingen.some((w) => /opruimen-forceren/.test(w))).toBe(true);
    expect(await ctxRows()).toEqual(full);
    const forced = await importPrototype(db, { email: ROBERT, collections: one, opruimenForceren: true });
    expect(forced.tabellen.context_index.verwijderd).toBeGreaterThan(0);
    expect((await ctxRows()).filter((x) => x.startsWith('partners/feenstra/'))).toEqual([]);

    // Herstel voor de volgende tests: de volledige export, en de rijen van de indexjob weg
    await importPrototype(db, { email: ROBERT, collections: cols });
    for (const path of ['product/jira/HOM-1.md', 'organisatie/besluiten/x.md'])
      expect(await deleteContextIndexPath(db, path)).toBe(1);
    expect((await ctxRows()).length).toBe(EXPECTED.context_index);
  });
});

describe('opdrachtregel (import:prototype)', () => {
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ['--import', 'tsx', join(here, '../src/import-cli.ts'), ...args], {
      cwd: join(here, '..'),
      env: { ...process.env, DATABASE_URL: URL_, ...env },
      encoding: 'utf8',
    });

  it('proefdraai op de export: exitcode 0 en "Aantallen kloppen"', () => {
    const r = run(['--', '--export', FIXTURE, '--email', 'dirk@homezero.nl', '--proef']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/proefdraai/);
    expect(r.stdout).toMatch(/Aantallen kloppen/);
  }, 30_000);

  it('--json geeft het verslag als JSON', () => {
    const r = run(['--export', FIXTURE, '--email', 'dirk@homezero.nl', '--proef', '--json']);
    expect(r.status).toBe(0);
    const rep = JSON.parse(r.stdout) as ImportReport;
    expect(rep.tabellen.context_index.verwacht).toBe(10);
  }, 30_000);

  const as = (login: string) => {
    const u = new URL(URL_);
    u.username = login;
    u.password = login;
    return u.toString();
  };

  it('als de api-login (hz_app_login): geweigerd met uitleg, niets aangemaakt (die login kan niemand nadoen, 0011)', async () => {
    const before = await counts();
    const r = run(['--export', FIXTURE, '--email', 'eva@homezero.nl', '--json'], {
      DATABASE_URL: as('hz_app_login'),
      HZ_AUTH_DATABASE_URL: as('hz_auth_login'),
      HZ_INDEX_DATABASE_URL: '',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/hz_worker/);
    expect(await counts()).toEqual(before);
  }, 30_000);

  it('als worker-login met auth-login, zonder indexer-login: contextindex overgeslagen met uitleg, de rest geïmporteerd, exitcode 0', () => {
    const r = run(['--export', FIXTURE, '--email', 'eva@homezero.nl', '--json'], {
      DATABASE_URL: as('hz_worker_login'),
      HZ_AUTH_DATABASE_URL: as('hz_auth_login'),
      HZ_INDEX_DATABASE_URL: '',
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const rep = JSON.parse(r.stdout) as ImportReport;
    expect(rep.klopt).toBe(true);
    expect(rep.context.overgeslagen).toMatch(/hz_indexer/);
    expect(rep.tabellen.context_index.verwacht).toBe(0);
    expect(rep.verantwoord.context_partners).toMatchObject({ gebruikt: 0, overgeslagen: 5, klopt: true });
    expect(rep.tabellen.tracker_items).toMatchObject({ nieuw: 14, na: 14 });
  }, 30_000);

  it('met HZ_INDEX_DATABASE_URL (indexer-login) schrijft hij ook de contextindex; tweede run verandert niets', () => {
    const env = {
      DATABASE_URL: as('hz_worker_login'),
      HZ_AUTH_DATABASE_URL: as('hz_auth_login'),
      HZ_INDEX_DATABASE_URL: as('hz_indexer_login'),
    };
    // Eva is in de vorige test al geïmporteerd (zonder context); de contextrijen bestaan al van Roberts import.
    for (const ronde of [1, 2]) {
      const r = run(['--export', FIXTURE, '--email', 'eva@homezero.nl', '--json'], env);
      expect(r.status).toBe(0);
      const rep = JSON.parse(r.stdout) as ImportReport;
      expect(rep.context.overgeslagen).toBeUndefined();
      expect(rep.tabellen.context_index).toMatchObject({ verwacht: 10, na: 10, klopt: true });
      expect(rep.tabellen.tracker_items).toMatchObject({ nieuw: 0, bijgewerkt: 0, ongewijzigd: 14 });
      expect(rep.tabellen.context_index, `ronde ${ronde}`).toMatchObject({ nieuw: 0, bijgewerkt: 0, ongewijzigd: 10 });
    }
  }, 30_000);

  it('relatief --export-pad geldt vanaf de map waar je het commando typt (INIT_CWD), niet vanaf packages/db', () => {
    const appRoot = join(here, '../../..');
    const rel = 'packages/db/test/fixtures/prototype-export.json';
    const r = run(['--export', rel, '--email', 'dirk@homezero.nl', '--proef'], { INIT_CWD: appRoot });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Aantallen kloppen/);
    // vanaf packages/db zelf (zonder INIT_CWD): relatief aan de werkmap
    const r2 = run(['--export', 'test/fixtures/prototype-export.json', '--email', 'dirk@homezero.nl', '--proef'], {
      INIT_CWD: '',
    });
    expect(r2.status).toBe(0);
  }, 30_000);

  it('precies het commando uit de README: pnpm --filter @hz/db import:prototype -- --export <relatief pad> (vanaf de app-map)', () => {
    const appRoot = join(here, '../../..');
    const r = spawnSync(
      'pnpm',
      [
        '--silent',
        '--filter',
        '@hz/db',
        'import:prototype',
        '--',
        '--export',
        'packages/db/test/fixtures/prototype-export.json',
        '--email',
        'dirk@homezero.nl',
        '--proef',
      ],
      { cwd: appRoot, env: { ...process.env, DATABASE_URL: URL_, INIT_CWD: '' }, encoding: 'utf8' },
    );
    expect(r.stderr).not.toMatch(/niet gevonden/);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Aantallen kloppen/);
  }, 60_000);

  it('zonder export of e-mail: exitcode 2 met uitleg; een onbekend pad ook', () => {
    const a = run(['--email', 'dirk@homezero.nl']);
    expect(a.status).toBe(2);
    expect(a.stderr).toMatch(/gebruik/);
    const b = run(['--export', '/bestaat/niet.json', '--email', 'dirk@homezero.nl']);
    expect(b.status).toBe(2);
    expect(b.stderr).toMatch(/niet gevonden/);
  }, 30_000);
});
