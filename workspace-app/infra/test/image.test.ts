/**
 * De inhoud van de images zonder Docker (Docker draait hier niet; de workflow workspace-infra bouwt ze echt):
 * build-app.sh is precies wat de Dockerfiles draaien. Daarna de gebouwde API in productiemodus:
 * weigert zonder secrets (HZW-006), draait als app-login met JSON-logs zonder persoonsgegevens (HZW-007),
 * en de proefverhuizing naar een tweede database en domein (HZW-082).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbStore } from '@hz/api/store';
import { runMigrations } from '@hz/db';
import { inlineScriptHashes } from '../docker/web-csp.mjs';
import {
  adminUrl,
  APP,
  freePort,
  dbUrl,
  dropDb,
  INFRA,
  recreateDb,
  run,
  script,
  sql,
  startProcess,
  tmp,
} from './helpers';

const out = tmp('hz-e0-img-');
const apiDir = join(out, 'api');
const workerDir = join(out, 'worker');

const SRC = 'hz_e0_vh_src';
const NEW = 'hz_e0_vh_new';
const ROLES = { migrator: 'hz_e0_vh_migrator', app: 'hz_e0_vh_app', backup: 'hz_e0_vh_backup' };
const PW = {
  migrator: randomBytes(12).toString('hex'),
  app: randomBytes(12).toString('hex'),
  backup: randomBytes(12).toString('hex'),
};
let admin = '';

beforeAll(async () => {
  const a = await run(join(INFRA, 'docker/build-app.sh'), ['api', apiDir]);
  expect(a.code, a.all).toBe(0);
  const w = await run(join(INFRA, 'docker/build-app.sh'), ['worker', workerDir]);
  expect(w.code, w.all).toBe(0);

  admin = await adminUrl();
  await recreateDb(admin, SRC);
  const roles = await run(join(apiDir, 'bundle/infra/postgres/hz-roles.sh'), [], {
    HZ_PSQL_ADMIN_URL: dbUrl(admin, SRC),
    HZ_DB_NAME: SRC,
    HZ_SQL_DIR: join(apiDir, 'bundle/packages/db/sql'),
    HZ_PG_MIGRATOR_ROLE: ROLES.migrator,
    HZ_PG_APP_ROLE: ROLES.app,
    HZ_PG_BACKUP_ROLE: ROLES.backup,
    HZ_PG_MIGRATOR_PASSWORD: PW.migrator,
    HZ_PG_APP_PASSWORD: PW.app,
    HZ_PG_BACKUP_PASSWORD: PW.backup,
  });
  expect(roles.code, roles.all).toBe(0);
});

afterAll(async () => {
  if (!admin) return;
  await dropDb(admin, SRC);
  await dropDb(admin, NEW);
});

describe('inhoud van de images (build-app.sh, HZW-004)', () => {
  it('api: gebundelde code, migraties, beheeropdrachten en de uitrolbundel; geen bron, tests of ontwikkelpakketten', () => {
    for (const f of [
      'dist/index.js',
      'dist/migrate.js',
      'dist/ops-cli.js',
      'drizzle/meta/_journal.json',
      'package.json',
    ])
      expect(existsSync(join(apiDir, f)), f).toBe(true);
    for (const f of [
      'infra/compose/app.yaml',
      'infra/caddy/Caddyfile',
      'infra/scripts/deploy.sh',
      'infra/postgres/hz-roles.sh',
      'packages/db/sql/bootstrap-roles.sql',
    ])
      expect(existsSync(join(apiDir, 'bundle', f)), f).toBe(true);
    expect(existsSync(join(apiDir, 'bundle/infra/test'))).toBe(false);
    expect(existsSync(join(apiDir, 'src'))).toBe(false);
    expect(existsSync(join(apiDir, 'test'))).toBe(false);
    const mods = readdirSync(join(apiDir, 'node_modules'));
    expect(mods).toEqual(expect.arrayContaining(['hono', 'pg', 'drizzle-orm', 'zod']));
    for (const dev of ['vitest', 'typescript', 'tsup', 'tsx', '@playwright']) expect(mods, dev).not.toContain(dev);
    // Alle SQL-migraties gaan mee.
    const sqlFiles = readdirSync(join(APP, 'packages/db/drizzle')).filter((f) => f.endsWith('.sql'));
    expect(
      readdirSync(join(apiDir, 'drizzle'))
        .filter((f) => f.endsWith('.sql'))
        .sort(),
    ).toEqual(sqlFiles.sort());
  });

  it('worker: gebundelde code en de healthcheck op de hartslag', async () => {
    expect(existsSync(join(workerDir, 'dist/index.js'))).toBe(true);
    expect(readdirSync(join(workerDir, 'node_modules'))).toContain('pg-boss');
    const hb = join(out, 'alive');
    const ok = () => run('node', [join(workerDir, 'dist/ops-cli.js'), 'heartbeat-ok'], { HZ_WORKER_HEARTBEAT: hb });
    expect((await ok()).code).toBe(1); // nog geen hartslag
    writeFileSync(hb, String(Date.now()));
    expect((await ok()).code).toBe(0);
    const old = Date.now() / 1000 - 300;
    utimesSync(hb, old, old);
    expect((await ok()).code).toBe(1); // hangt
  });

  it('web: de CSP-hash klopt met het inline script in de gebouwde index.html', async () => {
    const b = await run('pnpm', ['--filter', '@hz/web', 'build'], {}, undefined);
    expect(b.code, b.all).toBe(0);
    const html = readFileSync(join(APP, 'apps/web/dist/index.html'), 'utf8');
    const csp = join(out, 'csp.caddy');
    expect(
      (await run('node', [join(INFRA, 'docker/web-csp.mjs'), join(APP, 'apps/web/dist/index.html'), csp])).code,
    ).toBe(0);
    const [hash] = inlineScriptHashes(html);
    expect(hash).toMatch(/^'sha256-[A-Za-z0-9+/]{43}='$/);
    expect(readFileSync(csp, 'utf8')).toContain(`script-src 'self' ${hash}`);
    expect(html).toMatch(/<script type="module" crossorigin src="\/assets\/index-[\w-]+\.js"><\/script>/);
  });
});

describe('API in productiemodus (HZW-006, HZW-007)', () => {
  const start = (env: Record<string, string>) =>
    run('node', [join(apiDir, 'dist/index.js')], { NODE_ENV: 'production', HZ_LOG_FORMAT: 'json', ...env });

  it('weigert te starten zonder verplichte secrets en noemt wat er mist', async () => {
    const r = await start({});
    expect(r.code).toBe(1);
    const line = JSON.parse(r.out.trim().split('\n').pop()!);
    expect(line).toMatchObject({ level: 'error', svc: 'api' });
    for (const k of ['DATABASE_URL', 'HZ_TOKEN_KEY', 'HZ_STORE=db']) expect(line.msg).toContain(k);
  });

  it('weigert een hoofdsleutel van de verkeerde lengte en dev-login in productie', async () => {
    const base = { HZ_STORE: 'db', DATABASE_URL: 'postgres://x@127.0.0.1:1/x' };
    const short = await start({ ...base, HZ_TOKEN_KEY: Buffer.alloc(16).toString('base64') });
    expect(short.code).toBe(1);
    expect(short.out).toContain('HZ_TOKEN_KEY');
    const dev = await start({ ...base, HZ_TOKEN_KEY: randomBytes(32).toString('base64'), HZ_DEV_LOGIN: '1' });
    expect(dev.code).toBe(1);
    expect(dev.out).toContain('HZ_DEV_LOGIN mag niet aan in productie');
  });

  it('draait als app-login op de gemigreerde database: health groen, JSON-logs zonder persoonsgegevens', async () => {
    const mig = await run('node', [join(apiDir, 'dist/migrate.js')], {
      DATABASE_URL: dbUrl(admin, SRC, ROLES.migrator, PW.migrator),
    });
    expect(mig.code, mig.all).toBe(0);
    const port = String(await freePort());
    const p = startProcess(
      'node',
      ['dist/index.js'],
      {
        NODE_ENV: 'production',
        HZ_LOG_FORMAT: 'json',
        HZ_STORE: 'db',
        DATABASE_URL: dbUrl(admin, SRC, ROLES.app, PW.app),
        HZ_TOKEN_KEY: randomBytes(32).toString('base64'),
        HZ_API_HOST: '127.0.0.1',
        HZ_API_PORT: port,
        HZ_PUBLIC_URL: 'https://homezero.verveen.me',
        // Vereist zodra het inlog-stuk (E1) is samengevoegd; hier alleen nep-waarden, er gaat niets naar Google.
        HZ_AUTH_SECRET: randomBytes(32).toString('base64'),
        HZ_GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
        HZ_GOOGLE_CLIENT_SECRET: 'test-geheim',
      },
      apiDir,
    );
    try {
      let health = '';
      for (let i = 0; i < 50 && !health; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/api/health`);
          health = await r.text();
        } catch {
          await new Promise((ok) => setTimeout(ok, 200));
        }
      }
      expect(JSON.parse(health)).toMatchObject({ ok: true, db: 'ok' });
      const s = await fetch(`http://127.0.0.1:${port}/api/users/test-a@homezero.nl?token=geheim`, {
        headers: { 'user-agent': 'Mozilla/5.0 Test' },
      });
      expect(s.status).toBeGreaterThanOrEqual(400);
      await new Promise((ok) => setTimeout(ok, 100));
    } finally {
      await p.stop();
    }
    const lines = p
      .output()
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.some((l) => l.msg === 'request' && l.path === '/api/health' && l.status === 200)).toBe(true);
    expect(lines.some((l) => l.msg === 'request' && l.path === '/api/users/:email')).toBe(true);
    expect(p.output()).not.toMatch(/homezero\.nl|Mozilla|geheim|hz_e0_vh_app/);
    // Draaide echt als app-login (geen eigenaar, geen BYPASSRLS).
    const [r] = (await sql<{ rolbypassrls: boolean; rolsuper: boolean }>(
      admin,
      'SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = $1',
      [ROLES.app],
    )) as [{ rolbypassrls: boolean; rolsuper: boolean }];
    expect(r).toEqual({ rolbypassrls: false, rolsuper: false });
  });
});

describe('proefverhuizing (verhuis-proef.sh, HZW-082)', () => {
  it('back-up -> nieuwe database met rollen -> herstel met rechten -> zelfde rijen -> API groen op het nieuwe domein', async () => {
    await runMigrations(dbUrl(admin, SRC, ROLES.migrator, PW.migrator));
    const store = new DbStore(dbUrl(admin, SRC, ROLES.app, PW.app));
    try {
      for (const e of ['verhuis-a@homezero.nl', 'verhuis-b@homezero.nl']) {
        const u = await store.ensureUser(e, e.split('@')[0]!);
        await store.addWeekdoel(u.id, { wat: 'Proefverhuizing', week: '2026-W45' });
        await store.savePreferences(u.id, { theme: 'dark' });
      }
    } finally {
      await store.close();
    }
    const r = await run(script('verhuis-proef.sh'), [], {
      HZ_PSQL_ADMIN_URL: admin,
      HZ_VERHUIS_SRC_DSN: dbUrl(admin, SRC, ROLES.backup, PW.backup),
      HZ_VERHUIS_DOMAIN: 'workspace.homezero.nl',
      HZ_VERHUIS_API_DIR: apiDir,
      HZ_VERHUIS_NEW_DB: NEW,
      HZ_SQL_DIR: join(apiDir, 'bundle/packages/db/sql'),
      HZ_PG_MIGRATOR_ROLE: ROLES.migrator,
      HZ_PG_APP_ROLE: ROLES.app,
      HZ_PG_BACKUP_ROLE: ROLES.backup,
      HZ_AUTH_SECRET: randomBytes(32).toString('base64'),
      HZ_GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
      HZ_GOOGLE_CLIENT_SECRET: 'test-geheim',
    });
    expect(r.code, r.all).toBe(0);
    expect(r.out).toMatch(
      /proefverhuizing groen: hz-verhuis-.*\.dump\.age -> hz_e0_vh_new, \d+ rijen, https:\/\/workspace\.homezero\.nl/,
    );
    expect(r.out).toContain('"db":"ok"');
    const table = r.out.split('\n').filter((l) => /^(public|drizzle)\./.test(l));
    expect(table.length).toBeGreaterThanOrEqual(10);
    for (const l of table) {
      const [, a, b, c] = l.trim().split(/\s+/);
      expect(new Set([a, b, c]).size, l).toBe(1);
    }
    expect(table.find((l) => l.startsWith('public.users'))!.split(/\s+/)[3]).toBe('2');
    // Zonder HZ_VERHUIS_KEEP is de proefdatabase weer weg.
    expect(await sql(admin, 'SELECT 1 FROM pg_database WHERE datname = $1', [NEW])).toEqual([]);
  });
});
