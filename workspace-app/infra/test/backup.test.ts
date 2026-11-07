/**
 * HZW-008: back-up en hersteltest tegen de echte lokale Postgres (16). Een database met het echte schema
 * (migraties, RLS) en rijen via de app zelf (DbStore als app-login), dan:
 * back-up (pg_dump als hz_backup -> age -> "Storage Box" = lokale map), herstel in een lege database, rijen tellen.
 */
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbStore } from '@hz/api/store';
import { runMigrations } from '@hz/db';
import { cleanupRoles } from './global-setup';
import {
  adminUrl,
  ageKeys,
  dbUrl,
  DEV_URL,
  dropDb,
  httpServer,
  INFRA,
  recreateDb,
  run,
  script,
  sql,
  tmp,
} from './helpers';

const DB = 'hz_e0_bk_src';
// Logins zoals stuk E2 ze wil: api (app), inloggen (auth), worker, index en pg-boss elk met een eigen login.
const ROLES = {
  migrator: 'hz_e0_bk_migrator',
  app: 'hz_e0_bk_app',
  backup: 'hz_e0_bk_backup',
  auth: 'hz_e0_bk_auth',
  worker: 'hz_e0_bk_worker',
  indexer: 'hz_e0_bk_indexer',
  boss: 'hz_e0_bk_boss',
};
const PW = Object.fromEntries(Object.keys(ROLES).map((k) => [k, randomBytes(12).toString('hex')])) as Record<
  keyof typeof ROLES,
  string
>;
/** Rolnamen en wachtwoorden voor hz-roles.sh en verhuis-proef.sh. */
const roleEnv = (withPasswords = true) => ({
  HZ_PG_MIGRATOR_ROLE: ROLES.migrator,
  HZ_PG_APP_ROLE: ROLES.app,
  HZ_PG_BACKUP_ROLE: ROLES.backup,
  HZ_PG_AUTH_ROLE: ROLES.auth,
  HZ_PG_WORKER_ROLE: ROLES.worker,
  HZ_PG_INDEXER_ROLE: ROLES.indexer,
  HZ_PG_BOSS_ROLE: ROLES.boss,
  ...(withPasswords
    ? {
        HZ_PG_MIGRATOR_PASSWORD: PW.migrator,
        HZ_PG_APP_PASSWORD: PW.app,
        HZ_PG_BACKUP_PASSWORD: PW.backup,
        HZ_PG_AUTH_PASSWORD: PW.auth,
        HZ_PG_WORKER_PASSWORD: PW.worker,
        HZ_PG_INDEXER_PASSWORD: PW.indexer,
        HZ_PG_BOSS_PASSWORD: PW.boss,
      }
    : {}),
});

let admin = '';
let backupDsn = '';
let ping: Awaited<ReturnType<typeof httpServer>>;
const dir = tmp('hz-e0-bk-');
const box = join(dir, 'storagebox');
const keys = ageKeys(join(dir, 'age'));

const backupEnv = (extra: Record<string, string> = {}) => ({
  HZ_BACKUP_TARGET: box,
  HZ_BACKUP_DSN: backupDsn,
  HZ_BACKUP_RECIPIENTS: keys.recipients,
  HZ_BACKUP_PREFIX: 'hz-e0-bk',
  HZ_BACKUP_PING_URL: `${ping.url}/backup`,
  ...extra,
});
const restoreEnv = (extra: Record<string, string> = {}) => ({
  HZ_BACKUP_TARGET: box,
  HZ_BACKUP_PREFIX: 'hz-e0-bk',
  HZ_AGE_IDENTITY: keys.key,
  HZ_RESTORE_ADMIN_DSN: DEV_URL,
  // Tellen moet door RLS heen: de back-uprol (BYPASSRLS, pg_read_all_data).
  HZ_RESTORE_COUNT_DSN: dbUrl(admin, 'postgres', ROLES.backup, PW.backup),
  HZ_RESTORE_DB_PREFIX: 'hz_e0_bk_hersteltest',
  HZ_RESTORE_PING_URL: `${ping.url}/herstel`,
  HZ_LOG_DIR: join(dir, 'log'),
  ...extra,
});

beforeAll(async () => {
  admin = await adminUrl();
  ping = await httpServer(() => ({ status: 200, body: 'OK' }));
  await recreateDb(admin, DB);
  const roles = await run(join(INFRA, 'postgres/hz-roles.sh'), [], {
    HZ_PSQL_ADMIN_URL: dbUrl(admin, DB),
    HZ_DB_NAME: DB,
    HZ_SQL_DIR: join(INFRA, '../packages/db/sql'),
    ...roleEnv(),
  });
  expect(roles.code, roles.all).toBe(0);
  await runMigrations(dbUrl(admin, DB, ROLES.migrator, PW.migrator));
  backupDsn = dbUrl(admin, DB, ROLES.backup, PW.backup);

  // Rijen via de app zelf, als app-login onder RLS binnen de sessie van elke collega; inloggen als auth-login (stuk E2).
  // Synthetische collega's, geen echte data.
  const store = new DbStore(dbUrl(admin, DB, ROLES.app, PW.app), dbUrl(admin, DB, ROLES.auth, PW.auth));
  try {
    for (const [email, name] of [
      ['test-a@homezero.nl', 'Test A'],
      ['test-b@homezero.nl', 'Test B'],
      ['test-c@homezero.nl', 'Test C'],
    ] as const) {
      const u = await store.ensureUser(email, name);
      const { token } = await store.createSession(u.id, 'vitest');
      await store.asSession(token, async () => {
        await store.setItemState(u.id, `slack:C1:${name}`, { read: true });
        await store.setItemState(u.id, `gmail:${name}`, { plan: '2026-11-09' });
        await store.addWeekdoel(u.id, { wat: `Weekdoel van ${name}`, week: '2026-W45' });
        await store.addPin(u.id, { kind: 'search', label: 'Solarwatt', q: 'Solarwatt, berekening' });
        await store.audit(u.id, 'test.seed');
      });
    }
  } finally {
    await store.close();
  }
});

afterAll(async () => {
  await ping?.close();
  if (admin) await dropDb(admin, DB);
});

describe('back-up (backup.sh)', () => {
  it('versleuteld met age, met controlesom, zonder leesbare gegevens; ping naar de uptime-dienst', async () => {
    const r = await run(script('backup.sh'), ['--label', 'handmatig'], backupEnv());
    expect(r.code, r.all).toBe(0);
    const name = r.out.trim();
    expect(name).toMatch(/^hz-e0-bk-\d{8}T\d{6}Z-handmatig\.dump\.age$/);
    expect(readdirSync(box).sort()).toEqual([name, `${name}.sha256`]);
    const enc = readFileSync(join(box, name));
    expect(enc.subarray(0, 22).toString()).toBe('age-encryption.org/v1\n');
    for (const plain of ['test-a@homezero.nl', 'Weekdoel van', 'Solarwatt', 'COPY public'])
      expect(enc.includes(Buffer.from(plain)), plain).toBe(false);
    expect(readFileSync(join(box, `${name}.sha256`), 'utf8')).toMatch(
      new RegExp(`^[0-9a-f]{64}  ${name.replace(/\./g, '\\.')}\\n$`),
    );
    const hit = ping.hits.find((h) => h.url === '/backup')!;
    expect(hit.body).toContain(name);
  });

  it('een dump als eigenaar faalt door FORCE ROW LEVEL SECURITY (daarom de rol hz_backup)', async () => {
    const r = await run('pg_dump', [
      '-Fc',
      '-f',
      '/dev/null',
      `--dbname=${dbUrl(admin, DB, ROLES.migrator, PW.migrator)}`,
    ]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('row-level security');
  });
});

describe('hersteltest (hersteltest.sh + restore.sh)', () => {
  it('herstel in een lege database: elke tabel evenveel rijen als in de back-up en als in de bron', async () => {
    const r = await run(script('hersteltest.sh'), ['latest'], restoreEnv());
    expect(r.code, r.all).toBe(0);
    expect(r.out).toMatch(/hersteltest groen: hz-e0-bk-.*\.dump\.age, \d+ tabellen, \d+ rijen/);
    const rows = Object.fromEntries(
      r.out
        .split('\n')
        .filter((l) => /^(public|drizzle)\./.test(l))
        .map((l) => {
          const [t, a, b] = l.trim().split(/\s+/);
          expect(a, t).toBe(b);
          return [t!, Number(b)];
        }),
    );
    // Zelfde aantallen als de bron, gelezen door de back-uprol.
    for (const t of ['users', 'sessions', 'item_state', 'weekdoelen', 'pins', 'audit_log']) {
      const [{ n }] = (await sql<{ n: string }>(backupDsn, `SELECT count(*)::text AS n FROM public.${t}`)) as [
        { n: string },
      ];
      expect(rows[`public.${t}`], t).toBe(Number(n));
      expect(Number(n), t).toBeGreaterThan(0);
    }
    expect(rows['public.users']).toBe(3);
    // De tijdelijke database is weer weg.
    const left = await sql<{ datname: string }>(
      admin,
      "SELECT datname FROM pg_database WHERE datname LIKE 'hz_e0_bk_hersteltest%'",
    );
    expect(left).toEqual([]);
    expect(ping.hits.some((h) => h.url === '/herstel' && h.body.startsWith('hersteltest groen'))).toBe(true);
    expect(readFileSync(join(dir, 'log/hersteltest.log'), 'utf8')).toMatch(/ groen hersteltest groen: /);
  });

  it('beschadigde back-up: controlesom klopt niet, hersteltest rood, melding naar /fail', async () => {
    const name = readdirSync(box).find((f) => f.endsWith('.dump.age'))!;
    const bad = join(dir, 'kapot');
    mkdirSync(bad, { recursive: true });
    copyFileSync(join(box, `${name}.sha256`), join(bad, `${name}.sha256`));
    const buf = readFileSync(join(box, name));
    buf[Math.floor(buf.length / 2)]! ^= 0xff;
    writeFileSync(join(bad, name), buf);
    ping.hits.length = 0;
    const r = await run(script('hersteltest.sh'), ['latest'], restoreEnv({ HZ_BACKUP_TARGET: bad }));
    expect(r.code).toBe(1);
    expect(r.err).toContain('controlesom klopt niet');
    expect(ping.hits.map((h) => h.url)).toEqual(['/herstel/fail']);
  });

  it('een andere sleutel kan de back-up niet openen', async () => {
    const other = ageKeys(join(dir, 'ander'));
    const r = await run(script('hersteltest.sh'), ['latest'], restoreEnv({ HZ_AGE_IDENTITY: other.key }));
    expect(r.code).toBe(1);
    expect(r.err).toContain('ontsleutelen mislukt');
  });
});

describe('bewaartermijn (30 dagen, de 7 nieuwste blijven altijd)', () => {
  it('ruimt verlopen back-ups op, houdt recente', async () => {
    const target = join(dir, 'bewaar');
    mkdirSync(target, { recursive: true });
    const stamp = (daysAgo: number) => {
      const d = new Date(Date.now() - daysAgo * 864e5);
      return d
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}/, '');
    };
    const names: Record<string, string> = {};
    for (const d of [1, 2, 3, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49]) {
      const n = `hz-e0-bk-${stamp(d)}-nightly.dump.age`;
      names[d] = n;
      writeFileSync(join(target, n), 'x');
      writeFileSync(join(target, `${n}.sha256`), 'x');
    }
    writeFileSync(join(target, 'iets-anders.txt'), 'blijft');
    const r = await run(script('backup.sh'), [], backupEnv({ HZ_BACKUP_TARGET: target }));
    expect(r.code, r.all).toBe(0);
    const left = readdirSync(target).filter((f) => f.endsWith('.dump.age'));
    const expected = [r.out.trim(), ...[1, 2, 3, 40, 41, 42].map((d) => names[d]!)];
    expect(left.sort()).toEqual(expected.sort());
    expect(readdirSync(target)).toContain('iets-anders.txt');
    expect(readdirSync(target).filter((f) => f.endsWith('.sha256'))).toHaveLength(7);
  });
});

describe('opruimen na de tests (rollen zijn clusterbreed)', () => {
  it('cleanupRoles haalt hz_e0_-rollen weg, ook met rechten op een database; andere rollen blijven', async () => {
    const admin = await adminUrl();
    const db = 'hz_e0_opruim_db';
    await recreateDb(admin, db);
    await sql(admin, 'CREATE ROLE hz_e0_opruim_a LOGIN');
    await sql(admin, 'CREATE ROLE hz_e0_opruim_b NOLOGIN');
    await sql(admin, `GRANT CONNECT ON DATABASE ${db} TO hz_e0_opruim_a`);
    try {
      expect(await cleanupRoles(admin, false, 'hz_e0_opruim_')).toEqual([]);
      const left = await sql<{ rolname: string }>(
        admin,
        "select rolname from pg_roles where rolname like 'hz_e0_opruim%'",
      );
      expect(left).toEqual([]);
      // De vaste rollen van het fundament en hz_dev blijven staan.
      const kept = await sql<{ n: string }>(
        admin,
        "select count(*) as n from pg_roles where rolname in ('hz_dev', 'hz_app')",
      );
      expect(Number(kept[0]!.n)).toBe(2);
      await expect(cleanupRoles(admin, false, 'hz_')).rejects.toThrow(/eigen rollen/);
    } finally {
      await dropDb(admin, db);
    }
  });
});
