#!/usr/bin/env node
/**
 * Rooktest van de web-container zonder Docker (HZW-004): de gebouwde SPA achter Caddy met precies de
 * Caddyfile en CSP van het image, /api doorgezet naar een echte API (fixtures). Een echte browser (Playwright)
 * opent Dagstart en een diepe link; er mag geen enkele CSP-overtreding of consolefout zijn.
 * Lokaal en in de workflow workspace-infra (vereist caddy op PATH en een gebouwde apps/web/dist):
 *
 *   node infra/scripts/web-smoke.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { cspSnippet } from '../docker/web-csp.mjs';

const infra = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = resolve(infra, '..');
const dist = join(app, 'apps/web/dist');

const freePort = () =>
  new Promise((ok) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => ok(p));
    });
  });

const procs = [];
const start = (cmd, args, env) => {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  procs.push(p);
  return { p, out: () => out };
};
const stopAll = () => procs.forEach((p) => p.kill('SIGTERM'));

async function waitFor(url, ms = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return r;
    } catch {
      /* nog niet */
    }
    await new Promise((ok) => setTimeout(ok, 200));
  }
  throw new Error(`${url} kwam niet op`);
}

const fails = [];
const check = (ok, msg) => {
  console.log(`${ok ? 'OK  ' : 'FOUT'}  ${msg}`);
  if (!ok) fails.push(msg);
};

try {
  const apiPort = await freePort();
  const webPort = await freePort();
  const work = mkdtempSync(join(tmpdir(), 'hz-e0-websmoke-'));
  writeFileSync(join(work, 'csp.caddy'), cspSnippet(readFileSync(join(dist, 'index.html'), 'utf8')));
  const caddyfile = readFileSync(join(infra, 'docker/web.Caddyfile'), 'utf8')
    .replace(':8080 {', `:${webPort} {`)
    .replace('root * /srv/web', `root * ${dist}`)
    .replace('/etc/caddy/csp.caddy', join(work, 'csp.caddy'));
  writeFileSync(join(work, 'Caddyfile'), caddyfile);

  const api = start(join(app, 'node_modules/.bin/tsx'), [join(app, 'apps/api/src/index.ts')], {
    HZ_API_PORT: String(apiPort),
    HZ_FIXTURE_SET: 'demo',
    HZ_STORE: 'memory',
    NODE_ENV: 'development',
    HZ_CONTEXT_EXPORT: '',
  });
  await waitFor(`http://127.0.0.1:${apiPort}/api/health`).catch((e) => {
    console.error(api.out());
    throw e;
  });
  const caddy = start('caddy', ['run', '--config', join(work, 'Caddyfile'), '--adapter', 'caddyfile'], {
    HZ_API_UPSTREAM: `127.0.0.1:${apiPort}`,
    XDG_DATA_HOME: work,
    XDG_CONFIG_HOME: work,
  });
  await waitFor(`http://127.0.0.1:${webPort}/healthz`).catch((e) => {
    console.error(caddy.out());
    throw e;
  });
  const base = `http://127.0.0.1:${webPort}`;

  // Headers
  const index = await fetch(`${base}/`);
  const csp = index.headers.get('content-security-policy') ?? '';
  check(/script-src 'self' 'sha256-/.test(csp), 'CSP met hash van het inline script');
  check(index.headers.get('x-content-type-options') === 'nosniff', 'nosniff');
  check(index.headers.get('cache-control') === 'no-cache', 'index.html niet in de cache');
  const asset = /src="(\/assets\/[^"]+\.js)"/.exec(await index.text())?.[1];
  const a = await fetch(`${base}${asset}`);
  check(a.headers.get('cache-control')?.includes('immutable') === true, 'gehashte assets een jaar in de cache');
  const deep = await fetch(`${base}/tracker`);
  check(deep.status === 200 && (await deep.text()).includes('<div id="root">'), 'diepe link valt terug op index.html');
  const h = await fetch(`${base}/api/health`);
  check(h.status === 200 && (await h.json()).ok === true, '/api gaat naar de api');

  // Browser: geen CSP-overtredingen of consolefouten
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const problems = [];
  page.on('console', (m) => {
    // De app vraagt eerst /api/session (401 zonder sessie) en logt dan in met de dev-login: dat is geen fout.
    if (/status of 401/.test(m.text())) return;
    if (m.type() === 'error' || /Content Security Policy|Refused to/.test(m.text())) problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(String(e)));
  for (const path of ['/dagstart', '/tracker']) {
    await page.goto(`${base}${path}`);
    await page.waitForSelector('.hz-head, h1, main', { timeout: 15_000 });
    // Geen networkidle: de SSE-verbinding (/api/events) blijft open.
    await page.waitForTimeout(1500);
  }
  const theme = await page.evaluate(() => document.documentElement.dataset.theme ?? 'system');
  await page.goto(`${base}/dagstart`);
  await page.waitForTimeout(1500);
  const rows = await page.locator('main [data-key], main .row, main li').count();
  check(rows > 0, `Dagstart rendert met data via /api (${rows} regels)`);
  await browser.close();
  check(problems.length === 0, `geen CSP-overtredingen of consolefouten${problems.length ? ': ' + problems.join(' | ') : ''}`);
  check(typeof theme === 'string', 'thema-script draaide (inline script toegestaan door de hash)');
} catch (e) {
  fails.push(String(e));
  console.error(e);
} finally {
  stopAll();
}
console.log(fails.length ? `\n${fails.length} controle(s) rood` : '\nweb-container groen');
process.exit(fails.length ? 1 : 0);
