/**
 * HZW-021: contract met het prototype. Elk veld dat het prototype in zijn artifact-opslag schrijft, komt bij de import
 * in een kolom of expliciet in `extra` terecht, nooit stil weg.
 *
 * Deze test leest de schrijfpaden uit workspace-prototype/index.html zelf (geen handgemaakte lijst):
 * - de opslag-aanroepen (CAP.db.doc(...).set/update/delete, CAP.db.collection(...).add): alleen commitments en itemstate;
 * - commitAdd(): het object `doc` dat als nieuw document wordt opgeslagen;
 * - elke commitSave(id, patch) en setState(key, patch), ook als patch een variabele is (`const patch = {…}`,
 *   `patch.gtask = …`, `Object.assign(patch, {…})`); setState zet altijd ook `at`.
 * Komt er in het prototype een veld of schrijfpad bij, dan faalt deze test tot VELDEN (src/import.ts) en SAMPLE hier
 * het kennen. Daarna gaat een doc met al die velden door planImport en wordt per veld gecontroleerd waar de waarde zit.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IMPORT_COLUMNS, planImport, readExport, trackerItemVisible, VELDEN } from '../src';

const here = dirname(fileURLToPath(import.meta.url));
const PROTO = process.env.HZ_PROTOTYPE ?? resolve(here, '../../../../workspace-prototype/index.html');

/* ---------- Mini-scanner voor JavaScript: strings, template-literals, commentaar en regex overslaan ---------- */

/** Index van het teken dat `src[open]` (een `{`, `(` of `[`) sluit. */
function matching(src: string, open: number): number {
  const pairs: Record<string, string> = { '{': '}', '(': ')', '[': ']' };
  const stack: string[] = [];
  let i = open;
  let prev = '';
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      i = src.indexOf('\n', i);
      if (i < 0) return -1;
      continue;
    }
    if (c === '/' && n === '*') {
      i = src.indexOf('*/', i) + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
      i++;
      prev = 'x';
      continue;
    }
    if (c === '`') {
      i = skipTemplate(src, i);
      prev = 'x';
      continue;
    }
    if (c === '/' && /[(,=:[!&|?{};]/.test(prev)) {
      // regex-literal
      i++;
      let cls = false;
      while (i < src.length && (src[i] !== '/' || cls)) {
        if (src[i] === '\\') i++;
        else if (src[i] === '[') cls = true;
        else if (src[i] === ']') cls = false;
        i++;
      }
      i++;
      prev = 'x';
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === '}' || c === ')' || c === ']') {
      if (stack.pop() !== c) throw new Error(`scanner: onverwacht ${c} bij ${i}`);
      if (!stack.length) return i;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return -1;
}
function skipTemplate(src: string, start: number): number {
  let i = start + 1;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\\') i += 2;
    else if (c === '`') return i + 1;
    else if (c === '$' && src[i + 1] === '{') i = matching(src, i + 1) + 1;
    else i++;
  }
  return i;
}

/** Splits de inhoud tussen haakjes op komma's op het hoogste niveau. */
function splitTop(body: string): string[] {
  const parts: string[] = [];
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "'" || c === '"' || c === '`' || c === '{' || c === '(' || c === '[') {
      const end =
        c === '`'
          ? skipTemplate(body, i) - 1
          : c === "'" || c === '"'
            ? (() => {
                let j = i + 1;
                while (j < body.length && body[j] !== c) j += body[j] === '\\' ? 2 : 1;
                return j;
              })()
            : matching(body, i);
      cur += body.slice(i, end + 1);
      i = end;
      continue;
    }
    // haakjes en strings zijn hierboven in één keer overgeslagen: een komma hier staat op het hoogste niveau
    if (c === ',') {
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** Sleutels op het hoogste niveau van een object-literal (`{ a: 1, b, ...x }`); spreads komen als `...x`. */
function keysOf(literal: string): string[] {
  return splitTop(literal.trim().slice(1, -1)).map((p) => {
    if (p.startsWith('...')) return p;
    const m = /^(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*(:|$)/.exec(p);
    if (!m) throw new Error(`scanner: geen sleutel in "${p.slice(0, 40)}"`);
    return m[1] ?? m[2] ?? m[3]!;
  });
}

interface Call {
  at: number;
  args: string[];
}
/** Alle aanroepen `name(...)`, niet de definitie (`function name(`). */
function calls(src: string, name: string): Call[] {
  const out: Call[] = [];
  const re = new RegExp(`(?<![\\w$.])${name}\\(`, 'g');
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (/function\s+$/.test(src.slice(Math.max(0, m.index - 20), m.index))) continue;
    const open = m.index + m[0].length - 1;
    const close = matching(src, open);
    out.push({ at: m.index, args: splitTop(src.slice(open + 1, close)) });
  }
  return out;
}

/** Sleutels die een patch-variabele kan krijgen: `const v = {…}`, `v.k = …`, `Object.assign(v, {…})`. */
function keysOfVariable(src: string, v: string): string[] {
  const keys: string[] = [];
  const decl = new RegExp(`(?:const|let|var)\\s+${v}\\s*=\\s*\\{`, 'g');
  for (let m = decl.exec(src); m; m = decl.exec(src)) {
    const open = m.index + m[0].length - 1;
    keys.push(...keysOf(src.slice(open, matching(src, open) + 1)));
  }
  for (const m of src.matchAll(new RegExp(`(?<![\\w$.])${v}\\.([A-Za-z_$][\\w$]*)\\s*=(?!=)`, 'g'))) keys.push(m[1]!);
  for (const c of calls(src, 'Object\\.assign').filter((c) => c.args[0] === v))
    for (const a of c.args.slice(1)) if (a.startsWith('{')) keys.push(...keysOf(a));
  if (!keys.length) throw new Error(`scanner: patch-variabele ${v} niet gevonden`);
  return keys;
}

/** Velden van alle patches die als tweede argument aan `fn` worden meegegeven. */
function patchKeys(src: string, fn: string): Set<string> {
  const keys = new Set<string>();
  for (const c of calls(src, fn)) {
    const p = c.args[1];
    if (!p) throw new Error(`${fn} zonder patch bij ${c.at}`);
    const list = p.startsWith('{') ? keysOf(p) : /^[A-Za-z_$][\w$]*$/.test(p) ? keysOfVariable(src, p) : null;
    if (!list) throw new Error(`${fn}: patch "${p.slice(0, 40)}" bij ${c.at} kan de test niet lezen`);
    for (const k of list) {
      if (k.startsWith('...')) throw new Error(`${fn}: spread ${k} bij ${c.at}; velden onbekend`);
      keys.add(k);
    }
  }
  return keys;
}

function functionBody(src: string, name: string): string {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  if (!m) throw new Error(`functie ${name} niet gevonden in het prototype`);
  const open = src.indexOf('{', matching(src, m.index + m[0].length - 1));
  return src.slice(open, matching(src, open) + 1);
}

/* ---------- Het prototype lezen ---------- */

if (!existsSync(PROTO))
  throw new Error(`Prototype niet gevonden: ${PROTO}. Zet HZ_PROTOTYPE op workspace-prototype/index.html.`);
const html = readFileSync(PROTO, 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!).join('\n');

const commitAddBody = functionBody(script, 'commitAdd');
const docLiteral = (() => {
  const m = /const\s+doc\s*=\s*\{/.exec(commitAddBody)!;
  const open = m.index + m[0].length - 1;
  return commitAddBody.slice(open, matching(commitAddBody, open) + 1);
})();
const COMMIT_FIELDS = new Set([...keysOf(docLiteral), ...patchKeys(script, 'commitSave')]);
const STATE_FIELDS = new Set([...patchKeys(script, 'setState'), 'at']);

/** Voorbeeldwaarde per veld, in de vorm die het prototype schrijft. */
const SAMPLE: Record<string, unknown> = {
  wat: 'Voorbeeld',
  stroom: 'mijn',
  aan: 'Sanne',
  org: 'Feenstra',
  deadline: '2026-11-04',
  status: 'waarschijnlijk_klaar',
  plan: '2026-11-03',
  backlog: true,
  week: '2026-W45',
  health: 'oranje',
  reminder: '2026-11-05',
  gtask: { id: 'tk-1', tasklist: 'L' },
  src: 'sl_C1_1.2',
  closedAt: '2026-11-06',
  naar: 'taken.md',
  overgezet: true,
  bron: { key: 'sl_C1_1.2', label: 'Slack · #x', url: 'https://example.slack.com/x' },
  bewijsregel: { type: 'mail', to: '', keywords: ['offerte'] },
  citaat: 'ik stuur hem',
  created: '2026-10-28',
  createdAt: 1793170800000,
  moved: 2,
  bewijs: 'Mail verstuurd',
  outcome: 'doorgeschoven',
  outcomeNote: 'later',
  checks: [{ d: '2026-11-03', h: 'oranje', note: 'wacht' }],
  lastCheck: '2026-11-03',
  // itemstate
  read: true,
  at: 1793264400000,
  processed: true,
  skipPrep: true,
  handledBy: 'Lisanne',
  answeredBy: 'Lisanne',
  recapSession: 'gestart',
  reacted: 'eyes',
  added: 2,
  done: 'gtask',
  skip: true,
  skipped: true,
  until: '2026-11-07',
  keuze: 'deel',
  datum: '2026-10-28',
  tekst: 'Voorbeeld aangehouden',
};
const STATE_SAMPLE: Record<string, unknown> = { ...SAMPLE, bron: 'https://example.slack.com/x', overgezet: false };

const isSet = (x: unknown) => x !== null && x !== undefined && x !== '';

describe('contract met het prototype: wat het schrijft', () => {
  it('schrijft alleen naar commitments (add, update, delete) en itemstate (set)', () => {
    const sites = new Set<string>();
    for (const m of script.matchAll(/CAP\.db\.doc\(\s*'([a-z_]+)\/'[^)]*\)\.(set|update|delete|add)\(/g))
      sites.add(`${m[1]}:${m[2]}`);
    for (const m of script.matchAll(/CAP\.db\.collection\(\s*'([a-z_]+)'\s*\)\.(set|update|delete|add)\(/g))
      sites.add(`${m[1]}:${m[2]}`);
    expect([...sites].sort()).toEqual(['commitments:add', 'commitments:delete', 'commitments:update', 'itemstate:set']);
    // en die lopen via commitAdd/commitSave/commitDelete en setState
    expect(functionBody(script, 'commitSave')).toMatch(/CAP\.db\.doc\('commitments\/' \+ docId\)\.update\(patch\)/);
    expect(functionBody(script, 'setState')).toMatch(/CAP\.db\.doc\('itemstate\/' \+ key\)\.set\(LV\.state\[key\]\)/);
    expect(commitAddBody).toMatch(/CAP\.db\.collection\('commitments'\)\.add\(doc\)/);
  });

  it('de scanner vindt de bekende schrijfpaden (planCommit: gtask; checkReactions: handledBy)', () => {
    expect(COMMIT_FIELDS.size).toBeGreaterThanOrEqual(25);
    expect(STATE_FIELDS.size).toBeGreaterThanOrEqual(15);
    for (const k of ['gtask', 'bewijsregel', 'lastCheck', 'outcomeNote', 'checks', 'src', 'moved'])
      expect(COMMIT_FIELDS).toContain(k);
    for (const k of ['handledBy', 'reacted', 'recapSession', 'done', 'skip', 'until', 'list', 'at'])
      expect(STATE_FIELDS).toContain(k);
    // planCommit schrijft gtask als object (gtaskAdd geeft {id, tasklist}) en leest c.gtask?.id
    expect(functionBody(script, 'planCommit')).toMatch(/patch\.gtask = await gtaskAdd\(/);
    expect(functionBody(script, 'gtaskAdd')).toMatch(/return \{ id: findId\(p\), tasklist: tl \}/);
  });

  it('elk veld van commitments heeft een plek in tracker_items én weekdoelen (kolom of extra)', () => {
    for (const k of COMMIT_FIELDS) {
      expect(VELDEN.tracker, `tracker: ${k}`).toHaveProperty(k);
      expect(VELDEN.weekdoel, `weekdoel: ${k}`).toHaveProperty(k);
      expect(SAMPLE, `SAMPLE: ${k}`).toHaveProperty(k);
    }
  });

  it('elk veld van itemstate heeft een plek in item_state (kolom, extra, of pins voor _pins)', () => {
    for (const k of STATE_FIELDS) {
      expect(VELDEN.itemstate, `itemstate: ${k}`).toHaveProperty(k);
      if (k !== 'list') expect(STATE_SAMPLE, `SAMPLE: ${k}`).toHaveProperty(k);
    }
  });

  it('elke kolom in VELDEN schrijft de import ook echt weg', () => {
    for (const [t, map] of Object.entries(VELDEN) as Array<[keyof typeof VELDEN, Record<string, string>]>)
      for (const [k, dest] of Object.entries(map)) {
        if (dest === 'extra' || dest === 'pins') continue;
        expect(IMPORT_COLUMNS[t] as readonly string[], `${t}.${k} -> ${dest}`).toContain(dest);
      }
  });
});

describe('contract met het prototype: niets gaat verloren in planImport', () => {
  const docWith = (fields: Set<string>, sample: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    ...Object.fromEntries([...fields].filter((k) => k !== 'list').map((k) => [k, sample[k]])),
    ...over,
  });

  for (const [target, stroom] of [
    ['tracker', 'mijn'],
    ['weekdoel', 'weekdoel'],
  ] as const) {
    it(`commitments (stroom ${stroom}) -> ${target === 'tracker' ? 'tracker_items' : 'weekdoelen'}: elk veld in zijn kolom of in extra`, () => {
      const d = docWith(COMMIT_FIELDS, SAMPLE, { stroom });
      const p = planImport({ commitments: [{ id: 'c1', data: d }] });
      expect(p.overgeslagen).toEqual([]);
      const row = (target === 'tracker' ? p.tracker[0] : p.weekdoelen[0]) as unknown as Record<string, unknown>;
      const extra = row.extra as Record<string, unknown>;
      const map = VELDEN[target] as Record<string, string>;
      for (const k of COMMIT_FIELDS) {
        const dest = map[k]!;
        if (dest === 'extra') expect(extra[k], `${k} in extra`).toEqual(d[k]);
        else expect(isSet(row[dest]), `${k} -> ${dest}`).toBe(true);
      }
      // Geen waarschuwingen: elke voorbeeldwaarde is in de vorm die het prototype schrijft
      expect(p.waarschuwingen).toEqual([]);
      if (target === 'tracker') {
        expect(row).toMatchObject({ gtask: 'tk-1', srcKey: 'sl_C1_1.2', backlog: true, overgezet: true, moved: 2 });
        expect(extra.gtask).toEqual({ tasklist: 'L' });
        expect(row.bron).toEqual(SAMPLE.bron);
      }
    });
  }

  it('itemstate -> item_state: elk veld in zijn kolom of in extra; handledBy wordt answered_by', () => {
    const d = docWith(STATE_FIELDS, STATE_SAMPLE);
    const p = planImport({ itemstate: [{ id: 'sl_C1_1.2', data: d }] });
    const row = p.itemState[0] as unknown as Record<string, unknown>;
    const extra = row.extra as Record<string, unknown>;
    for (const k of STATE_FIELDS) {
      if (k === 'list') continue;
      const dest = (VELDEN.itemstate as Record<string, string>)[k]!;
      if (dest === 'extra') expect(extra[k], `${k} in extra`).toEqual(d[k]);
      else expect(isSet(row[dest]), `${k} -> ${dest}`).toBe(true);
    }
    expect(row).toMatchObject({ answeredBy: 'Lisanne', read: true, processed: true, skipPrep: true });
    expect(p.waarschuwingen).toEqual([]);
    // _pins: list -> pins
    const pins = planImport({ itemstate: [{ id: '_pins', data: { list: [{ id: 'p1', q: 'feenstra', name: 'F' }] } }] });
    expect(pins.pins).toEqual([{ kind: 'search', label: 'F', q: 'feenstra', position: 0 }]);
  });
});

describe('opgenomen export (tools/bar/record-export.mjs: de echte schrijfpaden van het prototype)', () => {
  const REC = resolve(here, 'fixtures/prototype-recorded-export.json');
  const cols = readExport(REC);
  const p = planImport(cols);
  const filled = (v: unknown) => v !== null && v !== undefined && v !== false && v !== '';

  it('het prototype schreef gtask als {id, tasklist} (planCommit) en als "gtask:<id>" (knop c-gtask)', () => {
    const raw = Object.fromEntries(cols.commitments!.map((d) => [d.id, d.data]));
    expect(raw.rec1!.gtask).toEqual({ id: 'tk-rec-1', tasklist: 'L' });
    expect(raw.rec2!.gtask).toBe('gtask:tk-rec-2');
    expect(cols.itemstate!.find((d) => d.id === 'sl_CFE_1761680000.000500')!.data).toMatchObject({
      handledBy: 'Lisanne',
    });
  });

  it('elk veld van elk opgenomen doc staat na planImport in zijn kolom of in extra; geen waarschuwingen', () => {
    expect(p.overgeslagen).toEqual([]);
    expect(p.waarschuwingen).toEqual([]);
    for (const { id, data } of cols.commitments!) {
      const doel = data.stroom === 'weekdoel' || data.stroom === 'roadmap';
      const row = (doel ? p.weekdoelen : p.tracker).find((r) => r.legacyId === id) as unknown as Record<
        string,
        unknown
      >;
      const map = (doel ? VELDEN.weekdoel : VELDEN.tracker) as Record<string, string>;
      const extra = row.extra as Record<string, unknown>;
      for (const [k, v] of Object.entries(data)) {
        expect(map, `${id}.${k} onbekend in VELDEN`).toHaveProperty(k);
        if (map[k] === 'extra') expect(extra[k], `${id}.${k}`).toEqual(v);
        else if (filled(v)) expect(isSet(row[map[k]!]), `${id}.${k} -> ${map[k]}`).toBe(true);
      }
    }
    for (const { id, data } of cols.itemstate!) {
      if (id === '_pins') continue;
      const row = p.itemState.find((r) => r.itemKey === id) as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(data)) {
        const dest = (VELDEN.itemstate as Record<string, string>)[k];
        expect(dest, `${id}.${k} onbekend in VELDEN`).toBeDefined();
        if (dest === 'extra') expect((row.extra as Record<string, unknown>)[k], `${id}.${k}`).toEqual(v);
        else if (filled(v)) expect(isSet(row[dest!]), `${id}.${k} -> ${dest}`).toBe(true);
      }
    }
  });

  it('gekoppelde taken (rec1, rec2) zijn niet zichtbaar in de tracker; de wachten-op-toezegging wel; handledBy -> answered_by', () => {
    const t = (id: string) => p.tracker.find((r) => r.legacyId === id)!;
    expect(t('rec1')).toMatchObject({
      gtask: 'tk-rec-1',
      extra: expect.objectContaining({ gtask: { tasklist: 'L' } }),
    });
    expect(t('rec2').gtask).toBe('tk-rec-2');
    const vis = (id: string) => trackerItemVisible({ bron: null, overgezet: false, ...t(id) } as never);
    expect(vis('rec1')).toBe(false);
    expect(vis('rec2')).toBe(false);
    expect(vis('rec3')).toBe(true);
    expect(t('rec3')).toMatchObject({ srcKey: 'sl_CFE_1761680000.000500', bron: { key: 'sl_CFE_1761680000.000500' } });
    expect(p.itemState.find((s) => s.itemKey === 'sl_CFE_1761680000.000500')).toMatchObject({
      read: true,
      answeredBy: 'Lisanne',
      extra: {},
    });
    expect(p.pins.map((x) => x.q)).toEqual(['feenstra, offerte']);
  });
});
