/**
 * De beheerscripts echt gedraaid, met nep-docker, lokale HTTP/TLS-servers en tijdelijke mappen:
 * uitrol met health-check en rollback (HZW-004), preview per PR (HZW-005), secrets met age (HZW-006),
 * servercontrole (HZW-002), TLS en doorsturen (HZW-003), uptime-hartslag (HZW-007), forced command voor CI.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer as createHttps } from 'node:https';
import { createServer as createHttp, type Server } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { renderCloudInit } from '../cloud-init/render.mjs';
import { ageKeys, fakeDocker, has, httpServer, INFRA, run, script, sshPublicKey, tmp } from './helpers';

const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);

describe('scripts: syntaxis en shellcheck', () => {
  const dirs = ['scripts', 'postgres', 'docker'].map((d) => join(INFRA, d));
  const files = dirs.flatMap((d) =>
    readdirSync(d)
      .filter((f) => f.endsWith('.sh'))
      .map((f) => join(d, f)),
  );

  it('bash -n op elk script', async () => {
    expect(files.length).toBeGreaterThanOrEqual(17);
    for (const f of files) expect((await run('bash', ['-n', f])).code, f).toBe(0);
  });

  it('shellcheck zonder bevindingen', async () => {
    expect(has('shellcheck'), 'shellcheck moet geïnstalleerd zijn (CI: apt-get install shellcheck)').toBe(true);
    const r = await run('sh', [
      '-c',
      `cd ${join(INFRA, 'scripts')} && shellcheck -x *.sh && shellcheck -x ../postgres/*.sh ../docker/*.sh`,
    ]);
    expect(r.all).toBe('');
    expect(r.code).toBe(0);
  });
});

/** Een server-opzet in een tijdelijke map: /etc/hz, /opt/hz, /run/hz en een uitrolbundel met test-secrets. */
async function serverFixture(opts: { missing?: string[] } = {}) {
  const root = tmp('hz-e0-srv-');
  const etc = join(root, 'etc');
  const bundle = join(root, 'bundle');
  mkdirSync(etc, { recursive: true });
  writeFileSync(
    join(etc, 'hz.env'),
    'HZ_DOMAIN=hz.example.nl\nHZ_TEST_DOMAIN=test.hz.example.nl\nHZ_ERRORS_DOMAIN=fouten.hz.example.nl\nHZ_ACME_EMAIL=ops@example.nl\nHZ_REGISTRY=ghcr.io/homezerotech\n',
  );
  for (const d of ['scripts', 'compose', 'caddy', 'postgres'])
    cpSync(join(INFRA, d), join(bundle, 'infra', d), { recursive: true });
  mkdirSync(join(bundle, 'infra/secrets'), { recursive: true });
  for (const f of ['prod.keys', 'test.keys', 'server.keys'])
    cpSync(join(INFRA, 'secrets', f), join(bundle, 'infra/secrets', f));
  const keys = ageKeys(join(root, 'age'));
  const env = {
    HZ_ROOT: join(root, 'opt'),
    HZ_ETC: etc,
    HZ_RUN: join(root, 'run'),
    HZ_LOG_DIR: join(root, 'log'),
    HZ_AGE_IDENTITY: keys.key,
    HZ_SECRETS_DIR: join(bundle, 'infra/secrets'),
    HZ_AGE_RECIPIENTS_FILE: keys.recipients,
  };
  // Secrets voor test en prod via secrets.sh zelf: gen vult de machine-geheimen, set de rest.
  for (const scope of ['test', 'prod']) {
    expect((await run(script('secrets.sh'), ['gen', scope], env)).code).toBe(0);
    for (const k of ['HZ_GOOGLE_CLIENT_ID', 'HZ_GOOGLE_CLIENT_SECRET'])
      if (!opts.missing?.includes(k))
        expect((await run(script('secrets.sh'), ['set', scope, k], env, `waarde-${k}\n`)).code).toBe(0);
  }
  return { root, bundle, env, keys };
}

describe('uitrol (deploy.sh, HZW-004)', () => {
  let health: Awaited<ReturnType<typeof httpServer>>;
  let healthy = true;
  beforeAll(async () => {
    health = await httpServer(() =>
      healthy
        ? { status: 200, body: '{"ok":true,"version":"0.1.0","mode":"live","db":"ok"}' }
        : { status: 200, body: '{"ok":true,"db":"error"}' },
    );
  });
  afterAll(() => health.close());
  beforeEach(() => {
    healthy = true;
  });

  async function setup(opts: { missing?: string[] } = {}) {
    const s = await serverFixture(opts);
    const docker = fakeDocker(join(s.root, 'bin'));
    const env = {
      ...s.env,
      HZ_DOCKER: docker.bin,
      HZ_HEALTH_URL: `${health.url}/api/health`,
      HZ_HEALTH_TRIES: '2',
      HZ_HEALTH_SLEEP: '0',
    };
    const deploy = (e: string, tag: string, extra: Record<string, string> = {}) =>
      run(join(s.bundle, 'infra/scripts/deploy.sh'), [e, tag], { ...env, ...extra });
    const state = (e: string, f: string) => {
      const p = join(s.env.HZ_ROOT, 'env', e, f);
      return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
    };
    return { ...s, docker, deploy, state };
  }

  it('eerste uitrol naar test: secrets alleen in /run (0600), edge erbij, migraties, containers, health groen, vastgelegd', async () => {
    const t = await setup();
    const r = await t.deploy('test', 'sha-aaaaaaa');
    expect(r.code, r.all).toBe(0);
    expect(t.state('test', 'current')).toBe('sha-aaaaaaa');
    expect(t.state('test', 'previous')).toBeNull();
    const calls = t.docker.calls();
    const idx = (re: RegExp) => calls.findIndex((c) => re.test(c));
    expect(idx(/^network create hz-edge/)).toBeGreaterThan(-1);
    expect(idx(/compose -p hz-edge .* up -d --wait/)).toBeGreaterThan(-1);
    expect(idx(/compose -p hz-edge .* exec -T caddy caddy reload/)).toBeGreaterThan(-1);
    const pull = idx(/compose -p hz-test .* pull --quiet/);
    const migrate = idx(/compose -p hz-test .* run --rm migrate/);
    const up = idx(/compose -p hz-test .* up -d --remove-orphans --wait/);
    expect(pull).toBeGreaterThan(-1);
    expect(migrate).toBeGreaterThan(pull);
    expect(up).toBeGreaterThan(migrate);
    expect(calls[up]).toContain('tag=sha-aaaaaaa instance=hz-test env=test url=https://test.hz.example.nl');
    // api en worker krijgen geen databasewachtwoorden
    const appEnv = readFileSync(join(t.env.HZ_RUN, 'test.app.env'), 'utf8');
    expect(appEnv).toMatch(/^HZ_TOKEN_KEY=/m);
    expect(appEnv).not.toMatch(/HZ_PG_/);
    expect(mode(join(t.env.HZ_RUN, 'test.env'))).toBe('600');
    expect(readFileSync(join(t.env.HZ_ROOT, 'edge/Caddyfile'), 'utf8')).toBe(
      readFileSync(join(INFRA, 'caddy/Caddyfile'), 'utf8'),
    );
    expect(readFileSync(join(t.env.HZ_LOG_DIR, 'deploys.log'), 'utf8')).toMatch(/ test sha-aaaaaaa - ok\n$/);
  });

  it('tweede uitrol: vorige versie bewaard, Caddy niet onnodig herladen', async () => {
    const t = await setup();
    expect((await t.deploy('test', 'sha-aaaaaaa')).code).toBe(0);
    const before = t.docker.calls().length;
    const r = await t.deploy('test', 'sha-bbbbbbb');
    expect(r.code, r.all).toBe(0);
    expect(t.state('test', 'current')).toBe('sha-bbbbbbb');
    expect(t.state('test', 'previous')).toBe('sha-aaaaaaa');
    expect(
      t.docker
        .calls()
        .slice(before)
        .some((c) => c.includes('caddy reload')),
    ).toBe(false);
  });

  it('containers worden niet gezond: terug naar de vorige versie, uitrol rood', async () => {
    const t = await setup();
    expect((await t.deploy('test', 'sha-bbbbbbb')).code).toBe(0);
    const r = await t.deploy('test', 'sha-ccccccc', { FAKE_DOCKER_FAIL_UP_TAG: 'sha-ccccccc' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('uitrol sha-ccccccc mislukt; sha-bbbbbbb draait weer');
    const ups = t.docker.calls().filter((c) => /compose -p hz-test .* up -d/.test(c));
    expect(ups.slice(-2).map((c) => /tag=(\S+)/.exec(c)![1])).toEqual(['sha-ccccccc', 'sha-bbbbbbb']);
    expect(t.state('test', 'current')).toBe('sha-bbbbbbb');
    expect(readFileSync(join(t.env.HZ_LOG_DIR, 'deploys.log'), 'utf8')).toMatch(
      /sha-ccccccc sha-bbbbbbb mislukt\n.*sha-bbbbbbb sha-ccccccc teruggezet\n$/,
    );
  });

  it('health-check via https rood: ook terug, en zonder vorige versie geen stille groen', async () => {
    const t = await setup();
    healthy = false;
    const r = await t.deploy('test', 'sha-ddddddd');
    expect(r.code).toBe(1);
    expect(r.err).toContain('health-check rood');
    expect(r.err).toContain('geen vorige versie');
    expect(t.state('test', 'current')).toBeNull();
  });

  it('weigert zonder verplichte secrets, vóór er iets aan de containers verandert', async () => {
    const t = await setup({ missing: ['HZ_GOOGLE_CLIENT_SECRET'] });
    const r = await t.deploy('test', 'sha-aaaaaaa');
    expect(r.code).toBe(1);
    expect(r.err).toContain('verplichte secrets ontbreken in test: HZ_GOOGLE_CLIENT_SECRET');
    expect(t.docker.calls()).toEqual([]);
  });

  it('productie: eerst een back-up; lukt die niet, dan stopt de uitrol vóór de migratie', async () => {
    const t = await setup();
    expect((await t.deploy('prod', 'v1.0.0', { HZ_SKIP_PREDEPLOY_BACKUP: '1' })).code).toBe(0);
    const before = t.docker.calls().length;
    const r = await t.deploy('prod', 'v1.1.0'); // geen HZ_BACKUP_TARGET in server.env: back-up faalt
    expect(r.code).toBe(1);
    expect(r.err).toContain('back-up vóór uitrol mislukt; uitrol gestopt');
    expect(
      t.docker
        .calls()
        .slice(before)
        .some((c) => /compose -p hz-prod .* (run|up)/.test(c)),
    ).toBe(false);
    expect(t.state('prod', 'current')).toBe('v1.0.0');
  });

  it('weigert onbekende omgevingen en tags', async () => {
    const t = await setup();
    expect((await t.deploy('staging', 'sha-aaaaaaa')).err).toContain('prod of test');
    expect((await t.deploy('test', 'latest')).err).toContain('ongeldige tag');
    expect((await t.deploy('test', 'sha-aaaaaaa;reboot')).code).toBe(1);
  });
});

describe('preview per pull request (preview.sh, HZW-005)', () => {
  async function setup(extra: Record<string, string> = {}) {
    const s = await serverFixture();
    const docker = fakeDocker(join(s.root, 'bin'));
    const env = { ...s.env, HZ_DOCKER: docker.bin, ...extra };
    const pv = (...a: string[]) => run(join(s.bundle, 'infra/scripts/preview.sh'), a, env);
    const dir = (nr: number) => join(s.env.HZ_ROOT, 'previews', `pr-${nr}`);
    const allow = (nr: number) => join(s.env.HZ_ROOT, 'previews/allow', `pr-${nr}.test.hz.example.nl`);
    return { ...s, docker, pv, dir, allow, env };
  }

  it('up: eigen database-wachtwoorden (0600), demodata met dev-login, health in de instantie, daarna pas TLS-aanmelding', async () => {
    const t = await setup();
    const r = await t.pv('up', '12', 'pr-12-abcdef123456');
    expect(r.code, r.all).toBe(0);
    expect(r.out.trim()).toBe('https://pr-12.test.hz.example.nl');
    expect(mode(join(t.dir(12), '.env'))).toBe('600');
    const env = readFileSync(join(t.dir(12), '.env'), 'utf8');
    for (const k of [
      'HZ_PG_SUPERUSER_PASSWORD',
      'HZ_PG_MIGRATOR_PASSWORD',
      'HZ_PG_APP_PASSWORD',
      'HZ_PG_BACKUP_PASSWORD',
    ])
      expect(env).toMatch(new RegExp(`^${k}=[0-9a-f]{48}$`, 'm'));
    expect(readFileSync(join(t.dir(12), 'app.env'), 'utf8')).toMatch(/^HZ_TOKEN_KEY=.{44}$/m);
    const up = t.docker.calls().find((c) => /compose -p hz-pr-12 .* up -d/.test(c))!;
    expect(up).toContain(
      'tag=pr-12-abcdef123456 instance=hz-pr-12 env=preview url=https://pr-12.test.hz.example.nl node_env=development devlogin=1',
    );
    expect(t.docker.calls().some((c) => /compose -p hz-pr-12 .* exec -T web wget .*\/api\/health/.test(c))).toBe(true);
    expect(existsSync(t.allow(12))).toBe(true);
    expect(readFileSync(join(t.dir(12), 'tag'), 'utf8').trim()).toBe('pr-12-abcdef123456');
  });

  it('bijwerken houdt dezelfde database (zelfde wachtwoorden)', async () => {
    const t = await setup();
    expect((await t.pv('up', '12', 'pr-12-abcdef123456')).code).toBe(0);
    const before = readFileSync(join(t.dir(12), '.env'), 'utf8');
    expect((await t.pv('up', '12', 'pr-12-fedcba654321')).code).toBe(0);
    expect(readFileSync(join(t.dir(12), '.env'), 'utf8')).toBe(before);
  });

  it('niet gezond: geen certificaat-aanmelding en rood', async () => {
    const t = await setup({ FAKE_DOCKER_HEALTH: '{"ok":true,"db":"error"}' });
    const r = await t.pv('up', '13', 'pr-13-abcdef123456');
    expect(r.code).toBe(1);
    expect(existsSync(t.allow(13))).toBe(false);
  });

  it('down: containers en database weg (down -v), aanmelding en map weg', async () => {
    const t = await setup();
    expect((await t.pv('up', '12', 'pr-12-abcdef123456')).code).toBe(0);
    const r = await t.pv('down', '12');
    expect(r.code, r.all).toBe(0);
    expect(t.docker.calls().some((c) => /compose -p hz-pr-12 .* down -v --remove-orphans/.test(c))).toBe(true);
    expect(existsSync(t.dir(12))).toBe(false);
    expect(existsSync(t.allow(12))).toBe(false);
  });

  it('maximum aantal previews: de oudste gaat eruit', async () => {
    const t = await setup({ HZ_PREVIEW_MAX: '2' });
    expect((await t.pv('up', '1', 'pr-1-aaaaaaa')).code).toBe(0);
    const old = Date.now() / 1000 - 3600;
    utimesSync(t.dir(1), old, old);
    expect((await t.pv('up', '2', 'pr-2-bbbbbbb')).code).toBe(0);
    const r = await t.pv('up', '3', 'pr-3-ccccccc');
    expect(r.code, r.all).toBe(0);
    expect(r.err).toContain('pr-1 wordt opgeruimd');
    expect([1, 2, 3].map((n) => existsSync(t.dir(n)))).toEqual([false, true, true]);
    expect((await t.pv('list')).out).toBe('pr-2 pr-2-bbbbbbb\npr-3 pr-3-ccccccc\n');
  });

  it('weigert ongeldige nummers en tags', async () => {
    const t = await setup();
    expect((await t.pv('up', '12a', 'pr-12-abcdef1')).code).toBe(1);
    expect((await t.pv('up', '12', 'main')).code).toBe(1);
    expect((await t.pv('down', '../x')).code).toBe(1);
  });
});

describe('forced command voor GitHub Actions (hz-ssh-dispatch)', () => {
  async function setup() {
    const root = tmp('hz-e0-disp-');
    const etc = join(root, 'etc');
    mkdirSync(etc);
    writeFileSync(join(etc, 'hz.env'), 'HZ_DOMAIN=hz.example.nl\nHZ_REGISTRY=ghcr.io/homezerotech\n');
    // Nep-bundel: deploy.sh en preview.sh schrijven alleen op hoe ze werden aangeroepen.
    const bundle = join(root, 'bundle');
    mkdirSync(join(bundle, 'infra/scripts'), { recursive: true });
    for (const s of ['deploy.sh', 'preview.sh'])
      writeFileSync(
        join(bundle, 'infra/scripts', s),
        `#!/usr/bin/env bash\necho "${s} $* cfg=\${DOCKER_CONFIG:-}" >> "${root}/called"\n`,
        { mode: 0o755 },
      );
    const docker = fakeDocker(join(root, 'bin'));
    const env = { HZ_ROOT: join(root, 'opt'), HZ_ETC: etc, HZ_DOCKER: docker.bin, FAKE_DOCKER_BUNDLE: bundle };
    const ssh = (cmd: string, stdin = '') =>
      run(script('hz-ssh-dispatch.sh'), [], { ...env, SSH_ORIGINAL_COMMAND: cmd }, stdin);
    const called = () => (existsSync(join(root, 'called')) ? readFileSync(join(root, 'called'), 'utf8') : '');
    return { root, env, docker, ssh, called };
  }

  it('deploy: token alleen in een tijdelijke DOCKER_CONFIG, bundel uitgepakt, deploy.sh van die versie', async () => {
    const t = await setup();
    const r = await t.ssh('deploy test sha-abcdef1', 'ghs_tijdelijktoken\n');
    expect(r.code, r.all).toBe(0);
    const login = t.docker.calls().find((c) => c.startsWith('login ghcr.io -u hz-deploy --password-stdin'))!;
    const cfg = /cfg=(\S+)/.exec(login)![1]!;
    expect(existsSync(cfg)).toBe(false); // na afloop weg
    expect(t.docker.calls().some((c) => c.startsWith('pull --quiet ghcr.io/homezerotech/hz-api:sha-abcdef1'))).toBe(
      true,
    );
    expect(existsSync(join(t.env.HZ_ROOT, 'releases/sha-abcdef1/.compleet'))).toBe(true);
    expect(t.called()).toMatch(/^deploy\.sh test sha-abcdef1 cfg=\S+\n$/);
  });

  it.each([
    [''],
    ['bash'],
    ['sh -c id'],
    ['deploy prod latest'],
    ['deploy staging sha-abcdef1'],
    ['deploy prod sha-abcdef1 extra'],
    ['deploy prod sha-abcdef1; reboot'],
    ['deploy prod $(id)'],
    ['preview up 12 ../../etc'],
    ['preview up 12a pr-12-abcdef1'],
    ['rollback prod'],
    ['scp -t /etc'],
  ])('weigert: %j', async (cmd) => {
    const t = await setup();
    const r = await t.ssh(cmd);
    expect(r.code).toBe(1);
    expect(t.called()).toBe('');
    expect(t.docker.calls()).toEqual([]);
  });

  it('preview up en down; down gebruikt de bundel van de versie van die preview', async () => {
    const t = await setup();
    expect((await t.ssh('preview up 12 pr-12-abcdef123456')).code).toBe(0);
    mkdirSync(join(t.env.HZ_ROOT, 'previews/pr-12'), { recursive: true });
    writeFileSync(join(t.env.HZ_ROOT, 'previews/pr-12/tag'), 'pr-12-abcdef123456\n');
    const r = await t.ssh('preview down 12');
    expect(r.code, r.all).toBe(0);
    expect(
      t
        .called()
        .split('\n')
        .filter(Boolean)
        .map((l) => l.replace(/ cfg=.*/, '')),
    ).toEqual(['preview.sh up 12 pr-12-abcdef123456', 'preview.sh down 12']);
  });

  it('rollback naar de vorige versie die nog op de server staat', async () => {
    const t = await setup();
    expect((await t.ssh('deploy prod v1.0.0')).code).toBe(0);
    mkdirSync(join(t.env.HZ_ROOT, 'env/prod'), { recursive: true });
    writeFileSync(join(t.env.HZ_ROOT, 'env/prod/previous'), 'v1.0.0\n');
    const r = await t.ssh('rollback prod');
    expect(r.code, r.all).toBe(0);
    expect(t.called().trim().split('\n').pop()).toMatch(/^deploy\.sh prod v1\.0\.0 cfg=$/);
  });
});

describe('secrets met age (secrets.sh, HZW-006)', () => {
  async function setup() {
    const root = tmp('hz-e0-sec-');
    const keys = ageKeys(join(root, 'age'));
    mkdirSync(join(root, 'secrets'));
    for (const f of ['prod.keys', 'test.keys', 'server.keys'])
      cpSync(join(INFRA, 'secrets', f), join(root, 'secrets', f));
    const env = {
      HZ_SECRETS_DIR: join(root, 'secrets'),
      HZ_AGE_RECIPIENTS_FILE: keys.recipients,
      HZ_AGE_IDENTITY: keys.key,
    };
    const sec = (args: string[], input?: string, extra: Record<string, string> = {}) =>
      run(script('secrets.sh'), args, { ...env, ...extra }, input);
    return { root, keys, env, sec };
  }

  it('gen vult machine-geheimen, check noemt wat een mens nog moet zetten, set leest van stdin', async () => {
    const t = await setup();
    expect((await t.sec(['gen', 'prod'])).code).toBe(0);
    expect((await t.sec(['keys', 'prod'])).out.split('\n').filter(Boolean)).toEqual([
      'HZ_AUTH_SECRET',
      'HZ_PG_APP_PASSWORD',
      'HZ_PG_BACKUP_PASSWORD',
      'HZ_PG_MIGRATOR_PASSWORD',
      'HZ_PG_SUPERUSER_PASSWORD',
      'HZ_TOKEN_KEY',
    ]);
    const c1 = await t.sec(['check', 'prod']);
    expect(c1.code).toBe(1);
    expect(c1.err).toContain('ontbrekend in prod: HZ_GOOGLE_CLIENT_ID HZ_GOOGLE_CLIENT_SECRET');
    expect((await t.sec(['set', 'prod', 'HZ_GOOGLE_CLIENT_ID'], 'id-123.apps.googleusercontent.com\n')).code).toBe(0);
    expect((await t.sec(['set', 'prod', 'HZ_GOOGLE_CLIENT_SECRET'], 'heel-geheim-456\n')).code).toBe(0);
    expect((await t.sec(['check', 'prod'])).code).toBe(0);
  });

  it('versleuteld bestand bevat geen leesbare waarde; ontsleutelen geeft 0600; HZ_TOKEN_KEY is 32 bytes', async () => {
    const t = await setup();
    await t.sec(['gen', 'prod']);
    await t.sec(['set', 'prod', 'HZ_GOOGLE_CLIENT_SECRET'], 'heel-geheim-456\n');
    const enc = readFileSync(join(t.root, 'secrets/prod.env.age'));
    expect(enc.subarray(0, 22).toString()).toBe('age-encryption.org/v1\n');
    expect(enc.includes(Buffer.from('heel-geheim-456'))).toBe(false);
    expect(enc.includes(Buffer.from('HZ_TOKEN_KEY'))).toBe(false);
    const out = join(t.root, 'plain');
    expect((await t.sec(['decrypt', 'prod', out])).code).toBe(0);
    expect(mode(out)).toBe('600');
    const plain = readFileSync(out, 'utf8');
    expect(plain).toContain('HZ_GOOGLE_CLIENT_SECRET=heel-geheim-456');
    expect(Buffer.from(/^HZ_TOKEN_KEY=(.*)$/m.exec(plain)![1]!, 'base64')).toHaveLength(32);
  });

  it('een andere sleutel kan niet ontsleutelen; zonder ontvangers wordt er niets versleuteld', async () => {
    const t = await setup();
    await t.sec(['gen', 'test']);
    const other = ageKeys(join(t.root, 'ander'));
    expect((await t.sec(['keys', 'test'], undefined, { HZ_AGE_IDENTITY: other.key })).code).toBe(1);
    writeFileSync(t.keys.recipients, '# leeg\n');
    const r = await t.sec(['gen', 'server']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('geen ontvangers');
  });

  it('rekey: na het toevoegen van een nieuwe server kan die sleutel ook ontsleutelen', async () => {
    const t = await setup();
    await t.sec(['gen', 'test']);
    const nieuw = ageKeys(join(t.root, 'nieuw'));
    writeFileSync(t.keys.recipients, `${readFileSync(t.keys.recipients, 'utf8')}${nieuw.pub}\n`);
    expect((await t.sec(['keys', 'test'], undefined, { HZ_AGE_IDENTITY: nieuw.key })).code).toBe(1);
    expect((await t.sec(['rekey', 'test'])).code).toBe(0);
    expect((await t.sec(['keys', 'test'], undefined, { HZ_AGE_IDENTITY: nieuw.key })).out).toContain('HZ_TOKEN_KEY');
  });

  it('weigert ongeldige sleutelnamen en waarden met een regeleinde', async () => {
    const t = await setup();
    expect((await t.sec(['set', 'prod', 'hz-lower'], 'x\n')).code).toBe(1);
    expect((await t.sec(['set', 'staging', 'HZ_X'], 'x\n')).code).toBe(1);
  });
});

describe('servercontrole (server-check.sh, HZW-002)', () => {
  const sshdGood =
    'port 22\npasswordauthentication no\nkbdinteractiveauthentication no\npermitrootlogin no\npubkeyauthentication yes\npermitemptypasswords no\n';
  const ssGood = [
    'tcp   LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*',
    'tcp   LISTEN 0 4096 0.0.0.0:80 0.0.0.0:*',
    'tcp   LISTEN 0 4096 0.0.0.0:443 0.0.0.0:*',
    'tcp   LISTEN 0 4096 [::]:443 [::]:*',
    'udp   UNCONN 0 0 0.0.0.0:443 0.0.0.0:*',
    'tcp   LISTEN 0 4096 127.0.0.1:2019 0.0.0.0:*',
    'udp   UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:*',
  ].join('\n');
  const ufwGood =
    'Status: active\nLogging: on (low)\nDefault: deny (incoming), allow (outgoing), disabled (routed)\n\nTo Action From\n-- ------ ----\n22/tcp ALLOW IN Anywhere\n80/tcp ALLOW IN Anywhere\n443/tcp ALLOW IN Anywhere\n443/udp ALLOW IN Anywhere\n';

  function check(
    over: { sshd?: string; ss?: string; ufw?: string; docker?: boolean; auto?: boolean },
    args: string[] = [],
  ) {
    const root = tmp('hz-e0-chk-');
    const w = (f: string, t: string) => (writeFileSync(join(root, f), t), join(root, f));
    mkdirSync(join(root, 'etc/apt/apt.conf.d'), { recursive: true });
    if (over.auto !== false) {
      w(
        'etc/apt/apt.conf.d/20auto-upgrades',
        'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n',
      );
      w('etc/apt/apt.conf.d/52unattended-upgrades-hz', 'Unattended-Upgrade::Automatic-Reboot "true";\n');
    }
    return run(script('server-check.sh'), args, {
      HZ_CHECK_ROOT: root,
      HZ_SSHD_T: `cat ${w('sshd', over.sshd ?? sshdGood)}`,
      HZ_SS: `cat ${w('ss', over.ss ?? ssGood)}`,
      HZ_UFW: `cat ${w('ufw', over.ufw ?? ufwGood)}`,
      HZ_DOCKER_INFO: over.docker === false ? 'false' : 'true',
    });
  }

  it('goed ingerichte server: alles groen, markdown-tabel voor het issue', async () => {
    const r = await check({}, ['--markdown']);
    expect(r.code, r.all).toBe(0);
    expect(r.out).toContain('| Status | Controle | Toelichting |');
    expect(r.out).toContain('| OK | poorten | alleen 22, 80, 443 publiek |');
    expect(r.out).toContain('| OK | ssh passwordauthentication | no |');
    expect(r.out).toContain('**Alles groen**');
  });

  it('wachtwoordlogin, root-login, open databasepoort, firewall uit, geen updates, Docker plat: allemaal rood', async () => {
    const r = await check({
      sshd: sshdGood
        .replace('passwordauthentication no', 'passwordauthentication yes')
        .replace('permitrootlogin no', 'permitrootlogin prohibit-password'),
      ss: `${ssGood}\ntcp LISTEN 0 244 0.0.0.0:5432 0.0.0.0:*\ntcp LISTEN 0 511 [::]:8700 [::]:*`,
      ufw: 'Status: inactive\n',
      docker: false,
      auto: false,
    });
    expect(r.code).toBe(1);
    const fout = r.out.split('\n').filter((l) => l.startsWith('FOUT'));
    expect(fout.map((l) => l.split(/\s{2,}/)[1])).toEqual([
      'ssh passwordauthentication',
      'ssh permitrootlogin',
      'poorten',
      'firewall',
      'updates',
      'docker',
    ]);
    expect(r.out).toMatch(/luistert publiek op: tcp\/5432 tcp\/8700/);
  });

  it('van buitenaf: een open databasepoort wordt gevonden', async () => {
    const srv: Server = createHttp(() => {});
    await new Promise<void>((ok) => srv.listen(5555, '127.0.0.1', ok)).catch(() => {});
    try {
      const r = await run(script('server-check.sh'), ['--extern', '127.0.0.1']);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/FOUT\s+poort 5555\s+open van buitenaf/);
      expect(r.out).toMatch(/OK\s+poort 2019\s+dicht/);
    } finally {
      await new Promise<void>((ok) => srv.close(() => ok()));
    }
  });
});

describe('TLS en doorsturen (tls-check.sh, HZW-003)', () => {
  const dir = tmp('hz-e0-tls-');
  const domain = 'hz.test.example';
  const sh = (c: string) => execFileSync('sh', ['-c', c], { cwd: dir, stdio: 'pipe' });
  beforeAll(() => {
    sh(
      'openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout ca.key -out ca.crt -days 30 -subj /CN=HZ-test-CA 2>/dev/null',
    );
    for (const [name, days, cn] of [
      ['goed', 60, domain],
      ['kort', 5, domain],
      ['anders', 60, 'ander.example'],
    ] as const) {
      sh(
        `openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout ${name}.key -out ${name}.csr -subj /CN=${cn} 2>/dev/null`,
      );
      writeFileSync(join(dir, `${name}.ext`), `subjectAltName=DNS:${cn}\n`);
      sh(
        `openssl x509 -req -in ${name}.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out ${name}.crt -days ${days} -extfile ${name}.ext 2>/dev/null`,
      );
    }
  });

  async function servers(o: { cert: string; hsts?: boolean; redirect?: boolean; status?: number }) {
    const https = createHttps(
      { key: readFileSync(join(dir, `${o.cert}.key`)), cert: readFileSync(join(dir, `${o.cert}.crt`)) },
      (_req, res) => {
        res
          .writeHead(o.status ?? 200, o.hsts === false ? {} : { 'strict-transport-security': 'max-age=31536000' })
          .end('{"ok":true}');
      },
    );
    await new Promise<void>((ok) => https.listen(0, '127.0.0.1', ok));
    const sp = (https.address() as { port: number }).port;
    const http = createHttp((_req, res) => {
      if (o.redirect === false) res.writeHead(200).end('ok');
      else res.writeHead(308, { location: `https://${domain}:${sp}/` }).end();
    });
    await new Promise<void>((ok) => http.listen(0, '127.0.0.1', ok));
    const hp = (http.address() as { port: number }).port;
    const env = {
      HZ_TLS_CONNECT: '127.0.0.1',
      HZ_TLS_HTTPS_PORT: String(sp),
      HZ_TLS_HTTP_PORT: String(hp),
      HZ_TLS_CAFILE: join(dir, 'ca.crt'),
    };
    return {
      check: (args: string[] = [domain]) => run(script('tls-check.sh'), args, env),
      close: async () => {
        await new Promise<void>((ok) => https.close(() => ok()));
        await new Promise<void>((ok) => http.close(() => ok()));
      },
    };
  }

  it('groen: http -> https, geldig certificaat voor de naam, nog lang geldig, HSTS', async () => {
    const s = await servers({ cert: 'goed' });
    try {
      const r = await s.check();
      expect(r.code, r.all).toBe(0);
      expect(r.out).toContain(`OK    ${domain}: http stuurt door naar https (308)`);
      expect(r.out).toContain(`OK    ${domain}: https /api/health geeft 200 met geldig certificaat`);
      expect(r.out).toContain('uitgever HZ-test-CA');
      expect(r.out).toContain('alles groen');
    } finally {
      await s.close();
    }
  });

  it('rood: geen doorsturen en geen HSTS', async () => {
    const s = await servers({ cert: 'goed', redirect: false, hsts: false });
    try {
      const r = await s.check();
      expect(r.code).toBe(1);
      expect(r.out).toContain('http stuurt niet door naar https (status 200');
      expect(r.out).toContain('geen HSTS-header');
    } finally {
      await s.close();
    }
  });

  it('rood: certificaat verloopt binnen 14 dagen', async () => {
    const s = await servers({ cert: 'kort' });
    try {
      const r = await s.check();
      expect(r.code).toBe(1);
      expect(r.out).toContain('certificaat verloopt binnen 14 dagen');
    } finally {
      await s.close();
    }
  });

  it('rood: certificaat voor een andere naam', async () => {
    const s = await servers({ cert: 'anders' });
    try {
      const r = await s.check();
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/FOUT\s+hz\.test\.example: https faalt/);
    } finally {
      await s.close();
    }
  });

  it('preview: verwacht een wachtwoordvraag (401)', async () => {
    const s = await servers({ cert: 'goed', status: 401 });
    try {
      expect((await s.check(['--auth', domain])).out).toContain('vraagt om een wachtwoord (401)');
      expect((await s.check([domain])).code).toBe(1);
    } finally {
      await s.close();
    }
  });
});

describe('uptime-hartslag (heartbeat.sh, HZW-007)', () => {
  let health: Awaited<ReturnType<typeof httpServer>>;
  let ping: Awaited<ReturnType<typeof httpServer>>;
  let body = '{"ok":true,"db":"ok"}';
  beforeAll(async () => {
    health = await httpServer(() => ({ status: 200, body }));
    ping = await httpServer(() => ({ status: 200, body: 'OK' }));
  });
  afterAll(async () => {
    await health.close();
    await ping.close();
  });
  beforeEach(() => {
    ping.hits.length = 0;
    body = '{"ok":true,"db":"ok"}';
  });
  const beat = (extra: Record<string, string> = {}) => {
    const docker = fakeDocker(tmp('hz-e0-hb-'));
    return run(script('heartbeat.sh'), [], {
      HZ_DOCKER: docker.bin,
      HZ_HEARTBEAT_PING_URL: `${ping.url}/ping/abc-123`,
      HZ_HEARTBEAT_CHECK_URL: `${health.url}/api/health`,
      HZ_HEARTBEAT_DISK_MAX: '100',
      ...extra,
    });
  };

  it('alles goed: ping naar de uptime-dienst', async () => {
    const r = await beat();
    expect(r.code, r.all).toBe(0);
    expect(ping.hits.map((h) => h.url)).toEqual(['/ping/abc-123']);
  });

  it('database onbereikbaar: ping naar /fail met de reden', async () => {
    body = '{"ok":true,"db":"error"}';
    expect((await beat()).code).toBe(1);
    expect(ping.hits.map((h) => [h.url, h.body])).toEqual([['/ping/abc-123/fail', 'database onbereikbaar; ']]);
  });

  it('unhealthy container en volle schijf worden gemeld; health onbereikbaar ook', async () => {
    expect((await beat({ FAKE_DOCKER_UNHEALTHY: 'hz-prod-worker-1\n', HZ_HEARTBEAT_DISK_MAX: '0' })).code).toBe(1);
    expect(ping.hits[0]!.url).toBe('/ping/abc-123/fail');
    expect(ping.hits[0]!.body).toMatch(/unhealthy: hz-prod-worker-1 ; schijf \d+% vol; /);
    ping.hits.length = 0;
    expect((await beat({ HZ_HEARTBEAT_CHECK_URL: 'http://127.0.0.1:1/api/health' })).code).toBe(1);
    expect(ping.hits[0]!.body).toContain('health niet bereikbaar');
  });
});

describe('server aanmaken bij Hetzner (hetzner-create.sh --dry-run, HZW-002)', () => {
  it('CX32, Ubuntu 24.04, Neurenberg, firewall 22/80/443, cloud-init; zonder iets aan te maken', async () => {
    const d = tmp('hz-e0-hc-');
    const key = sshPublicKey('robert');
    writeFileSync(join(d, 'k.pub'), key + '\n');
    writeFileSync(
      join(d, 'ud.yaml'),
      renderCloudInit({
        domain: 'homezero.verveen.me',
        testDomain: 'test.homezero.verveen.me',
        errorsDomain: 'fouten.homezero.verveen.me',
        acmeEmail: 'robert@homezero.nl',
        registry: 'ghcr.io/homezerotech',
        adminKeys: [key],
        deployKey: sshPublicKey('deploy'),
      }),
    );
    const r = await run(script('hetzner-create.sh'), [
      '--user-data',
      join(d, 'ud.yaml'),
      '--ssh-key',
      join(d, 'k.pub'),
      '--dry-run',
    ]);
    expect(r.code, r.all).toBe(0);
    const lines = r.out.split('\n').filter((l) => l.startsWith('+ '));
    expect(lines).toContain(
      `+ hcloud server create --name hz-workspace --type cx32 --image ubuntu-24.04 --location nbg1 --ssh-key hz-workspace-beheer --firewall hz-web --user-data-from-file ${join(d, 'ud.yaml')} --label app=hz-workspace`,
    );
    for (const p of ['tcp --port 22', 'tcp --port 80', 'tcp --port 443', 'udp --port 443'])
      expect(lines.some((l) => l.includes(`add-rule hz-web --direction in --protocol ${p} `))).toBe(true);
    expect(
      (
        await run(script('hetzner-create.sh'), [
          '--location',
          'ash',
          '--user-data',
          join(d, 'ud.yaml'),
          '--ssh-key',
          join(d, 'k.pub'),
          '--dry-run',
        ])
      ).code,
    ).toBe(1);
  });
});
