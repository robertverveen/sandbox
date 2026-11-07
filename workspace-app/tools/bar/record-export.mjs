#!/usr/bin/env node
/**
 * Neemt een export op uit het prototype zelf (HZW-021): laadt workspace-prototype/index.html met een nep-window.claude
 * waarvan de opslag (window.claude.use('db')) alles onthoudt wat het prototype schrijft, voert de echte schrijfpaden
 * uit en schrijft de opslag weg als export in de vorm die import:prototype leest.
 *
 * Schrijfpaden (de functies en knoppen van het prototype zelf, niet nagebouwd):
 *   commitAdd()                     nieuwe toezegging (zonder Google Taken: naar taken.md; aan_mij: wachten-op.md)
 *   planCommit(item, 2)             plannen op morgen: maakt een Google Taak, bewaart gtask = {id, tasklist}
 *   knop c-gtask (klik)             "In Google Taken": taskFromCommit() geeft 'gtask:<id>'
 *   itemToCommit(slack-item)        uit Inhalen naar de tracker: src = item-sleutel, bron = srcOf(item)
 *   commitAdd(weekdoel)             weekdoel uit de plansessie
 *   setState(...)                   gelezen, verwerkt, geen prep, recap-sessie, handledBy (checkReactions), reacted
 *   setPins([...])                  vastgezette zoekopdracht (itemstate/_pins)
 *   knoppen repo-later, ctx-taak-skip (klik)
 *
 * Gebruik:  node tools/bar/record-export.mjs [uitvoerbestand]
 *           (standaard packages/db/test/fixtures/prototype-recorded-export.json; synthetisch, mag in Git)
 * Omgeving: HZ_PROTOTYPE (pad naar index.html).
 */
/* global LV, ST, commitAdd, commitItems, planCommit, itemToCommit, setState, setPins, stateKey */
import { chromium } from 'playwright';
import * as prettier from 'prettier';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const proto =
  process.env.HZ_PROTOTYPE ??
  [resolve(root, 'docs/prototype/index.html'), resolve(root, '../workspace-prototype/index.html')].find((p) => existsSync(p)) ??
  resolve(root, 'docs/prototype/index.html');
const out = resolve(process.argv[2] ?? resolve(root, 'packages/db/test/fixtures/prototype-recorded-export.json'));
if (!existsSync(proto)) {
  console.error(`Prototype niet gevonden: ${proto} (zet HZ_PROTOTYPE)`);
  process.exit(2);
}
const html = readFileSync(proto, 'utf8');

/** Nep-window.claude: MCP met lege lijsten (Google Taken maakt taken met vaste id's) en een opslag die onthoudt. */
const mock = () => {
  const store = { commitments: {}, itemstate: {}, briefings: {} };
  const listeners = {};
  let seq = 0;
  let taskSeq = 0;
  const snap = (n) => ({
    docs: Object.entries(store[n] || {}).map(([id, d]) => ({ id, data: () => structuredClone(d) })),
  });
  const fire = (n) => setTimeout(() => (listeners[n] || []).forEach((f) => f(snap(n))), 5);
  const clean = (x) => JSON.parse(JSON.stringify(x)); // zoals een documentopslag: undefined valt weg
  const db = {
    collection(n) {
      const q = {
        orderBy: () => q,
        limit: () => q,
        where: () => q,
        onSnapshot(f) {
          (listeners[n] = listeners[n] || []).push(f);
          setTimeout(() => f(snap(n)), 5);
          return () => {};
        },
        add: async (doc) => {
          const id = `rec${++seq}`;
          (store[n] = store[n] || {})[id] = clean(doc);
          fire(n);
          return { id };
        },
      };
      return q;
    },
    doc(path) {
      const [n, id] = path.split('/');
      return {
        set: async (d) => {
          (store[n] = store[n] || {})[id] = clean(d);
          fire(n);
        },
        update: async (patch) => {
          store[n][id] = { ...store[n][id], ...clean(patch) };
          fire(n);
        },
        delete: async () => {
          delete store[n][id];
          fire(n);
        },
      };
    },
  };
  const payloads = { list_tasklists: { tasklists: [] }, list_tasks: { tasks: [] }, list_calendars: { calendars: [] } };
  const mcp = {
    watchTool(server, tool, input, h) {
      setTimeout(() => h({ type: 'data', result: { payload: payloads[tool] || {} } }), 20);
      return () => {};
    },
    callTool: async (server, tool) => ({
      payload: server === 'Google Tasks' && tool === 'add' ? { id: `tk-rec-${++taskSeq}` } : {},
    }),
    invalidate: async () => {},
  };
  window.__hzStore = store;
  window.claude = {
    use: async (n) => (n === 'mcp' ? mcp : n === 'db' ? db : n === 'sample' ? null : null),
  };
};

const b = await chromium.launch();
const p = await b.newPage();
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
await p.setContent(
  '<!doctype html><html><head><meta charset="utf-8"></head><body><script>(' +
    mock.toString() +
    ')();</script>' +
    html +
    '</body></html>',
  { waitUntil: 'networkidle' },
);
await p.waitForFunction(() => ST.commits === 'ok', null, { timeout: 10000 });

const settle = () => p.waitForTimeout(80);
const click = (attrs) =>
  p.evaluate((a) => {
    const el = document.createElement('button');
    for (const [k, v] of Object.entries(a)) el.setAttribute(k, v);
    document.body.appendChild(el);
    el.click();
    el.remove();
  }, attrs);

// 1. Toezegging zonder Google Taken (naar taken.md), daarna plannen op morgen: planCommit maakt de Google Taak.
const id1 = await p.evaluate(async () => {
  LV.tasklists = [];
  return commitAdd({
    wat: 'Offerte warmtepomp naar Sanne sturen',
    stroom: 'mijn',
    aan: 'Sanne de Wit',
    org: 'Feenstra',
    deadline: '2026-11-10',
    bewijsregel: { type: 'mail', to: '', keywords: ['offerte'] },
    citaat: 'Ik stuur je de offerte',
  });
});
await settle();
await p.evaluate(async (id) => {
  LV.tasklists = [{ id: 'L', title: 'My Tasks' }];
  const it = commitItems().find((x) => x.docId === id);
  await planCommit(it, 2);
}, id1);
await settle();

// 2. Voornemen, daarna de knop "In Google Taken" (c-gtask): gtask = 'gtask:<id>'.
const id2 = await p.evaluate(async () => {
  LV.tasklists = [];
  return commitAdd({ wat: 'Isolatierekenmodel helemaal nalopen', stroom: 'voornemen' });
});
await settle();
await p.evaluate(() => {
  LV.tasklists = [{ id: 'L', title: 'My Tasks' }];
});
await click({ 'data-action': 'c-gtask', 'data-id': id2 });
await p.waitForTimeout(200);

// 3. Uit Inhalen naar de tracker (wachten op): itemToCommit met een Slack-item.
const slackItem = {
  id: 'sl_CFE_1761680000.000500',
  type: 'slack',
  fromName: 'Emiel',
  title: 'Kun je de sync-fix bevestigen?',
  channel: '#feenstra-hz',
  url: 'https://example.slack.com/archives/CFE/p1761680000000500',
  entities: [],
};
await p.evaluate(async (it) => itemToCommit(it, { stroom: 'aan_mij', reminder: '2026-11-05' }), slackItem);
await settle();

// 4. Weekdoel uit de plansessie.
await p.evaluate(async () =>
  commitAdd({
    wat: 'Isolatieflow live op acceptatie',
    stroom: 'weekdoel',
    week: '2026-W45',
    deadline: '2026-11-07',
    bron: { label: 'Plansessie' },
  }),
);
await settle();

// 5. Itemstatus: gelezen, verwerkt, geen prep, recap-sessie, al beantwoord door een ander (checkReactions), reactie.
await p.evaluate(async (it) => {
  await setState(stateKey(it), { read: true, handledBy: 'Lisanne' });
  await setState('sl_CFE_1761690000.000400', { read: true, reacted: 'eyes' });
  await setState('wm:r1', { processed: true });
  await setState('wm:r3', { recapSession: 'gestart' });
  await setState('ev_abc_google.com', { skipPrep: true });
  setPins([{ id: 'p1', q: 'feenstra, offerte', name: 'Feenstra · offerte' }]);
}, slackItem);
await click({ 'data-action': 'repo-later' });
await click({ 'data-action': 'ctx-taak-skip', 'data-h': '1a2b3c' });
await p.waitForTimeout(200);

const store = await p.evaluate(() => window.__hzStore);
await b.close();
if (errors.length) {
  console.error(`fouten in het prototype:\n${errors.join('\n')}`);
  process.exit(1);
}
const exp = {
  source: 'opgenomen uit workspace-prototype/index.html met tools/bar/record-export.mjs (synthetisch)',
  collections: { commitments: store.commitments, itemstate: store.itemstate },
};
// Tijdstempels vastzetten zodat het bestand stabiel blijft tussen opnames.
let t = 1793170800000;
for (const d of Object.values(exp.collections.commitments))
  if (typeof d.createdAt === 'number') d.createdAt = t += 60000;
for (const d of Object.values(exp.collections.itemstate)) if (typeof d.at === 'number') d.at = t += 60000;
// In de stijl van de repo (prettier), zodat format:check groen blijft na een nieuwe opname.
const cfg = (await prettier.resolveConfig(out)) ?? {};
writeFileSync(out, await prettier.format(JSON.stringify(exp), { ...cfg, parser: 'json' }));
console.log(
  `${Object.keys(store.commitments).length} commitments, ${Object.keys(store.itemstate).length} itemstate -> ${out}`,
);
