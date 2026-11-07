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
 * Velden: VELDEN zegt per veld dat het prototype schrijft waar het heen gaat (kolom of extra). Wat niet volledig in
 * een kolom past, blijft in extra (met een waarschuwing als een waarde onleesbaar was); niets gaat stil verloren.
 * De contracttest (test/prototype-contract.test.ts) leest de schrijfpaden uit het prototype zelf en gebruikt een
 * export die tools/bar/record-export.mjs uit het prototype opneemt. Bijzonder:
 * - gtask: planCommit() bewaart `{id, tasklist}`, de knop "In Google Taken" `'gtask:<id>'`; de id gaat naar
 *   tracker_items.gtask, tasklist naar extra.gtask. Zo'n item is verborgen zoals in het prototype (commitVisible);
 * - handledBy (checkReactions: een ander reageerde al) gaat naar item_state.answered_by; answeredBy is een alias.
 *
 * Contextindex: bij opnieuw importeren gaan rijen van partners, meetings en acties die niet meer in de export staan
 * eruit (context_index_delete per verdwenen bestand, context_index_delete_id per verdwenen actie), alleen binnen de
 * soorten die de export beschrijft en alleen op paden die de import zelf maakt. Zou meer dan de helft verdwijnen,
 * dan niet (tenzij opruimenForceren).
 *
 * Alles per collega loopt in één transactie als hz_app met withUser (RLS); de contextindex in één transactie als
 * hz_indexer via context_index_upsert (migratie 0009). Met dryRun wordt alles uitgevoerd en daarna teruggedraaid.
 *
 * Logins (sinds 0011): `db` moet namens een collega kunnen werken (lid van hz_worker: de worker-login, lokaal de
 * migratierol); de api-login kan dat niet. De collega opzoeken of aanmaken gaat via `authDb` (hz_auth, de auth-login).
 * Proefdraai: de collega wordt alleen opgezocht, nooit aangemaakt. Bestaat hij nog niet, dan is alles voor hem nieuw:
 * de per-collega-tabellen worden dan uit het plan berekend (niet in de database geprobeerd), de contextindex wel echt
 * doorgerekend en teruggedraaid.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { and, eq, getTableName, inArray, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { ContextStatus, Partner, PartnerActies } from '@hz/shared';
import { canActAsUser, canIndex, withIndexer, withUser, type Db, type Tx } from './client';
import { findUserByEmail, indexUpsertTx, upsertUser } from './repo';
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
  /**
   * Welke soorten indexrijen de export volledig beschrijft: partner/project/meeting als er geldige partners in staan,
   * actie als er geldige actielijsten in staan. Alleen binnen deze soorten ruimt een nieuwe import rijen op van
   * bestanden of acties die niet meer in de export staan.
   */
  contextScope: ContextKind[];
}
type ContextKind = 'partner' | 'project' | 'meeting' | 'actie';

const STROOM_TRACKER = ['mijn', 'voornemen', 'aan_mij', 'bespreken'] as const;
const STROOM_DOEL = ['weekdoel', 'roadmap'] as const;
const STATUS = ['open', 'waarschijnlijk_klaar', 'klaar', 'te_laat', 'overgedragen', 'losgelaten'] as const;
const HEALTH = ['groen', 'oranje', 'rood', 'af'] as const;
const OUTCOME = ['gehaald', 'meegenomen', 'doorgeschoven', 'losgelaten'] as const;

const str = (x: unknown) => (typeof x === 'string' ? x : x == null ? '' : String(x));
const optStr = (x: unknown) => (typeof x === 'string' && x.trim() ? x : null);
const oneOf = <T extends string>(list: readonly T[], x: unknown): T | null =>
  typeof x === 'string' && (list as readonly string[]).includes(x) ? (x as T) : null;
const bool = (x: unknown) => (typeof x === 'boolean' ? x : null);
const int = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : null);

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

/**
 * Bron van een toezegging, zonder verlies: het prototype schrijft `{label, url}` of (vanuit Inhalen, srcOf())
 * `{key, label, url}`; een plansessie kan er meer velden in zetten. Alles blijft staan; label is altijd tekst.
 */
function bron(x: unknown): ({ label: string; url?: string } & Record<string, unknown>) | null {
  if (!isObj(x)) return typeof x === 'string' && x.trim() ? { label: x } : null;
  const label = str(x.label);
  const url = optStr(x.url);
  if (!label && !url && !optStr(x.key)) return null;
  // url null of leeg (srcOf() zonder link) zegt niets en valt weg; de rest blijft staan
  const { label: _l, url: _u, ...rest } = x;
  return { label: label || 'Bron', ...(url ? { url } : {}), ...rest };
}

/** Een gevuld veld: niet leeg, niet null/undefined/false. Zulke waarden mogen nooit stil verdwijnen. */
/** JSON met gesorteerde sleutels: vergelijken zonder dat de volgorde van velden telt. */
const canonical = (x: unknown): string =>
  Array.isArray(x)
    ? `[${x.map(canonical).join(',')}]`
    : isObj(x)
      ? `{${Object.keys(x)
          .filter((k) => x[k] !== undefined)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(x[k])}`)
          .join(',')}}`
      : JSON.stringify(x);
const filled = (v: unknown) =>
  v !== undefined &&
  v !== null &&
  v !== false &&
  !(typeof v === 'string' && !v.trim()) &&
  !(Array.isArray(v) && v.length === 0);

/**
 * Leest de velden van één doc. Elk veld dat niet volledig in een kolom terechtkomt, blijft in `extra`:
 * - een veld zonder kolom (onbekend, of bewust in extra zoals bewijsregel) gaat als geheel naar extra;
 * - een veld met kolom waarvan de waarde niet te lezen is (datum "volgende week", onbekende status, gtask zonder id)
 *   gaat met de oorspronkelijke waarde naar extra, met een waarschuwing.
 * Zo gaat niets wat het prototype schreef stil verloren (contracttest: test/prototype-contract.test.ts).
 */
class Velden {
  private used = new Set<string>();
  private kept: Record<string, unknown> = {};
  constructor(
    private d: Record<string, unknown>,
    private where: string,
    private warn: (w: string) => void,
  ) {}
  /** Lees veld k met f. Gevuld maar onleesbaar: oorspronkelijke waarde naar extra plus waarschuwing. */
  get<T>(k: string, f: (x: unknown) => T | null | undefined): T | null {
    this.used.add(k);
    const v = this.d[k];
    const out = f(v);
    if ((out === null || out === undefined) && filled(v)) {
      this.kept[k] = v;
      this.warn(`${this.where}: veld ${k} past niet in zijn kolom, bewaard in extra`);
    }
    return out ?? null;
  }
  /** Veld k gaat (ook) als `value` naar extra, bijvoorbeeld het deel van een object zonder eigen kolom. */
  keep(k: string, value: unknown) {
    this.used.add(k);
    this.kept[k] = value;
  }
  /** Veld k telt als gebruikt (de waarde zit volledig in een kolom). */
  use(...ks: string[]) {
    for (const k of ks) this.used.add(k);
  }
  extra(): Record<string, unknown> {
    const rest = Object.fromEntries(Object.entries(this.d).filter(([k]) => !this.used.has(k)));
    return { ...rest, ...this.kept };
  }
}

/**
 * Gekoppelde Google Taak. Het prototype schrijft twee vormen:
 * - planCommit(): `patch.gtask = await gtaskAdd(...)` = `{id, tasklist}` (en leest `c.gtask?.id`);
 * - de knop "In Google Taken" (c-gtask): `taskFromCommit()` geeft de tekst `'gtask:' + id`.
 * Beide geven de taak-id; de rest van het object (tasklist) gaat naar extra.gtask. Is het veld gevuld maar zonder
 * id, dan blijft de hele waarde in extra.gtask: het prototype verbergt zo'n item toch (commitVisible kijkt naar
 * c.gtask), en trackerItemVisible() ook.
 */
export function gtaskId(x: unknown): string | null {
  if (typeof x === 'string')
    return (
      x
        .trim()
        .replace(/^gtask:/, '')
        .trim() || null
    );
  if (typeof x === 'number' && Number.isFinite(x)) return String(x);
  if (isObj(x)) return typeof x.id === 'string' || typeof x.id === 'number' ? gtaskId(x.id) : null;
  return null;
}

/**
 * Waar elk veld dat het prototype schrijft terechtkomt: een kolom van de rij, of 'extra'. Bron van de lijst:
 * commitAdd() (het nieuwe doc), elke commitSave(id, patch) en elke setState(key, patch) in
 * workspace-prototype/index.html. De contracttest leest die schrijfpaden uit het prototype en eist dat elk veld hier
 * staat, en dat de waarde na planImport in die kolom of in extra zit.
 */
export const VELDEN = {
  /** commitments met stroom mijn, voornemen, aan_mij of bespreken -> tracker_items */
  tracker: {
    wat: 'wat',
    stroom: 'stroom',
    aan: 'aan',
    org: 'org',
    status: 'status',
    deadline: 'deadline',
    plan: 'planDate',
    backlog: 'backlog',
    moved: 'moved',
    reminder: 'reminder',
    naar: 'naar',
    overgezet: 'overgezet',
    gtask: 'gtask',
    src: 'srcKey',
    bron: 'bron',
    citaat: 'citaat',
    bewijs: 'bewijs',
    created: 'created',
    createdAt: 'createdAt',
    closedAt: 'closedAt',
    // Geen eigen kolom: in extra (velden van een doorgeschoven weekdoel, bewijsregel voor de bewijscheck)
    bewijsregel: 'extra',
    week: 'extra',
    health: 'extra',
    outcome: 'extra',
    outcomeNote: 'extra',
    checks: 'extra',
    lastCheck: 'extra',
  },
  /** commitments met stroom weekdoel of roadmap (en collectie weekdoelen) -> weekdoelen */
  weekdoel: {
    wat: 'wat',
    stroom: 'soort',
    week: 'week',
    deadline: 'deadline',
    status: 'status',
    health: 'health',
    outcome: 'outcome',
    checks: 'checks',
    closedAt: 'closedAt',
    bron: 'bron',
    createdAt: 'createdAt',
    // Geen eigen kolom: in extra
    created: 'extra',
    lastCheck: 'extra',
    outcomeNote: 'extra',
    org: 'extra',
    aan: 'extra',
    src: 'extra',
    plan: 'extra',
    backlog: 'extra',
    moved: 'extra',
    reminder: 'extra',
    naar: 'extra',
    overgezet: 'extra',
    gtask: 'extra',
    citaat: 'extra',
    bewijs: 'extra',
    bewijsregel: 'extra',
  },
  /** itemstate -> item_state (behalve doc _pins: list -> pins) */
  itemstate: {
    read: 'read',
    at: 'updatedAt',
    processed: 'processed',
    skipPrep: 'skipPrep',
    handledBy: 'answeredBy',
    answeredBy: 'answeredBy',
    plan: 'planDate',
    backlog: 'backlog',
    moved: 'moved',
    list: 'pins',
    // Geen eigen kolom: in extra (recap-sessie, reactie, plansessie, aangehouden, taken.md, aansporingen)
    recapSession: 'extra',
    reacted: 'extra',
    added: 'extra',
    done: 'extra',
    skip: 'extra',
    skipped: 'extra',
    until: 'extra',
    keuze: 'extra',
    datum: 'extra',
    bron: 'extra',
    tekst: 'extra',
    overgezet: 'extra',
  },
} as const;

const BRIEF_KNOWN = ['date', 'title', 'sections', 'session', 'createdAt'];

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
    contextScope: [],
  };
  const use = (c: string) => (plan.gebruikt[c] = (plan.gebruikt[c] ?? 0) + 1);
  const skip = (collectie: string, id: string, reden: string) => plan.overgeslagen.push({ collectie, id, reden });
  const warn = (w: string) => plan.waarschuwingen.push(w);
  for (const [c, docs] of Object.entries(cols)) plan.voor[c] = docs.length;

  // Toezeggingen en doelen
  const doel = (c: string, legacyId: string, d: Record<string, unknown>, soort: 'weekdoel' | 'roadmap') => {
    const v = new Velden(d, `${c}/${legacyId.replace(/^weekdoelen:/, '')}`, warn);
    v.use('wat', 'stroom', 'soort');
    const status = v.get('status', (x) => oneOf(STATUS, x ?? 'open'));
    const health = v.get('health', (x) => oneOf(HEALTH, x));
    const bad: unknown[] = [];
    const checks = v.get('checks', (x) => {
      if (!Array.isArray(x)) return null;
      return x.flatMap((ch) => {
        const dd = isObj(ch) ? isoDate(ch.d) : null;
        const h = isObj(ch) ? oneOf(HEALTH, ch.h) : null;
        if (!dd || !h) {
          bad.push(ch);
          return [];
        }
        const note = isObj(ch) ? optStr(ch.note) : null;
        return [{ d: dd, h, ...(note ? { note } : {}) }];
      });
    });
    if (bad.length) {
      v.keep('checksOngeldig', bad);
      warn(`${c}/${legacyId}: ${bad.length} check(s) met onbekende datum of gezondheid, bewaard in extra`);
    }
    const createdAt = v.get('createdAt', instant);
    // created (dag) zit in createdAt als er geen createdAt is; anders blijft hij in extra
    const created = createdAt ? null : instant(d.created);
    if (created) v.use('created');
    plan.weekdoelen.push({
      legacyId,
      soort,
      week: v.get('week', isoWeek),
      wat: str(d.wat).trim(),
      deadline: v.get('deadline', isoDate),
      status: status ?? 'open',
      health,
      outcome: v.get('outcome', (x) => oneOf(OUTCOME, x)),
      checks: checks ?? [],
      closedAt: v.get('closedAt', isoDate),
      bron: v.get('bron', bron),
      extra: v.extra(),
      createdAt: createdAt ?? created ?? new Date(0),
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
    const v = new Velden(d, `commitments/${id}`, warn);
    v.use('wat', 'stroom');
    const status = v.get('status', (x) => oneOf(STATUS, x ?? 'open'));
    const gtask = v.get('gtask', gtaskId);
    if (gtask && isObj(d.gtask)) {
      const { id: _id, ...rest } = d.gtask;
      if (Object.keys(rest).length) v.keep('gtask', rest);
    }
    const srcKey = v.get('src', (x) => (typeof x === 'string' ? optStr(x) : isObj(x) ? optStr(x.key) : null));
    if (srcKey && isObj(d.src)) {
      const { key: _k, ...rest } = d.src;
      if (Object.keys(rest).length) v.keep('src', rest);
    }
    const createdAt = v.get('createdAt', instant);
    const created = v.get('created', isoDate);
    plan.tracker.push({
      legacyId: id,
      stroom: t,
      wat: str(d.wat).trim(),
      aan: v.get('aan', optStr) ?? '',
      org: v.get('org', optStr) ?? '',
      status: status ?? 'open',
      deadline: v.get('deadline', isoDate),
      planDate: v.get('plan', isoDate),
      backlog: v.get('backlog', bool) ?? false,
      moved: v.get('moved', int) ?? 0,
      reminder: v.get('reminder', isoDate),
      naar: v.get('naar', optStr),
      overgezet: v.get('overgezet', bool) ?? false,
      gtask,
      srcKey,
      bron: v.get('bron', bron),
      citaat: v.get('citaat', optStr) ?? '',
      bewijs: v.get('bewijs', optStr),
      created: created ?? (createdAt ? createdAt.toISOString().slice(0, 10) : null),
      closedAt: v.get('closedAt', isoDate),
      extra: v.extra(),
      createdAt: createdAt ?? instant(created) ?? new Date(0),
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
        if (!q) return void warn(`itemstate/_pins[${i}]: geen zoekopdracht, overgeslagen`);
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
    const v = new Velden(d, `itemstate/${id}`, warn);
    const at = v.get('at', instant);
    const read = v.get('read', bool) ?? false;
    // Het prototype schrijft handledBy (checkReactions: iemand anders reageerde al); answeredBy is een alias.
    const handledBy = v.get('handledBy', optStr);
    let answeredBy = handledBy;
    if (handledBy) {
      if (filled(d.answeredBy) && d.answeredBy !== handledBy) v.keep('answeredBy', d.answeredBy);
      else v.use('answeredBy');
    } else answeredBy = v.get('answeredBy', optStr);
    states.set(id, {
      itemKey: id,
      read,
      readAt: read ? at : null,
      processed: v.get('processed', bool) ?? false,
      skipPrep: v.get('skipPrep', bool) ?? false,
      answeredBy,
      planDate: v.get('plan', isoDate),
      backlog: v.get('backlog', bool) ?? false,
      moved: v.get('moved', int) ?? 0,
      extra: v.extra(),
      updatedAt: at ?? new Date(0),
    });
    use('itemstate');
  }
  for (const { id, data: d } of cols.processed ?? []) {
    const cur = states.get(id);
    const at = instant(d.at);
    // Andere velden dan `at` in een processed-doc: naar extra (zonder iets van itemstate te overschrijven)
    const rest = Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'at'));
    if (cur) {
      cur.processed = true;
      if (at && cur.updatedAt instanceof Date && at > cur.updatedAt) cur.updatedAt = at;
      cur.extra = { ...rest, ...(cur.extra as Record<string, unknown>) };
    } else {
      states.set(id, { itemKey: id, processed: true, extra: rest, updatedAt: at ?? new Date(0) });
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
    // Velden zonder kolom gaan naar extra (0012); een sectie of item die niet volledig in de vaste vorm past, bewaart
    // het origineel in extra.sections. Niets gaat stil verloren.
    const extra: Record<string, unknown> = {};
    const unknown = Object.keys(d).filter((k) => !BRIEF_KNOWN.includes(k) && d[k] !== undefined);
    for (const k of unknown) extra[k] = d[k];
    if (unknown.length) warn(`briefings/${id}: veld(en) ${unknown.join(', ')} hebben geen kolom, bewaard in extra`);
    if (d.sections !== undefined && canonical(d.sections) !== canonical(sections)) {
      extra.sections = d.sections;
      warn(`briefings/${id}: sections past niet volledig in zijn kolom, origineel bewaard in extra`);
    }
    const created = instant(d.createdAt);
    if (filled(d.createdAt) && !created) {
      extra.createdAt = d.createdAt;
      warn(`briefings/${id}: createdAt onleesbaar, bewaard in extra`);
    }
    if (filled(d.title) && typeof d.title !== 'string') extra.title = d.title;
    if (filled(d.session) && typeof d.session !== 'string') extra.session = d.session;
    const row: BriefingInsert = {
      date,
      title: str(d.title) || 'Ochtendbriefing',
      sections,
      session: optStr(d.session),
      extra,
      createdAt: created ?? new Date(`${date}T07:00:00Z`),
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
  if (soortOf.size) plan.contextScope.push('partner', 'project', 'meeting');
  if (plan.contextIndex.some((r) => r.kind === 'actie') || (plan.gebruikt.context_acties ?? 0) > 0)
    plan.contextScope.push('actie');
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
  /** Alleen context_index: rijen weggehaald omdat hun bestand of actie niet meer in de export staat. */
  verwijderd?: number;
}

export interface ImportReport {
  /** id null: proefdraai voor een collega die nog niet bestaat (de per-collega-tabellen zijn berekend). */
  gebruiker: { id: string | null; email: string };
  dryRun: boolean;
  /** Aantal docs per collectie in de export. */
  voor: Record<string, number>;
  /** Per collectie: docs = gebruikt + overgeslagen. */
  verantwoord: Record<string, { docs: number; gebruikt: number; overgeslagen: number; klopt: boolean }>;
  tabellen: Record<ImportTable, TableResult>;
  overgeslagen: Skip[];
  waarschuwingen: string[];
  /** overgeslagen: waarom de contextindex niet is bijgewerkt (geen indexer-login, of --zonder-context). */
  context: {
    commit: string | null;
    geexporteerd: string | null;
    overgeslagen?: string;
    /** Paden (bestanden) en sleutels (acties) die uit de index zijn gehaald; geen inhoud. */
    opgeruimd?: { paden: string[]; sleutels: string[] };
    /** Waarom er niet is opgeruimd (te veel tegelijk, zie opruimenForceren). */
    nietOpgeruimd?: string;
  };
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

/** De import schrijft namens één collega met app.user_id; dat kan alleen een login die lid is van hz_worker (0011). */
async function assertActAs(db: Db) {
  if (!(await canActAsUser(db)))
    throw new Error(
      'import: deze login kan niet namens een collega schrijven (geen lid van hz_worker). Gebruik de worker-login ' +
        '(sql/worker-login.sql) als DATABASE_URL; de api-login kan dat sinds migratie 0011 niet.',
    );
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
const BRIEF_COLS = ['title', 'sections', 'session', 'extra', 'createdAt'];
/** Kolommen die applyImport schrijft (naast de sleutel), per tabel. De contracttest legt VELDEN hiernaast. */
export const IMPORT_COLUMNS = {
  tracker: [...TRACKER_COLS, 'legacyId', 'createdAt'],
  weekdoel: [...DOEL_COLS, 'legacyId', 'createdAt'],
  itemstate: [...STATE_COLS, 'itemKey', 'updatedAt'],
} as const;

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
  user: { id: string | null; email: string },
  plan: ImportPlan,
  opts: {
    dryRun?: boolean;
    context?: boolean;
    indexDb?: Db;
    contextOvergeslagen?: string;
    /** Ook opruimen als meer dan de helft van de indexrijen in scope zou verdwijnen (standaard: dan niet). */
    opruimenForceren?: boolean;
  } = {},
): Promise<ImportReport> {
  const dryRun = !!opts.dryRun;
  const userId = user.id;
  if (!userId && !dryRun) throw new Error('import: geen collega (alleen een proefdraai mag zonder)');
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

  if (!userId) {
    // Proefdraai voor een collega die nog niet bestaat: geen rijen, geen import_keys, dus alles is nieuw.
    const n = {
      tracker_items: plan.tracker.length,
      weekdoelen: plan.weekdoelen.length,
      item_state: plan.itemState.length,
      pins: plan.pins.length,
      briefings: plan.briefings.length,
    } as const;
    for (const [t, v] of Object.entries(n)) finish(t as ImportTable, v, { ...ZERO, nieuw: v }, v);
  } else {
    await assertActAs(db);
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
  }

  let opgeruimd: { paden: string[]; sleutels: string[] } | undefined;
  let nietOpgeruimd: string | undefined;
  if (!doContext) {
    finish('context_index', 0, ZERO, 0);
  } else {
    await maybeRollback(
      dryRun,
      (fn) => withIndexer(opts.indexDb ?? db, fn),
      async (tx) => {
        const rows = await chunked(plan.contextIndex, (part) => indexUpsertTx(tx, part));
        const ids = plan.contextIndex.map((r) => r.id);
        // Opruimen: bestanden en acties die niet meer in de export staan (alleen binnen contextScope en alleen de
        // paden die deze import zelf maakt). Als hz_indexer via context_index_delete / context_index_delete_id.
        let verwijderd = 0;
        if (plan.contextScope.length) {
          const stale = await staleIndexRows(tx, plan);
          const weg = stale.inScope ? stale.rows / stale.inScope : 0;
          if (stale.rows && stale.inScope >= 10 && weg > 0.5 && !opts.opruimenForceren) {
            nietOpgeruimd =
              `contextindex: ${stale.rows} van ${stale.inScope} rijen zouden verdwijnen; niet opgeruimd. Klopt de ` +
              'export (alle partners en acties)? Dan opnieuw met --opruimen-forceren.';
          } else if (stale.rows) {
            for (const path of stale.paden)
              verwijderd += Number(
                (await tx.execute<{ n: number }>(sql`select context_index_delete(${path}) as n`)).rows[0]?.n ?? 0,
              );
            for (const id of stale.sleutels)
              verwijderd += Number(
                (await tx.execute<{ n: number }>(sql`select context_index_delete_id(${id}) as n`)).rows[0]?.n ?? 0,
              );
            opgeruimd = { paden: stale.paden, sleutels: stale.sleutels };
          }
        }
        const [{ n }] = (await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(contextIndex)
          .where(ids.length ? inArray(contextIndex.id, ids) : sql`false`)) as [{ n: number }];
        finish('context_index', plan.contextIndex.length, count(plan.contextIndex.length, rows), n);
        res.context_index.verwijderd = verwijderd;
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
  if (!userId)
    waarschuwingen.push(
      `${user.email} bestaat nog niet: proefdraai zonder hem aan te maken; zijn tabellen zijn berekend (alles nieuw)`,
    );
  if (nietOpgeruimd) waarschuwingen.push(nietOpgeruimd);
  const ctxSkip = doContext
    ? undefined
    : (opts.contextOvergeslagen ??
      'contextindex overgeslagen (--zonder-context); de indexjob van de contextlaag vult hem');
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
      ...(opgeruimd ? { opgeruimd } : {}),
      ...(nietOpgeruimd ? { nietOpgeruimd } : {}),
    },
    klopt,
  };
}

/** Paden die de import zelf in de index zet (partners/<slug>/… en projecten/<slug>/…). */
const IMPORT_PATH = '^(partners|projecten)/[^/]+/(brief\\.md|acties\\.md|meetings/[^/]+\\.md)$';

/**
 * Indexrijen die niet meer in de export staan, binnen plan.contextScope en alleen op paden die de import zelf maakt:
 * - paden: het hele bestand is weg (partner, project of meeting verdwenen; acties.md van een verdwenen partner);
 * - sleutels: het bestand staat er nog, maar deze rij niet meer (een actie die uit acties.md verdween).
 */
async function staleIndexRows(tx: Tx, plan: ImportPlan) {
  const existing = (
    await tx.execute<{ id: string; path: string }>(
      sql`select id, path from context_index where kind = any(${`{${plan.contextScope.join(',')}}`}::text[]) and path ~ ${IMPORT_PATH}`,
    )
  ).rows;
  const ids = new Set(plan.contextIndex.map((r) => r.id));
  const paths = new Set(plan.contextIndex.map((r) => r.path));
  const paden = [...new Set(existing.filter((r) => !paths.has(r.path)).map((r) => r.path))].sort();
  const sleutels = existing
    .filter((r) => paths.has(r.path) && !ids.has(r.id))
    .map((r) => r.id)
    .sort();
  const rows = existing.filter((r) => !paths.has(r.path) || !ids.has(r.id)).length;
  return { paden, sleutels, rows, inScope: existing.length };
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
    /** Verbinding als hz_auth om de collega op te zoeken of aan te maken (createAuthDb); standaard db. */
    authDb?: Db;
    /** Waarom de context is overgeslagen (voor het verslag), als context false is. */
    contextOvergeslagen?: string;
    /** Opruimen in de contextindex ook als meer dan de helft zou verdwijnen. */
    opruimenForceren?: boolean;
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
  await assertActAs(db);
  const authDb = opts.authDb ?? db;
  // Proefdraai: alleen opzoeken. Echt: opzoeken of aanmaken (auth_upsert_user, alleen toegestane domeinen).
  const u = opts.dryRun
    ? await findUserByEmail(authDb, opts.email)
    : await upsertUser(authDb, opts.email, opts.name ?? '');
  return applyImport(db, { id: u?.id ?? null, email: u?.email ?? opts.email.trim().toLowerCase() }, plan, {
    dryRun: opts.dryRun,
    context: opts.context,
    indexDb: opts.indexDb,
    contextOvergeslagen: opts.contextOvergeslagen,
    opruimenForceren: opts.opruimenForceren,
  });
}

/** Leesbaar verslag voor de terminal (Nederlands, zonder inhoud uit de export). */
export function formatReport(r: ImportReport): string {
  const L: string[] = [];
  L.push(`Import prototype -> ${r.gebruiker.email}${r.dryRun ? ' (proefdraai, niets opgeslagen)' : ''}`);
  if (r.context.commit || r.context.geexporteerd)
    L.push(`Contextlaag: commit ${r.context.commit ?? '?'}, geëxporteerd ${r.context.geexporteerd ?? '?'}`);
  if (r.context.overgeslagen) L.push(`Contextlaag: ${r.context.overgeslagen}`);
  const op = r.context.opgeruimd;
  if (op && (op.paden.length || op.sleutels.length)) {
    L.push(
      `Contextindex opgeruimd: ${r.tabellen.context_index?.verwijderd ?? 0} rij(en) van ${op.paden.length} verdwenen ` +
        `bestand(en) en ${op.sleutels.length} verdwenen actie(s).`,
    );
    for (const x of [...op.paden, ...op.sleutels].slice(0, 20)) L.push(`  weg: ${x}`);
    if (op.paden.length + op.sleutels.length > 20) L.push(`  … en ${op.paden.length + op.sleutels.length - 20} meer`);
  }
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
