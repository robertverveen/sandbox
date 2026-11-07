#!/usr/bin/env node
/**
 * Dezelfde schermen als tools/bar, maar van onze app: .local/ours/<modus>/<scherm>-<viewport>-<thema>.png.
 *
 * Modi (zelfde data als de lat):
 *   demo     fixtures 'demo' (demodata van het prototype, klok vr 30 okt 2026 08:40)
 *   context  fixtures 'harness' (zelfde nep-bronnen als het harnas van de lat) + HZ_CONTEXT_EXPORT, klok = nu
 *
 * Start zelf een API en een Vite-server op eigen poorten (HZ_SHOT_API_PORT, standaard 8790; HZ_SHOT_WEB_PORT, 8791),
 * tenzij HZ_SHOT_URL naar een draaiende app wijst (dan alleen modus demo of wat die app serveert).
 *
 *   pnpm shot
 *   HZ_CONTEXT_EXPORT=/pad/naar/export pnpm shot -- --modes demo,context
 *   pnpm shot -- --screens dagstart --viewports mobile --themes dark
 *
 * Daarna: node tools/compare.mjs maakt .local/compare/index.html (naast elkaar, desgewenst blind).
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shoot, parseArgs, VIEWPORTS } from '../shared.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = parseArgs(process.argv.slice(2), { modes: process.env.HZ_CONTEXT_EXPORT ? 'demo,context' : 'demo' });
const API_PORT = Number(process.env.HZ_SHOT_API_PORT ?? 8790);
const WEB_PORT = Number(process.env.HZ_SHOT_WEB_PORT ?? 8791);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function up(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 401) return true;
    } catch {
      /* nog niet */
    }
    await wait(250);
  }
  throw new Error(`niet bereikbaar: ${url}`);
}

function start(mode) {
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    HZ_API_PORT: String(API_PORT),
    HZ_WEB_PORT: String(WEB_PORT),
    HZ_STORE: 'memory',
    HZ_FIXTURE_SET: mode === 'context' ? 'harness' : 'demo',
  };
  if (mode !== 'context') delete env.HZ_CONTEXT_EXPORT;
  const tsx = join(root, 'node_modules/.bin/tsx');
  const vite = join(root, 'apps/web/node_modules/.bin/vite');
  const procs = [
    spawn(tsx, ['apps/api/src/index.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }),
    spawn(vite, ['--port', String(WEB_PORT), '--strictPort'], {
      cwd: join(root, 'apps/web'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  ];
  const log = [];
  for (const p of procs) {
    p.stdout.on('data', (d) => log.push(String(d)));
    p.stderr.on('data', (d) => log.push(String(d)));
  }
  return {
    log,
    stop: async () => {
      for (const p of procs) p.kill('SIGTERM');
      await wait(300);
    },
  };
}

const ROUTES = {
  dagstart: '/dagstart',
  planning: '/planning',
  sprint: '/planning?tab=sprint',
  agenda: '/agenda',
  tracker: '/tracker',
  chat: '/chat',
  entity: '/o/feenstra',
  palette: '/dagstart',
  help: '/dagstart',
  // Stuk E1 (alleen met --screens): agenda-lagen naast het lagenpaneel van de lat, en de eigen schermen.
  lagen: '/welkom?stap=agenda',
  welkom: '/welkom?stap=welkom',
  koppelingen: '/instellingen/koppelingen',
};

const outRoot = join(root, '.local/ours');
const report = { made: [], errors: [] };
const b = await chromium.launch();
for (const mode of args.modes) {
  if (mode === 'context' && !process.env.HZ_CONTEXT_EXPORT) {
    console.warn('context overgeslagen: zet HZ_CONTEXT_EXPORT');
    continue;
  }
  const external = process.env.HZ_SHOT_URL;
  const srv = external ? null : start(mode);
  const base = external ?? `http://127.0.0.1:${WEB_PORT}`;
  try {
    await up(`${base}/`);
    if (!external) await up(`http://127.0.0.1:${API_PORT}/api/health`);
    const out = join(outRoot, mode);
    mkdirSync(out, { recursive: true });
    for (const vp of args.viewports) {
      for (const theme of args.themes) {
        const ctx = await b.newContext({ viewport: VIEWPORTS[vp], colorScheme: theme });
        await ctx.addInitScript((t) => {
          try {
            localStorage.setItem('hz:theme', t);
          } catch {
            /* */
          }
        }, theme);
        const p = await ctx.newPage();
        p.on('pageerror', (e) => report.errors.push(`${mode}/${vp}/${theme}: ${e.message}`));
        for (const s of args.screens) {
          if (!ROUTES[s]) continue;
          await p.goto(base + ROUTES[s]);
          await p.waitForSelector('.page', { timeout: 15000 });
          // Geen networkidle: de SSE-verbinding (/api/events) blijft bewust open.
          if (s === 'dagstart' || s === 'palette' || s === 'help') await p.waitForSelector('.calm-grid');
          await p.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
          if (s === 'palette') {
            await p.keyboard.press('Control+k');
            await p.keyboard.type('feen');
          }
          if (s === 'help') await p.keyboard.press('?');
          if (s === 'lagen') await p.waitForSelector('.calpanel .cp-row');
          if (s === 'koppelingen') await p.waitForSelector('.conn');
          await p.mouse.move(1, 1);
          await p.waitForTimeout(300);
          const file = join(out, `${s}-${vp}-${theme}.png`);
          await shoot(p, file, vp, ['palette', 'help'].includes(s));
          report.made.push(file.slice(root.length + 1));
        }
        await ctx.close();
      }
    }
  } catch (e) {
    report.errors.push(`${mode}: ${e.message}`);
    if (srv) report.errors.push(srv.log.join('').slice(-2000));
  } finally {
    await srv?.stop();
  }
}
await b.close();
mkdirSync(outRoot, { recursive: true });
writeFileSync(join(outRoot, 'report.json'), JSON.stringify(report, null, 1));
console.log(
  `${report.made.length} screenshots in .local/ours${report.errors.length ? ` · ${report.errors.length} fouten in report.json` : ''}`,
);
if (report.errors.length) process.exitCode = 1;
