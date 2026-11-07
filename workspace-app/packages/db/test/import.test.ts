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
  createDb,
  ensureDatabase,
  formatReport,
  importPrototype,
  itemState,
  normalizeExport,
  pins,
  planImport,
  readExport,
  runMigrations,
  setItemState,
  trackerItems,
  upsertUser,
  weekdoelen,
  withPurpose,
  withUser,
  type Db,
  type ExportCollections,
  type ImportReport,
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

const EXPECTED = { tracker_items: 10, weekdoelen: 6, item_state: 8, pins: 2, briefings: 2, context_index: 10 };

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
    expect(cols.commitments).toHaveLength(17);
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
      aan: 'Marie-José',
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
    robert = first.gebruiker.id;
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
    expect(first.voor).toMatchObject({ commitments: 17, itemstate: 8, briefings: 4, processed: 2 });
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

  it('een wijziging in de app na de export blijft staan; app-rijen zonder legacy-id raakt de import niet', async () => {
    await setItemState(db, robert, 'sl_CFE_1761650000.000100', { read: false });
    const [own] = await withUser(db, robert, (tx) =>
      tx.insert(weekdoelen).values({ userId: robert, wat: 'Eigen doel uit de app', week: '2026-W45' }).returning(),
    );
    const r = await importPrototype(db, { email: ROBERT, collections: cols });
    expect(r.tabellen.item_state).toMatchObject({ nieuw: 0, bijgewerkt: 0, na: 8 });
    const s = await withUser(db, robert, (tx) =>
      tx.select().from(itemState).where(eq(itemState.itemKey, 'sl_CFE_1761650000.000100')),
    );
    expect(s[0]!.read).toBe(false);
    const still = await withUser(db, robert, (tx) => tx.select().from(weekdoelen).where(eq(weekdoelen.id, own!.id)));
    expect(still[0]!.wat).toBe('Eigen doel uit de app');
    expect(r.tabellen.weekdoelen).toMatchObject({ verwacht: 6, na: 6, klopt: true });
  });

  it('een nieuwere export werkt alleen de gewijzigde rijen bij', async () => {
    const next = structuredClone(cols);
    next.commitments!.find((d) => d.id === 'dc4')!.data.wat = 'Isolatierekenmodel nalopen met Lisanne';
    next.commitments!.push({ id: 'nieuw1', data: { wat: 'Nieuwe belofte', stroom: 'mijn', status: 'open' } });
    const r = await importPrototype(db, { email: ROBERT, collections: next });
    expect(r.tabellen.tracker_items).toMatchObject({ verwacht: 11, nieuw: 1, bijgewerkt: 1, ongewijzigd: 9, na: 11 });
    expect(r.klopt).toBe(true);
    const [dc4] = await withUser(db, robert, (tx) =>
      tx.select().from(trackerItems).where(eq(trackerItems.legacyId, 'dc4')),
    );
    expect(dc4!.wat).toBe('Isolatierekenmodel nalopen met Lisanne');
    // terug naar de vaste export voor de volgende tests
    await withUser(db, robert, (tx) => tx.delete(trackerItems).where(eq(trackerItems.legacyId, 'nieuw1')));
    await importPrototype(db, { email: ROBERT, collections: cols });
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

  it('proefdraai: alles doorgerekend en gecontroleerd, niets opgeslagen', async () => {
    const r = await importPrototype(db, { email: 'cees@homezero.nl', collections: cols, dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.klopt).toBe(true);
    expect(r.tabellen.tracker_items).toMatchObject({ verwacht: 10, nieuw: 10, na: 10 });
    expect(await totals(r.gebruiker.id)).toMatchObject({ tracker_items: 0, weekdoelen: 0, item_state: 0, pins: 0 });
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
    expect(txt).toMatch(/tracker_items\s+10\s+10/);
    expect(txt).not.toContain('Rekenvoorbeeld');
    expect(txt).not.toContain('Briefing vr 30 okt');
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

  it('zonder export of e-mail: exitcode 2 met uitleg; een onbekend pad ook', () => {
    const a = run(['--email', 'dirk@homezero.nl']);
    expect(a.status).toBe(2);
    expect(a.stderr).toMatch(/gebruik/);
    const b = run(['--export', '/bestaat/niet.json', '--email', 'dirk@homezero.nl']);
    expect(b.status).toBe(2);
    expect(b.stderr).toMatch(/niet gevonden/);
  }, 30_000);
});
