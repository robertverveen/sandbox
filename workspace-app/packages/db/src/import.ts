/**
 * Import uit het prototype (HZW-021): de artifact-opslag van `workspace-prototype/index.html` naar Postgres.
 *
 * Een mens maakt de export (JSON); dit script leest hem in voor één collega. Echte data komt nooit in Git: de export
 * staat buiten de repo en wordt alleen runtime gelezen. Alles uit de export is data, nooit een instructie.
 *
 * Collecties (zie README, "Import uit het prototype"):
 * - commitments  -> weekdoelen (stroom weekdoel, roadmap) en tracker_items (mijn, voornemen, aan_mij, bespreken)
 * - weekdoelen   -> weekdoelen (optioneel; zelfde vorm als een commitment met stroom weekdoel)
 * - itemstate    -> item_state (leesstatus, verwerkt, geen prep, planning); `_pins` -> pins
 * - processed    -> item_state.processed (optioneel; doc-id = item-sleutel)
 * - briefings    -> briefings (één per dag; bij dubbele dagen de nieuwste)
 * - context_partners, context_acties -> context_index (gedeelde zoekindex; geheim_voor mee, nooit admin.md)
 * - context_persoonlijk -> overgeslagen: de app leest de Persoonlijk-repo live per collega, geen kopie
 * - context_status -> alleen gelezen (commit en exportdatum in het verslag en in context_index.commit)
 *
 * Idempotent: elke rij heeft een vaste sleutel (doc-id, item-sleutel, dag, zoekopdracht, pad). Een tweede run met
 * dezelfde export verandert niets.
 *
 * De app wint van de export (opnieuw importeren met een nieuwere export mag, en zet niets terug):
 * - tracker_items en weekdoelen: in de app gewijzigd sinds de vorige import (updated_at > imported_at; een trigger
 *   zet updated_at bij elke UPDATE) = de import laat de rij staan;
 * - item_state en briefings: de nieuwste wint (updated_at, created_at);
 * - in de app verwijderd na een eerdere import (import_keys onthoudt welke sleutels de import al schreef) = de import
 *   zet hem niet terug. Geldt voor tracker_items, weekdoelen, pins en briefings.
 * Het verslag telt die rijen apart: "overgeslagen: in app gewijzigd" en "in app verwijderd".
 *
 * Alles per collega loopt in één transactie als hz_app met withUser (RLS); de contextindex in één transactie als
 * hz_indexer via context_index_upsert (migratie 0009). Met dryRun wordt alles uitgevoerd en daarna teruggedraaid.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { and, eq, getTableName, inArray, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { ContextStatus, Partner, PartnerActies } from '@hz/shared';
import { canIndex, withIndexer, withUser, type Db, type Tx } from './client';
import { indexUpsertTx, upsertUser } from './repo';
import { briefings, contextIndex, importKeys, itemState, pins, trackerItems, weekdoelen } from './schema';

/* ---------- Export lezen ---------- */

export interface ExportDoc {
  id: string;
  data: Record<string, unknown>;
}
export type ExportCollections = Record<string, ExportDoc[]>;

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** Eén collectie: array van `{id, data}` of `{id, ...velden}`, of een object `id -> data`. */
function normalizeCollection(name: string, raw: unknown): ExportDoc[] {
  if (Array.isArray(raw)) {
    return raw.map((d, i) => {
      if (!isObj(d)) throw new Error(`export: ${name}[${i}] is geen object`);
      const id = typeof d.id === 'string' && d.id ? d.id : null;
      if (!id) throw new Error(`export: ${name}[${i}] heeft geen id`);
      if (isObj(d.data) && Object.keys(d).every((k) => k === 'id' || k === 'data')) return { id, data: d.data };
      const { id: _id, ...rest } = d;
      return { id, data: rest };
    });
  }
  if (isObj(raw)) {
    return Object.entries(raw).map(([id, data]) => {
      if (!isObj(data)) throw new Error(`export: ${name}/${id} is geen object`);
      return { id, data };
    });
  }
  throw new Error(`export: collectie ${name} is geen lijst of object`);
}

/** Hele export: `{ collections: {...} }` of de collecties op het hoogste niveau (meta-velden worden genegeerd). */
export function normalizeExport(raw: unknown): ExportCollections {
  if (!isObj(raw)) throw new Error('export: verwacht een JSON-object');
  const cols = isObj(raw.collections) ? raw.collections : raw;
  const out: ExportCollections = {};
  for (const [name, v] of Object.entries(cols)) {
    if (!isObj(raw.collections) && META_KEYS.has(name)) continue;
    out[name] = normalizeCollection(name, v);
  }
  return out;
}
const META_KEYS = new Set([
  'exportedAt',
  'geexporteerd',
  'source',
  'bron',
  'artifact',
  'versie',
  'version',
  'manifest',
]);

/**
 * Lees een export van schijf: één JSON-bestand, of een map met per collectie een submap met `<id>.json`
 * (zoals de contextexport; `manifest.json` wordt overgeslagen).
 */
export function readExport(path: string): ExportCollections {
  if (!existsSync(path)) throw new Error(`export niet gevonden: ${path}`);
  if (statSync(path).isFile()) return normalizeExport(JSON.parse(readFileSync(path, 'utf8')));
  const out: ExportCollections = {};
  for (const entry of readdirSync(path).sort()) {
    const sub = join(path, entry);
    if (statSync(sub).isDirectory()) {
      out[entry] = readdirSync(sub)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => {
          const data = JSON.parse(readFileSync(join(sub, f), 'utf8')) as unknown;
          if (!isObj(data)) throw new Error(`export: ${entry}/${f} is geen object`);
          return { id: basename(f, '.json'), data };
        });
    } else if (entry.endsWith('.json') && entry !== 'manifest.json') {
      Object.assign(out, normalizeExport(JSON.parse(readFileSync(sub, 'utf8'))));
    }
  }
  return out;
}

/* ---------- Plan: export -> rijen (puur, zonder database) ---------- */

export type TrackerInsert = Omit<typeof trackerItems.$inferInsert, 'userId'>;
export type WeekdoelInsert = Omit<typeof weekdoelen.$inferInsert, 'userId'>;
export type ItemStateInsert = Omit<typeof itemState.$inferInsert, 'userId'>;
export type BriefingInsert = Omit<typeof briefings.$inferInsert, 'userId'>;
export type PinInsert = Omit<typeof pins.$inferInsert, 'userId'>;
export type ContextIndexInsert = typeof contextIndex.$inferInsert;

export interface Skip {
  collectie: string;
  id: string;
  reden: string;
}

export const IMPORT_TABLES = [
  'tracker_items',
  'weekdoelen',
  'item_state',
  'pins',
  'briefings',
  'context_index',
] as const;
export type ImportTable = (typeof IMPORT_TABLES)[number];

export interface ImportPlan {
  tracker: TrackerInsert[];
  weekdoelen: WeekdoelInsert[];
  itemState: ItemStateInsert[];
  pins: PinInsert[];
  briefings: BriefingInsert[];
  contextIndex: ContextIndexInsert[];
  /** Aantal docs per collectie in de export (voor). */
  voor: Record<string, number>;
  /** Aantal docs per collectie dat in een rij terechtkwam (of in een andere rij opging, zoals processed). */
  gebruikt: Record<string, number>;
  overgeslagen: Skip[];
  waarschuwingen: string[];
  status: ContextStatus | null;
}

const STROOM_TRACKER = ['mijn', 'voornemen', 'aan_mij', 'bespreken'] as const;
const STROOM_DOEL = ['weekdoel', 'roadmap'] as const;
const STATUS = ['open', 'waarschijnlijk_klaar', 'klaar', 'te_laat', 'overgedragen', 'losgelaten'] as const;
const HEALTH = ['groen', 'oranje', 'rood', 'af'] as const;
const OUTCOME = ['gehaald', 'meegenomen', 'doorgeschoven', 'losgelaten'] as const;

const str = (x: unknown) => (typeof x === 'string' ? x : x == null ? '' : String(x));
const optStr = (x: unknown) => (typeof x === 'string' && x.trim() ? x : null);
const oneOf = <T extends string>(list: readonly T[], x: unknown): T | null =>
  typeof x === 'string' && (list as readonly string[]).includes(x) ? (x as T) : null;

/** JJJJ-MM-DD (ook uit een datum-tijd), of null. */
export function isoDate(x: unknown): string | null {
  if (typeof x !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(x.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return d.getUTCMonth() === +m[2]! - 1 && d.getUTCDate() === +m[3]! ? m[0] : null;
}
/** Tijdstip uit ms sinds epoch, ISO-tekst of datum; null als het niet te lezen is. */
function instant(x: unknown): Date | null {
  if (typeof x === 'number' && Number.isFinite(x) && x > 0) return new Date(x);
  if (typeof x === 'string' && x.trim()) {
    const d = new Date(x.length === 10 ? `${x}T09:00:00Z` : x);
    return Number.isNaN(+d) ? null : d;
  }
  if (isObj(x) && typeof x.seconds === 'number') return new Date(x.seconds * 1000);
  return null;
}
const isoWeek = (x: unknown) => (typeof x === 'string' && /^\d{4}-W\d{2}$/.test(x) ? x : null);
const pick = (d: Record<string, unknown>, known: readonly string[]) =>
  Object.fromEntries(Object.entries(d).filter(([k]) => !known.includes(k)));
function bron(x: unknown): { label: string; url?: string } | null {
  if (!isObj(x)) return typeof x === 'string' && x ? { label: x } : null;
  const label = str(x.label);
  const url = optStr(x.url);
  return label || url ? { label: label || 'Bron', ...(url ? { url } : {}) } : null;
}
const int = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);

const TRACKER_KNOWN = [
  'wat',
  'stroom',
  'aan',
  'org',
  'status',
  'deadline',
  'plan',
  'backlog',
  'moved',
  'reminder',
  'naar',
  'overgezet',
  'gtask',
  'src',
  'bron',
  'citaat',
  'bewijs',
  'created',
  'createdAt',
  'closedAt',
] as const;
const DOEL_KNOWN = [
  'wat',
  'stroom',
  'week',
  'deadline',
  'status',
  'health',
  'outcome',
  'checks',
  'closedAt',
  'bron',
  'created',
  'createdAt',
] as const;
const STATE_KNOWN = ['read', 'processed', 'skipPrep', 'answeredBy', 'plan', 'backlog', 'moved', 'at'] as const;

/** Zet een export om in rijen per tabel. Puur: raakt de database niet. */
export function planImport(cols: ExportCollections): ImportPlan {
  const plan: ImportPlan = {
    tracker: [],
    weekdoelen: [],
    itemState: [],
    pins: [],
    briefings: [],
    contextIndex: [],
    voor: {},
    gebruikt: {},
    overgeslagen: [],
    waarschuwingen: [],
    status: null,
  };
  const use = (c: string) => (plan.gebruikt[c] = (plan.gebruikt[c] ?? 0) + 1);
  const skip = (collectie: string, id: string, reden: string) => plan.overgeslagen.push({ collectie, id, reden });
  for (const [c, docs] of Object.entries(cols)) plan.voor[c] = docs.length;

  // Toezeggingen en doelen
  const doel = (c: string, legacyId: string, d: Record<string, unknown>, soort: 'weekdoel' | 'roadmap') => {
    const status = oneOf(STATUS, d.status ?? 'open');
    if (!status) plan.waarschuwingen.push(`${c}/${legacyId}: onbekende status "${str(d.status)}", gezet op open`);
    const health = d.health == null ? null : oneOf(HEALTH, d.health);
    if (d.health != null && !health) plan.waarschuwingen.push(`${c}/${legacyId}: onbekende health "${str(d.health)}"`);
    const checks = Array.isArray(d.checks)
      ? d.checks.flatMap((x) => {
          const dd = isObj(x) ? isoDate(x.d) : null;
          const h = isObj(x) ? oneOf(HEALTH, x.h) : null;
          if (!dd || !h) return [];
          const note = isObj(x) ? optStr(x.note) : null;
          return [{ d: dd, h, ...(note ? { note } : {}) }];
        })
      : [];
    plan.weekdoelen.push({
      legacyId,
      soort,
      week: isoWeek(d.week),
      wat: str(d.wat).trim(),
      deadline: isoDate(d.deadline),
      status: status ?? 'open',
      health,
      outcome: oneOf(OUTCOME, d.outcome),
      checks,
      closedAt: isoDate(d.closedAt),
      bron: bron(d.bron),
      extra: pick(d, DOEL_KNOWN),
      createdAt: instant(d.createdAt) ?? instant(d.created) ?? new Date(0),
    });
    use(c);
  };

  for (const { id, data: d } of cols.commitments ?? []) {
    if (!str(d.wat).trim()) {
      skip('commitments', id, 'geen tekst (wat)');
      continue;
    }
    const stroom = d.stroom == null || d.stroom === '' ? 'mijn' : d.stroom;
    const s = oneOf(STROOM_DOEL, stroom);
    if (s) {
      doel('commitments', id, d, s);
      continue;
    }
    const t = oneOf(STROOM_TRACKER, stroom);
    if (!t) {
      skip('commitments', id, `onbekende stroom "${str(stroom)}"`);
      continue;
    }
    const status = oneOf(STATUS, d.status ?? 'open');
    if (!status) plan.waarschuwingen.push(`commitments/${id}: onbekende status "${str(d.status)}", gezet op open`);
    const b = bron(d.bron);
    plan.tracker.push({
      legacyId: id,
      stroom: t,
      wat: str(d.wat).trim(),
      aan: str(d.aan),
      org: str(d.org),
      status: status ?? 'open',
      deadline: isoDate(d.deadline),
      planDate: isoDate(d.plan),
      backlog: d.backlog === true,
      moved: int(d.moved),
      reminder: isoDate(d.reminder),
      naar: optStr(d.naar),
      overgezet: d.overgezet === true,
      gtask: optStr(d.gtask),
      srcKey: optStr(d.src),
      bron: b,
      citaat: str(d.citaat),
      bewijs: optStr(d.bewijs),
      created: isoDate(d.created) ?? (instant(d.createdAt) ? instant(d.createdAt)!.toISOString().slice(0, 10) : null),
      closedAt: isoDate(d.closedAt),
      extra: pick(d, TRACKER_KNOWN),
      createdAt: instant(d.createdAt) ?? instant(d.created) ?? new Date(0),
    });
    use('commitments');
  }

  for (const { id, data: d } of cols.weekdoelen ?? []) {
    if (!str(d.wat).trim()) {
      skip('weekdoelen', id, 'geen tekst (wat)');
      continue;
    }
    doel('weekdoelen', `weekdoelen:${id}`, d, oneOf(STROOM_DOEL, d.stroom ?? d.soort) ?? 'weekdoel');
  }

  // Itemstatus, vastgezet en verwerkt
  const states = new Map<string, ItemStateInsert>();
  for (const { id, data: d } of cols.itemstate ?? []) {
    if (id === '_pins') {
      const list = Array.isArray(d.list) ? d.list : [];
      const seen = new Set(plan.pins.map((p) => p.q));
      list.forEach((p, i) => {
        const q = isObj(p) ? str(p.q).trim() : '';
        if (!q) return void plan.waarschuwingen.push(`itemstate/_pins[${i}]: geen zoekopdracht, overgeslagen`);
        if (seen.has(q)) return;
        seen.add(q);
        plan.pins.push({ kind: 'search', label: str((p as Record<string, unknown>).name).trim() || q, q, position: i });
      });
      use('itemstate');
      continue;
    }
    if (id.length > 500) {
      skip('itemstate', id.slice(0, 40) + '…', 'sleutel langer dan 500 tekens');
      continue;
    }
    const at = instant(d.at);
    states.set(id, {
      itemKey: id,
      read: d.read === true,
      readAt: d.read === true ? at : null,
      processed: d.processed === true,
      skipPrep: d.skipPrep === true,
      answeredBy: optStr(d.answeredBy),
      planDate: isoDate(d.plan),
      backlog: d.backlog === true,
      moved: int(d.moved),
      extra: pick(d, STATE_KNOWN),
      updatedAt: at ?? new Date(0),
    });
    use('itemstate');
  }
  for (const { id, data: d } of cols.processed ?? []) {
    const cur = states.get(id);
    const at = instant(d.at);
    if (cur) {
      cur.processed = true;
      if (at && cur.updatedAt instanceof Date && at > cur.updatedAt) cur.updatedAt = at;
    } else {
      states.set(id, { itemKey: id, processed: true, extra: {}, updatedAt: at ?? new Date(0) });
    }
    use('processed');
  }
  plan.itemState = [...states.values()];

  // Briefings: één per dag, de nieuwste wint
  const byDate = new Map<string, { id: string; row: BriefingInsert }>();
  for (const { id, data: d } of cols.briefings ?? []) {
    const date = isoDate(d.date);
    if (!date) {
      skip('briefings', id, 'geen geldige datum');
      continue;
    }
    const sections = Array.isArray(d.sections)
      ? d.sections.filter(isObj).map((s) => ({
          title: str(s.title),
          items: (Array.isArray(s.items) ? s.items : []).filter(isObj).map((i) => {
            const url = optStr(i.url);
            return { text: str(i.text), ...(url ? { url } : {}) };
          }),
        }))
      : [];
    const row: BriefingInsert = {
      date,
      title: str(d.title) || 'Ochtendbriefing',
      sections,
      session: optStr(d.session),
      createdAt: instant(d.createdAt) ?? new Date(`${date}T07:00:00Z`),
    };
    const prev = byDate.get(date);
    if (prev && (prev.row.createdAt as Date) >= (row.createdAt as Date)) {
      skip('briefings', id, `dubbele dag ${date}; de nieuwere (${prev.id}) blijft`);
      continue;
    }
    if (prev) skip('briefings', prev.id, `dubbele dag ${date}; de nieuwere (${id}) blijft`);
    byDate.set(date, { id, row });
  }
  plan.briefings = [...byDate.values()].map((x) => x.row);
  if (byDate.size) plan.gebruikt.briefings = byDate.size;

  // Contextlaag (gedeelde index)
  const st = cols.context_status?.find((x) => x.id === 'laatste') ?? cols.context_status?.[0];
  for (const { id, data } of cols.context_status ?? []) {
    if (st && id === st.id) {
      const p = ContextStatus.safeParse(data);
      if (p.success) {
        plan.status = p.data;
        use('context_status');
      } else skip('context_status', id, 'onleesbare status');
    } else skip('context_status', id, 'alleen de laatste status telt');
  }
  const commit = plan.status?.commit_context || null;
  const soortOf = new Map<string, 'partner' | 'project'>();
  for (const { id, data } of cols.context_partners ?? []) {
    const p = Partner.safeParse(data);
    if (!p.success) {
      skip('context_partners', id, 'geen geldige partner (register + brief)');
      continue;
    }
    const v = p.data;
    soortOf.set(v.slug, v.soort);
    const base = `${v.soort === 'project' ? 'projecten' : 'partners'}/${v.slug}`;
    plan.contextIndex.push({
      id: `${base}/brief.md`,
      kind: v.soort,
      slug: v.slug,
      path: `${base}/brief.md`,
      title: v.naam,
      body: [v.kern, ...v.stand, v.aliassen.join(' ')].filter(Boolean).join('\n'),
      data: {
        fase: v.fase,
        accountmanager: v.accountmanager,
        slack: v.slack,
        domeinen: v.domeinen,
        aliassen: v.aliassen,
        bijgewerkt: v.bijgewerkt,
        open_acties: v.open_acties,
      },
      geheimVoor: v.geheim_voor,
      commit,
    });
    for (const m of v.meetings) {
      if (!/^[\w.-]+\.md$/.test(m.bestand)) {
        plan.waarschuwingen.push(`context_partners/${id}: meetingbestand "${m.bestand}" overgeslagen`);
        continue;
      }
      plan.contextIndex.push({
        id: `${base}/meetings/${m.bestand}`,
        kind: 'meeting',
        slug: v.slug,
        path: `${base}/meetings/${m.bestand}`,
        title: `${m.datum} ${m.titel}`.trim(),
        body: [...m.samenvatting, ...m.besluiten, ...m.acties].join('\n'),
        data: { datum: m.datum, opgenomen_door: m.opgenomen_door, meeting_id: m.meeting_id },
        geheimVoor: v.geheim_voor,
        commit,
      });
    }
    use('context_partners');
  }
  for (const { id, data } of cols.context_acties ?? []) {
    const p = PartnerActies.safeParse(data);
    if (!p.success) {
      skip('context_acties', id, 'geen geldige actielijst');
      continue;
    }
    const v = p.data;
    const path = `${soortOf.get(v.slug) === 'project' ? 'projecten' : 'partners'}/${v.slug}/acties.md`;
    v.acties.forEach((a, i) => {
      plan.contextIndex.push({
        id: `${path}#${a.id || `regel-${i + 1}`}`,
        kind: 'actie',
        slug: v.slug,
        path,
        title: a.tekst,
        body: a.tekst,
        data: {
          state: a.state,
          voorstel: a.voorstel,
          eigenaar: a.eigenaar ?? '',
          datum: a.datum ?? '',
          ligt: a.ligt ?? '',
          sinds: a.sinds ?? '',
          bron: a.bron ?? '',
          id: a.id ?? '',
        },
        geheimVoor: v.geheim_voor,
        commit,
      });
    });
    use('context_acties');
  }
  for (const { id } of cols.context_persoonlijk ?? [])
    skip('context_persoonlijk', id, 'Persoonlijk-repo: de app leest die live per collega, geen kopie in de database');

  const KNOWN = new Set([
    'commitments',
    'weekdoelen',
    'itemstate',
    'processed',
    'briefings',
    'context_partners',
    'context_acties',
    'context_persoonlijk',
    'context_status',
  ]);
  for (const [c, docs] of Object.entries(cols)) {
    if (KNOWN.has(c)) continue;
    for (const d of docs) skip(c, d.id, 'onbekende collectie');
  }
  // Dubbele index-id's (bijv. twee acties zonder id met dezelfde tekst kan niet; dubbele id's in acties.md wel)
  const ids = new Set<string>();
  plan.contextIndex = plan.contextIndex.filter((r) => {
    if (ids.has(r.id)) {
      plan.waarschuwingen.push(`context: dubbele sleutel ${r.id}, alleen de eerste telt`);
      return false;
    }
    ids.add(r.id);
    return true;
  });
  return plan;
}

/* ---------- Toepassen ---------- */

export interface TableResult {
  /** Rijen die de export oplevert. */
  verwacht: number;
  nieuw: number;
  bijgewerkt: number;
  ongewijzigd: number;
  /** Overgeslagen: in de app gewijzigd sinds de vorige import. De app wint; de import laat de rij staan. */
  inAppGewijzigd: number;
  /** Overgeslagen: na een eerdere import in de app verwijderd. De import zet hem niet terug. */
  inAppVerwijderd: number;
  /** Rijen met deze sleutels in de database na de import. */
  na: number;
  klopt: boolean;
}

export interface ImportReport {
  gebruiker: { id: string; email: string };
  dryRun: boolean;
  /** Aantal docs per collectie in de export. */
  voor: Record<string, number>;
  /** Per collectie: docs = gebruikt + overgeslagen. */
  verantwoord: Record<string, { docs: number; gebruikt: number; overgeslagen: number; klopt: boolean }>;
  tabellen: Record<ImportTable, TableResult>;
  overgeslagen: Skip[];
  waarschuwingen: string[];
  /** overgeslagen: waarom de contextindex niet is bijgewerkt (geen indexer-login, of --zonder-context). */
  context: { commit: string | null; geexporteerd: string | null; overgeslagen?: string };
  klopt: boolean;
}

/** `(t.a, t.b) IS DISTINCT FROM (excluded.a, excluded.b)` en `set: { a: excluded.a, … }` voor een upsert. */
function excluded<T extends PgTable>(table: T, keys: string[]) {
  const t = getTableName(table);
  const cols = keys.map((k) => {
    const c = (table as unknown as Record<string, PgColumn>)[k];
    if (!c) throw new Error(`onbekende kolom ${k}`);
    return c.name;
  });
  const set = Object.fromEntries(keys.map((k, i) => [k, sql.raw(`excluded."${cols[i]}"`)]));
  const changed = sql.raw(
    `(${cols.map((c) => `"${t}"."${c}"`).join(', ')}) is distinct from (${cols.map((c) => `excluded."${c}"`).join(', ')})`,
  );
  return { set, changed };
}

const inserted = sql<boolean>`(xmax = 0)`;
type Counts = Pick<TableResult, 'nieuw' | 'bijgewerkt' | 'ongewijzigd' | 'inAppGewijzigd' | 'inAppVerwijderd'>;
/** Tellingen uit de teruggegeven rijen (alleen echt nieuw of gewijzigd) plus wat de app won. */
const count = (n: number, rows: Array<{ inserted: boolean }>, app = 0, weg = 0): Counts => {
  const nieuw = rows.filter((r) => r.inserted).length;
  return {
    nieuw,
    bijgewerkt: rows.length - nieuw,
    ongewijzigd: n - rows.length - app - weg,
    inAppGewijzigd: app,
    inAppVerwijderd: weg,
  };
};
const ZERO: Counts = { nieuw: 0, bijgewerkt: 0, ongewijzigd: 0, inAppGewijzigd: 0, inAppVerwijderd: 0 };
async function chunked<T, R>(rows: T[], fn: (part: T[]) => Promise<R[]>, size = 200): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < rows.length; i += size) out.push(...(await fn(rows.slice(i, i + size))));
  return out;
}

type KeyTable = (typeof importKeys.$inferInsert)['tabel'];
/** Sleutels die een eerdere import voor deze collega al schreef (import_keys, RLS). */
async function seenKeys(tx: Tx, tabel: KeyTable, keys: string[]) {
  if (!keys.length) return new Set<string>();
  const rows = await chunked(keys, (part) =>
    tx
      .select({ k: importKeys.sleutel })
      .from(importKeys)
      .where(and(eq(importKeys.tabel, tabel), inArray(importKeys.sleutel, part))),
  );
  return new Set(rows.map((r) => r.k));
}
async function markKeys(tx: Tx, userId: string, tabel: KeyTable, keys: string[]) {
  await chunked(keys, async (part) => {
    await tx
      .insert(importKeys)
      .values(part.map((sleutel) => ({ userId, tabel, sleutel })))
      .onConflictDoNothing();
    return [];
  });
}

class Rollback extends Error {
  constructor(readonly value: unknown) {
    super('dry-run');
  }
}
async function maybeRollback<T>(
  dryRun: boolean,
  run: (fn: (tx: Tx) => Promise<T>) => Promise<T>,
  fn: (tx: Tx) => Promise<T>,
) {
  if (!dryRun) return run(fn);
  try {
    await run(async (tx) => {
      throw new Rollback(await fn(tx));
    });
  } catch (e) {
    if (e instanceof Rollback) return e.value as T;
    throw e;
  }
  throw new Error('dry-run: onverwacht geen terugdraai');
}

const TRACKER_COLS = [
  'stroom',
  'wat',
  'aan',
  'org',
  'status',
  'deadline',
  'planDate',
  'backlog',
  'moved',
  'reminder',
  'naar',
  'overgezet',
  'gtask',
  'srcKey',
  'bron',
  'citaat',
  'bewijs',
  'created',
  'closedAt',
  'extra',
];
const DOEL_COLS = [
  'soort',
  'week',
  'wat',
  'deadline',
  'status',
  'health',
  'outcome',
  'checks',
  'closedAt',
  'bron',
  'extra',
];
const STATE_COLS = ['read', 'readAt', 'processed', 'skipPrep', 'answeredBy', 'planDate', 'backlog', 'moved', 'extra'];
const BRIEF_COLS = ['title', 'sections', 'session', 'createdAt'];

/**
 * tracker_items en weekdoelen: rijen met een legacy_id uit de export. De app wint:
 * - in de app gewijzigd sinds de vorige import (updated_at > imported_at; een trigger zet updated_at): niet bijwerken;
 * - na een eerdere import in de app verwijderd (sleutel in import_keys, rij weg): niet opnieuw aanmaken;
 * - anders: nieuw, of bijwerken als de export echt verschilt (imported_at = updated_at = nu).
 */
async function upsertLegacy(
  tx: Tx,
  userId: string,
  tabel: 'tracker_items' | 'weekdoelen',
  rows: Array<TrackerInsert | WeekdoelInsert>,
  cols: string[],
): Promise<{ counts: Counts; na: number }> {
  const table = (tabel === 'tracker_items' ? trackerItems : weekdoelen) as typeof trackerItems;
  const ids = rows.map((r) => r.legacyId!);
  const existing = await chunked(ids, (part) =>
    tx
      .select({
        id: table.legacyId,
        app: sql<boolean>`(${table.importedAt} is null or ${table.updatedAt} > ${table.importedAt})`,
      })
      .from(table)
      .where(inArray(table.legacyId, part)),
  );
  const have = new Map(existing.map((e) => [e.id!, e.app]));
  const seen = await seenKeys(tx, tabel, ids);
  const weg = rows.filter((r) => !have.has(r.legacyId!) && seen.has(r.legacyId!)).length;
  const todo = rows.filter((r) => have.has(r.legacyId!) || !seen.has(r.legacyId!));
  const app = rows.filter((r) => have.get(r.legacyId!) === true).length;
  const ex = excluded(table, cols);
  const returned = await chunked(todo, (part) =>
    tx
      .insert(table)
      .values(part.map((r) => ({ ...(r as TrackerInsert), userId, importedAt: sql`now()`, updatedAt: sql`now()` })))
      .onConflictDoUpdate({
        target: [table.userId, table.legacyId],
        // updated_at zet de trigger (gelijk aan imported_at als de import schrijft).
        set: { ...ex.set, importedAt: sql`now()` },
        setWhere: sql`${table.importedAt} is not null and ${table.updatedAt} <= ${table.importedAt} and ${ex.changed}`,
      })
      .returning({ inserted }),
  );
  await markKeys(tx, userId, tabel, ids);
  const [{ n }] = (await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(table)
    .where(ids.length ? inArray(table.legacyId, ids) : sql`false`)) as [{ n: number }];
  return { counts: count(rows.length, returned, app, weg), na: n };
}

/**
 * Schrijf een plan voor één collega (RLS, als hz_app) en de contextindex (als hz_indexer, via
 * context_index_upsert). `indexDb`: verbinding van createIndexerDb(); standaard `db` (lokaal mag de migratierol
 * hz_indexer worden, de app-login niet).
 */
export async function applyImport(
  db: Db,
  user: { id: string; email: string },
  plan: ImportPlan,
  opts: { dryRun?: boolean; context?: boolean; indexDb?: Db; contextOvergeslagen?: string } = {},
): Promise<ImportReport> {
  const dryRun = !!opts.dryRun;
  const userId = user.id;
  const res = {} as Record<ImportTable, TableResult>;
  const finish = (t: ImportTable, verwacht: number, c: Counts, na: number) =>
    (res[t] = {
      verwacht,
      ...c,
      na,
      klopt:
        na === verwacht - c.inAppVerwijderd &&
        c.ongewijzigd >= 0 &&
        c.nieuw + c.bijgewerkt + c.ongewijzigd + c.inAppGewijzigd + c.inAppVerwijderd === verwacht,
    });
  const doContext = opts.context !== false;
  if (doContext && plan.contextIndex.length && !(await canIndex(opts.indexDb ?? db)))
    throw new Error(
      'contextindex: deze login mag niet in de index schrijven (geen lid van hz_indexer). Geef HZ_INDEX_DATABASE_URL ' +
        '(sql/indexer-login.sql) of importeer zonder context (--zonder-context).',
    );

  await maybeRollback(
    dryRun,
    (fn) => withUser(db, userId, fn),
    async (tx) => {
      {
        const r = await upsertLegacy(tx, userId, 'tracker_items', plan.tracker, TRACKER_COLS);
        finish('tracker_items', plan.tracker.length, r.counts, r.na);
      }
      {
        const r = await upsertLegacy(tx, userId, 'weekdoelen', plan.weekdoelen, DOEL_COLS);
        finish('weekdoelen', plan.weekdoelen.length, r.counts, r.na);
      }
      // item_state: de nieuwste wint (updated_at), en alleen als er echt iets verschilt
      {
        const keys = plan.itemState.map((r) => r.itemKey);
        const cur = new Map(
          (
            await chunked(keys, (part) =>
              tx
                .select({ k: itemState.itemKey, at: itemState.updatedAt })
                .from(itemState)
                .where(inArray(itemState.itemKey, part)),
            )
          ).map((r) => [r.k, r.at]),
        );
        const app = plan.itemState.filter((r) => {
          const at = cur.get(r.itemKey);
          return at && r.updatedAt instanceof Date && at > r.updatedAt;
        }).length;
        const ex = excluded(itemState, [...STATE_COLS, 'updatedAt']);
        const rows = await chunked(plan.itemState, (part) =>
          tx
            .insert(itemState)
            .values(part.map((r) => ({ ...r, userId })))
            .onConflictDoUpdate({
              target: [itemState.userId, itemState.itemKey],
              set: ex.set,
              setWhere: sql`${itemState.updatedAt} <= excluded.updated_at and ${excluded(itemState, STATE_COLS).changed}`,
            })
            .returning({ inserted }),
        );
        const [{ n }] = (await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(itemState)
          .where(keys.length ? inArray(itemState.itemKey, keys) : sql`false`)) as [{ n: number }];
        finish('item_state', plan.itemState.length, count(plan.itemState.length, rows, app), n);
      }
      // pins: sleutel is de zoekopdracht; een in de app weggehaalde pin komt niet terug
      {
        const qs = plan.pins.map((p) => p.q!);
        const have = new Set(
          qs.length
            ? (
                await tx
                  .select({ q: pins.q })
                  .from(pins)
                  .where(and(eq(pins.kind, 'search'), inArray(pins.q, qs)))
              ).map((r) => r.q)
            : [],
        );
        const seen = await seenKeys(tx, 'pins', qs);
        const fresh = plan.pins.filter((p) => !have.has(p.q!) && !seen.has(p.q!));
        const weg = plan.pins.filter((p) => !have.has(p.q!) && seen.has(p.q!)).length;
        if (fresh.length) {
          const [{ n: base }] = (await tx.select({ n: sql<number>`count(*)::int` }).from(pins)) as [{ n: number }];
          await tx.insert(pins).values(fresh.map((p, i) => ({ ...p, userId, position: base + i })));
        }
        await markKeys(tx, userId, 'pins', qs);
        const [{ n }] = (await tx
          .select({ n: sql<number>`count(distinct ${pins.q})::int` })
          .from(pins)
          .where(qs.length ? and(eq(pins.kind, 'search'), inArray(pins.q, qs)) : sql`false`)) as [{ n: number }];
        finish(
          'pins',
          plan.pins.length,
          { ...ZERO, nieuw: fresh.length, ongewijzigd: plan.pins.length - fresh.length - weg, inAppVerwijderd: weg },
          n,
        );
      }
      // briefings: één per dag; een nieuwere briefing in de app (routine, MCP) wint, een verwijderde komt niet terug
      {
        const dates = plan.briefings.map((r) => r.date);
        const cur = new Map(
          (dates.length
            ? await tx
                .select({ d: briefings.date, at: briefings.createdAt })
                .from(briefings)
                .where(inArray(briefings.date, dates))
            : []
          ).map((r) => [r.d, r.at]),
        );
        const seen = await seenKeys(tx, 'briefings', dates);
        const todo = plan.briefings.filter((r) => cur.has(r.date) || !seen.has(r.date));
        const weg = plan.briefings.length - todo.length;
        const app = plan.briefings.filter((r) => {
          const at = cur.get(r.date);
          return at && r.createdAt instanceof Date && at > r.createdAt;
        }).length;
        const ex = excluded(briefings, BRIEF_COLS);
        const rows = await chunked(todo, (part) =>
          tx
            .insert(briefings)
            .values(part.map((r) => ({ ...r, userId })))
            .onConflictDoUpdate({
              target: [briefings.userId, briefings.date],
              set: ex.set,
              setWhere: sql`${briefings.createdAt} <= excluded.created_at and ${ex.changed}`,
            })
            .returning({ inserted }),
        );
        await markKeys(tx, userId, 'briefings', dates);
        const [{ n }] = (await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(briefings)
          .where(dates.length ? inArray(briefings.date, dates) : sql`false`)) as [{ n: number }];
        finish('briefings', plan.briefings.length, count(plan.briefings.length, rows, app, weg), n);
      }
      return null;
    },
  );

  if (!doContext) {
    finish('context_index', 0, ZERO, 0);
  } else {
    await maybeRollback(
      dryRun,
      (fn) => withIndexer(opts.indexDb ?? db, fn),
      async (tx) => {
        const rows = await chunked(plan.contextIndex, (part) => indexUpsertTx(tx, part));
        const ids = plan.contextIndex.map((r) => r.id);
        const [{ n }] = (await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(contextIndex)
          .where(ids.length ? inArray(contextIndex.id, ids) : sql`false`)) as [{ n: number }];
        finish('context_index', plan.contextIndex.length, count(plan.contextIndex.length, rows), n);
        return null;
      },
    );
  }

  const CONTEXT_COLS = new Set(['context_partners', 'context_acties', 'context_status']);
  const verantwoord: ImportReport['verantwoord'] = {};
  for (const [c, docs] of Object.entries(plan.voor)) {
    if (!doContext && CONTEXT_COLS.has(c)) {
      // Niet geschreven: alles telt als overgeslagen (één regel in de waarschuwingen, niet per doc).
      verantwoord[c] = { docs, gebruikt: 0, overgeslagen: docs, klopt: true };
      continue;
    }
    const gebruikt = plan.gebruikt[c] ?? 0;
    const overgeslagen = plan.overgeslagen.filter((s) => s.collectie === c).length;
    verantwoord[c] = { docs, gebruikt, overgeslagen, klopt: docs === gebruikt + overgeslagen };
  }
  const waarschuwingen = [...plan.waarschuwingen];
  const ctxSkip = doContext
    ? undefined
    : (opts.contextOvergeslagen ?? 'contextindex overgeslagen (--zonder-context); de indexjob van de contextlaag vult hem');
  if (ctxSkip && Object.keys(plan.voor).some((c) => CONTEXT_COLS.has(c))) waarschuwingen.push(ctxSkip);
  const klopt = Object.values(res).every((r) => r.klopt) && Object.values(verantwoord).every((v) => v.klopt);
  return {
    gebruiker: user,
    dryRun,
    voor: plan.voor,
    verantwoord,
    tabellen: res,
    overgeslagen: plan.overgeslagen,
    waarschuwingen,
    context: {
      commit: plan.status?.commit_context || null,
      geexporteerd: plan.status?.geexporteerd || null,
      ...(ctxSkip ? { overgeslagen: ctxSkip } : {}),
    },
    klopt,
  };
}

/** Lees de export, zoek of maak de collega aan (SECURITY DEFINER-functie) en importeer. */
export async function importPrototype(
  db: Db,
  opts: {
    email: string;
    name?: string;
    exportPath?: string;
    collections?: ExportCollections;
    dryRun?: boolean;
    context?: boolean;
    /** Verbinding als hz_indexer voor de contextindex (createIndexerDb); standaard db. */
    indexDb?: Db;
    /** Waarom de context is overgeslagen (voor het verslag), als context false is. */
    contextOvergeslagen?: string;
  },
): Promise<ImportReport> {
  const cols = opts.collections ?? (opts.exportPath ? readExport(opts.exportPath) : null);
  if (!cols) throw new Error('import: geef een export (pad of collecties)');
  const plan = planImport(cols);
  if (opts.context !== false && plan.contextIndex.length && !(await canIndex(opts.indexDb ?? db)))
    throw new Error(
      'contextindex: deze login mag niet in de index schrijven (geen lid van hz_indexer). Geef HZ_INDEX_DATABASE_URL ' +
        '(sql/indexer-login.sql) of importeer zonder context (--zonder-context).',
    );
  const u = await upsertUser(db, opts.email, opts.name ?? '');
  return applyImport(db, { id: u.id, email: u.email }, plan, {
    dryRun: opts.dryRun,
    context: opts.context,
    indexDb: opts.indexDb,
    contextOvergeslagen: opts.contextOvergeslagen,
  });
}

/** Leesbaar verslag voor de terminal (Nederlands, zonder inhoud uit de export). */
export function formatReport(r: ImportReport): string {
  const L: string[] = [];
  L.push(`Import prototype -> ${r.gebruiker.email}${r.dryRun ? ' (proefdraai, niets opgeslagen)' : ''}`);
  if (r.context.commit || r.context.geexporteerd)
    L.push(`Contextlaag: commit ${r.context.commit ?? '?'}, geëxporteerd ${r.context.geexporteerd ?? '?'}`);
  if (r.context.overgeslagen) L.push(`Contextlaag: ${r.context.overgeslagen}`);
  L.push('', 'Export (voor)                docs  gebruikt  overgeslagen');
  for (const [c, v] of Object.entries(r.verantwoord))
    L.push(
      `  ${c.padEnd(26)} ${String(v.docs).padStart(5)} ${String(v.gebruikt).padStart(9)} ${String(v.overgeslagen).padStart(13)}${v.klopt ? '' : '  KLOPT NIET'}`,
    );
  L.push(
    '',
    '                                                               overgeslagen:',
    'Database (na)            verwacht  nieuw  bijgewerkt  ongewijzigd  in app gewijzigd  in app verwijderd    na',
  );
  for (const [t, v] of Object.entries(r.tabellen))
    L.push(
      `  ${t.padEnd(22)} ${String(v.verwacht).padStart(9)} ${String(v.nieuw).padStart(6)} ${String(v.bijgewerkt).padStart(11)} ${String(v.ongewijzigd).padStart(12)} ${String(v.inAppGewijzigd).padStart(17)} ${String(v.inAppVerwijderd).padStart(18)} ${String(v.na).padStart(5)}${v.klopt ? '' : '  KLOPT NIET'}`,
    );
  const appWint = Object.values(r.tabellen).reduce((s, v) => s + v.inAppGewijzigd + v.inAppVerwijderd, 0);
  if (appWint)
    L.push(
      '',
      `De app wint: ${appWint} rij(en) zijn na de vorige import in de app gewijzigd of verwijderd en bleven zoals in de app.`,
    );
  if (r.overgeslagen.length) {
    L.push('', `Overgeslagen (${r.overgeslagen.length}):`);
    for (const s of r.overgeslagen.slice(0, 50)) L.push(`  ${s.collectie}/${s.id}: ${s.reden}`);
    if (r.overgeslagen.length > 50) L.push(`  … en ${r.overgeslagen.length - 50} meer`);
  }
  if (r.waarschuwingen.length) {
    L.push('', `Waarschuwingen (${r.waarschuwingen.length}):`);
    for (const w of r.waarschuwingen.slice(0, 50)) L.push(`  ${w}`);
  }
  L.push('', r.klopt ? 'Aantallen kloppen.' : 'AANTALLEN KLOPPEN NIET: zie hierboven.');
  return L.join('\n');
}
