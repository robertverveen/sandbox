#!/usr/bin/env node
/**
 * De lat: laadt het prototype (workspace-prototype/index.html) met een nep-window.claude en maakt
 * screenshots per scherm in .local/bar/<modus>/<scherm>-<viewport>-<thema>.png.
 *
 * Modi:
 *   demo     zonder window.claude: het prototype draait op zijn ingebouwde demodata (vaste klok 30 okt 2026).
 *   context  met nep-MCP (zelfde payloads als het voorbeeldharnas test17.js) en de echte contextdata uit
 *            HZ_CONTEXT_EXPORT (alleen runtime; nooit committen). Klok = nu.
 *
 * Gebruik:
 *   pnpm bar                                   # demo, alle schermen, desktop en mobiel, licht en donker
 *   HZ_CONTEXT_EXPORT=/pad/naar/export pnpm bar -- --modes demo,context
 *   pnpm bar -- --screens dagstart,palette --viewports desktop --themes light
 *
 * Omgeving: HZ_PROTOTYPE (pad naar index.html, standaard ../workspace-prototype/index.html naast deze repo).
 */
/* global go, S, openPalette, closePalette, renderHelp, CTX -- globale namen in het script van het prototype */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shoot, parseArgs, VIEWPORTS } from '../shared.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const proto = process.env.HZ_PROTOTYPE ?? resolve(root, '../workspace-prototype/index.html');
const args = parseArgs(process.argv.slice(2), { modes: process.env.HZ_CONTEXT_EXPORT ? 'demo,context' : 'demo' });

if (!existsSync(proto)) {
  console.error(`Prototype niet gevonden: ${proto} (zet HZ_PROTOTYPE)`);
  process.exit(2);
}
const html = readFileSync(proto, 'utf8');

function loadExport(dir) {
  const out = {};
  for (const col of ['context_partners', 'context_acties', 'context_persoonlijk', 'context_status']) {
    out[col] = {};
    const d = join(dir, col);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d))
      if (f.endsWith('.json')) out[col][f.replace(/\.json$/, '')] = JSON.parse(readFileSync(join(d, f), 'utf8'));
  }
  return out;
}

/** Nep-window.claude zoals in het voorbeeldharnas (test17.js): MCP-payloads relatief aan nu + database met contextdata. */
const mock = (CTX) => {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const day = (k) => {
    const d = new Date(now);
    d.setDate(d.getDate() + k);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const ev = (id, k, s, e, summary, att) => ({
    id,
    summary,
    start: { dateTime: `${day(k)}T${s}:00+01:00` },
    end: { dateTime: `${day(k)}T${e}:00+01:00` },
    eventType: 'DEFAULT',
    status: 'confirmed',
    htmlLink: 'https://calendar.google.com/x',
    organizer: { email: 'robert@homezero.nl', self: true },
    attendees: att.map((a) => ({ email: a, responseStatus: 'accepted', self: a === 'robert@homezero.nl' })),
  });
  const payloads = {
    list_events: {
      events: [
        ev('fe1', 0, '13:00', '14:00', 'Feenstra · opleversessie', [
          'robert@homezero.nl',
          'sanne@voorbeeldpartner.nl',
        ]),
        ev('ww1', 1, '11:00', '12:00', 'Voorbeeldinstallateur - HomeZero', ['robert@homezero.nl', 'info@voorbeeldinstallateur.nl']),
      ],
    },
    search_threads: {
      threads: [
        {
          id: 't1',
          messageCount: 2,
          messages: [
            {
              sender: 'Sanne de Wit <sanne@voorbeeldpartner.nl>',
              subject: 'Meterkastcheck',
              toRecipients: ['robert@homezero.nl'],
              ccRecipients: [],
            },
          ],
        },
      ],
    },
    slack_search_public_and_private: (inp) => ({
      results:
        inp.filters && inp.filters.startsWith('to:me')
          ? ''
          : `# Search Results\n### Result 1 of 1\nChannel: #feenstra-hz (ID: CFE)\nFrom: Sanne de Wit (ID: UMB)\nMessage_ts: ${Math.floor(Date.now() / 1000) - 3600}.000100\nPermalink: [link](https://homezero-workspace.slack.com/archives/CFE/p1)\nText: <@U04L22BRJQ7> kun je even kijken naar de opleverlijst?\n---\n`,
    }),
    list_tasks: {
      tasks: [
        {
          id: 'g1',
          title: 'Recap met prioriteitenlijst op Slack delen',
          status: 'needsAction',
          due: day(1) + 'T00:00:00.000Z',
          tasklist_id: 'L',
          tasklist_title: 'My Tasks',
        },
        {
          id: 'g2',
          title: 'Offerte Feenstra nalopen',
          status: 'needsAction',
          due: day(0) + 'T00:00:00.000Z',
          tasklist_id: 'L',
          tasklist_title: 'My Tasks',
        },
      ],
    },
    list_calendars: { calendars: [{ id: 'robert@homezero.nl', summary: 'robert@homezero.nl', primary: true }] },
    list_tasklists: { tasklists: [{ id: 'L', title: 'My Tasks' }] },
    search_meetings: { meetings: [] },
    slack_list_user_channels: { result: '' },
  };
  const mcp = {
    watchTool(server, tool, input, h) {
      setTimeout(() => {
        const p = payloads[tool];
        h({ type: 'data', result: { payload: typeof p === 'function' ? p(input) : p || {} } });
      }, 50);
      return () => {};
    },
    callTool: async () => ({ payload: {} }),
    invalidate: async () => {},
  };
  const COMMITS = {
    'canvas-x': { wat: 'Canvas-item', stroom: 'bespreken', status: 'open', bron: { label: 'Canvas Wachten op' } },
    'old-mijn': { wat: 'Oude belofte zonder taak', stroom: 'mijn', status: 'open', bron: { label: 'Eigen invoer' } },
    'old-gt': { wat: 'Al in Google', stroom: 'mijn', status: 'open', gtask: 'x', bron: { label: 'Slack' } },
    q1: {
      wat: 'Lisanne: oppikken morgen',
      stroom: 'aan_mij',
      status: 'open',
      aan: 'Lisanne',
      created: day(-1),
      reminder: day(2),
      bron: { label: 'Slack · DM' },
    },
    wd: { wat: 'Weekdoel A', stroom: 'weekdoel', status: 'open', week: '2026-W45' },
  };
  const DATA = { ...CTX, commitments: COMMITS };
  const snap = (n) => ({ docs: Object.entries(DATA[n] || {}).map(([id, d]) => ({ id, data: () => d })) });
  const db = {
    collection(n) {
      const q = {
        orderBy: () => q,
        limit: () => q,
        where: () => q,
        onSnapshot(f) {
          setTimeout(() => f(snap(n)), 30);
          return () => {};
        },
        add: async () => ({ id: 'n1' }),
      };
      return q;
    },
    doc() {
      return { set: async () => {}, update: async () => {}, delete: async () => {} };
    },
  };
  window.claude = {
    use: async (n) =>
      n === 'mcp'
        ? mcp
        : n === 'db'
          ? db
          : n === 'sample'
            ? Object.assign(async () => ({ text: 'ok' }), { json: async () => ({ items: [] }) })
            : null,
  };
};

function page(mode) {
  const head =
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0">';
  if (mode === 'demo') return head + html + '</body></html>';
  const ctx = loadExport(process.env.HZ_CONTEXT_EXPORT);
  return head + '<script>(' + mock.toString() + ')(' + JSON.stringify(ctx) + ');</script>' + html + '</body></html>';
}

/** Navigatie in het prototype (globale functies in zijn script). */
const NAV = {
  dagstart: (p) => p.evaluate(() => go({ view: 'dagstart' })),
  planning: (p) =>
    p.evaluate(() => {
      S.planTab = 'mijn';
      go({ view: 'planning' });
    }),
  sprint: (p) =>
    p.evaluate(() => {
      S.planTab = 'sprint';
      go({ view: 'planning' });
    }),
  agenda: (p) => p.evaluate(() => go({ view: 'agenda' })),
  tracker: (p) =>
    p.evaluate(() => {
      S.commitTab = 'taken';
      go({ view: 'toezeggingen' });
    }),
  chat: (p) => p.evaluate(() => go({ view: 'chat' })),
  // Stuk E1: het lagenpaneel van Agenda (l), de lat voor de stap Agenda-lagen van de onboarding.
  lagen: (p) =>
    p.evaluate(() => {
      S.calPanel = true;
      go({ view: 'agenda' });
    }),
  entity: (p, mode) =>
    p.evaluate(
      (m) =>
        go({
          view: 'entity',
          id:
            m === 'demo'
              ? 'feenstra'
              : Object.keys(CTX.bySlug || {}).includes('feenstra')
                ? 'feenstra'
                : Object.keys(CTX.bySlug || {})[0],
        }),
      mode,
    ),
  palette: async (p) => {
    await p.evaluate(() => go({ view: 'dagstart' }));
    await p.evaluate(() => openPalette('feen'));
  },
  help: async (p) => {
    await p.evaluate(() => go({ view: 'dagstart' }));
    await p.evaluate(() => {
      S.help = true;
      renderHelp();
    });
  },
};

const outRoot = join(root, '.local/bar');
const b = await chromium.launch();
const report = { prototype: proto, made: [], errors: [] };
for (const mode of args.modes) {
  if (mode === 'context' && !process.env.HZ_CONTEXT_EXPORT) {
    console.warn('context overgeslagen: zet HZ_CONTEXT_EXPORT');
    continue;
  }
  const out = join(outRoot, mode);
  mkdirSync(out, { recursive: true });
  const content = page(mode);
  for (const vp of args.viewports) {
    for (const theme of args.themes) {
      const ctx = await b.newContext({ viewport: VIEWPORTS[vp], colorScheme: theme });
      const p = await ctx.newPage();
      p.on('pageerror', (e) => report.errors.push(`${mode}/${vp}/${theme}: ${e.message}`));
      await p.setContent(content, { waitUntil: 'networkidle' });
      await p.waitForTimeout(1200);
      await p.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      // De functies en de staat (S) van het prototype zijn globale namen in zijn script.
      for (const s of args.screens) {
        if (!NAV[s]) continue;
        await p.evaluate(() => {
          S.help = false;
          if (S.palette) closePalette();
          renderHelp();
        });
        await NAV[s](p, mode);
        await p.waitForTimeout(350);
        const file = join(out, `${s}-${vp}-${theme}.png`);
        await shoot(p, file, vp, ['palette', 'help'].includes(s));
        report.made.push(file.slice(root.length + 1));
      }
      await ctx.close();
    }
  }
}
await b.close();
writeFileSync(join(outRoot, 'report.json'), JSON.stringify(report, null, 1));
console.log(
  `${report.made.length} screenshots in .local/bar${report.errors.length ? ` · ${report.errors.length} fouten in report.json` : ''}`,
);
