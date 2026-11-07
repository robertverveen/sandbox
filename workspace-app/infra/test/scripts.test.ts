/**
 * De beheerscripts echt gedraaid, met nep-docker, lokale HTTP/TLS-servers en tijdelijke mappen:
 * uitrol met health-check en rollback (HZW-004), preview per PR (HZW-005), secrets met age (HZW-006),
 * servercontrole (HZW-002), TLS en doorsturen (HZW-003), uptime-hartslag (HZW-007), forced command voor CI.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer as createHttps } from 'node:https';
import { createServer as createHttp, request as httpRequest, type Server } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { renderCloudInit } from '../cloud-init/render.mjs';
import {
  CADDYFILE_OTHERS,
  type Container,
  OTHER_CONTAINERS,
  OTHER_NETWORKS,
  OTHER_VOLUMES,
  otherProjectsServer,
  type ServerOpts,
  SS_GOOD,
  SSHD_GOOD,
  treeHash,
  WS_ENV,
} from './fixture-server';
import {
  ageKeys,
  fakeDocker,
  freePort,
  has,
  httpServer,
  INFRA,
  run,
  script,
  sshPublicKey,
  startProcess,
  tmp,
} from './helpers';

const mode = (p: string) => (statSync(p).mode & 0o777).toString(8);
const REG = 'ghcr.io/homezerotech';
/** Synthetische digest (64 hex) per tag en image. */
const dg = (tag: string, img: string) => createHash('sha256').update(`${tag}/${img}`).digest('hex');
/** Vastgelegde images van een tag, zoals hz-ssh-dispatch ze schrijft (images/<tag>.env). */
function writeRecord(hzRoot: string, tag: string, from = tag) {
  mkdirSync(join(hzRoot, 'images'), { recursive: true });
  writeFileSync(
    join(hzRoot, 'images', `${tag}.env`),
    ['api', 'worker', 'web'].map((i) => `HZ_IMAGE_${i.toUpperCase()}=${REG}/hz-${i}@sha256:${dg(from, i)}\n`).join(''),
  );
}

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

/**
 * Een server-opzet in een tijdelijke map: de bestaande server met andere projecten (fixture-server.ts), daarop
 * /srv/hz-workspace (etc, releases, ...), /run/hz-workspace en een uitrolbundel met test-secrets.
 */
async function serverFixture(opts: { missing?: string[]; server?: ServerOpts; hzEnv?: string } = {}) {
  const srv = otherProjectsServer(opts.server);
  const root = srv.root;
  const etc = join(root, 'srv/hz-workspace/etc');
  const bundle = join(srv.data, 'bundle');
  mkdirSync(etc, { recursive: true });
  writeFileSync(join(root, 'srv/hz-workspace/.hz-workspace'), '# hz-workspace\n');
  writeFileSync(
    join(etc, 'hz.env'),
    opts.hzEnv ??
      'HZ_DOMAIN=hz.example.nl\nHZ_TEST_DOMAIN=test.hz.example.nl\nHZ_ERRORS_DOMAIN=fouten.hz.example.nl\nHZ_ACME_EMAIL=ops@example.nl\nHZ_REGISTRY=ghcr.io/homezerotech\nHZ_PROXY_KIND=caddy\nHZ_PROXY_NETWORK=caddy\nHZ_PROXY_CONFIG=/etc/caddy\n',
  );
  for (const d of ['scripts', 'compose', 'caddy', 'postgres'])
    cpSync(join(INFRA, d), join(bundle, 'infra', d), { recursive: true });
  mkdirSync(join(bundle, 'infra/secrets'), { recursive: true });
  for (const f of ['prod.keys', 'test.keys', 'server.keys'])
    cpSync(join(INFRA, 'secrets', f), join(bundle, 'infra/secrets', f));
  const keys = ageKeys(join(srv.data, 'age'));
  const env = {
    ...srv.env,
    HZ_ROOT: join(root, 'srv/hz-workspace'),
    HZ_ETC: etc,
    HZ_RUN: join(srv.data, 'run'),
    HZ_LOG_DIR: join(root, 'srv/hz-workspace/log'),
    HZ_AGE_IDENTITY: keys.key,
    HZ_SECRETS_DIR: join(bundle, 'infra/secrets'),
    HZ_AGE_RECIPIENTS_FILE: keys.recipients,
  };
  // Secrets voor test en prod via secrets.sh zelf: gen vult de machine-geheimen, set de rest.
  // Server-secrets: previewwachtwoord (edge), Storage Box en hartslag (productie).
  if (!opts.missing?.includes('server')) {
    expect((await run(script('secrets.sh'), ['gen', 'server'], env)).code).toBe(0);
    for (const [k, v] of [
      ['HZ_PREVIEW_USER', 'hz'],
      ['HZ_PREVIEW_HASH', '$2a$14$Zkx19XLiW6VYouLHR5NmfOFU0z2GTNmpkT/5qqR7hx4IjWJPDhjvG'],
      ['HZ_BACKUP_TARGET', join(srv.data, 'storagebox')],
      ['HZ_HEARTBEAT_PING_URL', 'http://127.0.0.1:1/ping'],
    ])
      expect((await run(script('secrets.sh'), ['set', 'server', k!], env, `${v}\n`)).code).toBe(0);
  }
  for (const scope of ['test', 'prod']) {
    expect((await run(script('secrets.sh'), ['gen', scope], env)).code).toBe(0);
    for (const k of ['HZ_GOOGLE_CLIENT_ID', 'HZ_GOOGLE_CLIENT_SECRET'])
      if (!opts.missing?.includes(k))
        expect((await run(script('secrets.sh'), ['set', scope, k], env, `waarde-${k}\n`)).code).toBe(0);
  }
  return { root, data: srv.data, bundle, env, keys };
}

/** Alleen de lezende docker-opdrachten van de voorcheck: die mogen altijd. */
const writes = (calls: string[]) =>
  calls.filter((c) => !/^(ps -a --format|network ls --format|volume ls --format) /.test(c));

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

  async function setup(opts: { missing?: string[]; server?: ServerOpts; hzEnv?: string } = {}) {
    const s = await serverFixture(opts);
    const docker = fakeDocker(join(s.data, 'bin'));
    const env = {
      ...s.env,
      HZ_DOCKER: docker.bin,
      HZ_HEALTH_URL: `${health.url}/api/health`,
      HZ_HEALTH_TRIES: '2',
      HZ_HEALTH_SLEEP: '0',
    };
    // Zoals hz-ssh-dispatch: eerst de images van de tag vastleggen, dan deploy.sh van de bundel.
    const deploy = (e: string, tag: string, extra: Record<string, string> = {}, record = true) => {
      if (record && /^(sha-|v)[0-9a-f.]+$/.test(tag)) writeRecord(s.env.HZ_ROOT, tag);
      return run(join(s.bundle, 'infra/scripts/deploy.sh'), [e, tag], { ...env, ...extra });
    };
    const state = (e: string, f: string) => {
      const p = join(s.env.HZ_ROOT, 'env', e, f);
      return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
    };
    return { ...s, docker, deploy, state };
  }

  it('eerste uitrol naar test: voorcheck eerst, secrets alleen in /run (0600), router erbij, site-blok voor de proxy, migraties, containers, health groen, vastgelegd', async () => {
    const t = await setup();
    const r = await t.deploy('test', 'sha-aaaaaaa');
    expect(r.code, r.all).toBe(0);
    expect(t.state('test', 'current')).toBe('sha-aaaaaaa');
    expect(t.state('test', 'previous')).toBeNull();
    const calls = t.docker.calls();
    const idx = (re: RegExp) => calls.findIndex((c) => re.test(c));
    // Voorcheck (alleen lezen) vóór alles.
    expect(calls.slice(0, 3).map((c) => c.split(' ').slice(0, 2).join(' '))).toEqual([
      'ps -a',
      'network ls',
      'volume ls',
    ]);
    expect(r.err).toMatch(/OK\s+voorcheck proxy\s+caddy in container caddy-caddy-1/);
    expect(idx(/^network create --label nl\.homezero\.workspace=1 hz-workspace-net/)).toBeGreaterThan(2);
    const router = idx(
      /compose -p hz-workspace-router .* -f \S+\/compose\/router\.yaml -f \S+\/compose\/router-network\.yaml up -d --wait/,
    );
    expect(router).toBeGreaterThan(-1);
    expect(idx(/compose -p hz-workspace-router .* exec -T router caddy reload/)).toBeGreaterThan(router);
    expect(idx(/hz-workspace-edge/)).toBe(-1); // geen eigen edge: er draait al een proxy
    const pull = idx(/compose -p hz-workspace-test .* pull --quiet/);
    const roles = idx(/compose -p hz-workspace-test .* exec -T db \/docker-entrypoint-initdb\.d\/10-hz-roles\.sh/);
    const migrate = idx(/compose -p hz-workspace-test .* run --rm migrate/);
    expect(roles).toBeGreaterThan(pull);
    expect(migrate).toBeGreaterThan(roles);
    const up = idx(/compose -p hz-workspace-test .* up -d --remove-orphans --wait/);
    expect(pull).toBeGreaterThan(-1);
    expect(migrate).toBeGreaterThan(pull);
    expect(up).toBeGreaterThan(migrate);
    expect(calls[up]).toContain('tag=sha-aaaaaaa instance=hz-workspace-test env=test url=https://test.hz.example.nl');
    // Images per digest (vastgelegd), niet per tag uit de registry.
    expect(calls[up]).toContain(`img=${REG}/hz-api@sha256:${dg('sha-aaaaaaa', 'api')}`);
    // api en worker krijgen geen databasewachtwoorden
    const appEnv = readFileSync(join(t.env.HZ_RUN, 'test.app.env'), 'utf8');
    expect(appEnv).toMatch(/^HZ_TOKEN_KEY=/m);
    expect(appEnv).not.toMatch(/HZ_PG_/);
    expect(mode(join(t.env.HZ_RUN, 'test.env'))).toBe('600');
    expect(readFileSync(join(t.env.HZ_ROOT, 'router/Caddyfile'), 'utf8')).toBe(
      readFileSync(join(INFRA, 'caddy/router/Caddyfile'), 'utf8'),
    );
    // Site-blok voor de bestaande Caddy staat klaar in /srv/hz-workspace/proxy; de Caddyfile van de proxy is onaangeroerd.
    const site = readFileSync(join(t.env.HZ_ROOT, 'proxy/hz-workspace.caddy'), 'utf8');
    expect(site).toContain('hz.example.nl, test.hz.example.nl, fouten.hz.example.nl {');
    expect(site).toContain('reverse_proxy hz-workspace-router:8080');
    expect(readFileSync(join(t.root, 'etc/caddy/Caddyfile'), 'utf8')).toBe(CADDYFILE_OTHERS);
    expect(readFileSync(join(t.env.HZ_LOG_DIR, 'deploys.log'), 'utf8')).toMatch(/ test sha-aaaaaaa - ok\n$/);
  });

  it('ruimt alleen eigen oude images op (digests van huidige en vorige versie en preview-tags blijven); nooit image prune', async () => {
    const t = await setup();
    expect((await t.deploy('test', 'sha-aaaaaaa')).code).toBe(0);
    mkdirSync(join(t.env.HZ_ROOT, 'previews/pr-7'), { recursive: true });
    writeFileSync(join(t.env.HZ_ROOT, 'previews/pr-7/tag'), 'pr-7-abcdef1\n');
    const old = 'f'.repeat(64);
    const r = await t.deploy('test', 'sha-bbbbbbb', {
      FAKE_DOCKER_IMAGES: [
        `<none> sha256:${dg('sha-aaaaaaa', 'api')}`,
        `<none> sha256:${dg('sha-bbbbbbb', 'web')}`,
        `pr-7-abcdef1 sha256:${'1'.repeat(64)}`,
        `sha-0000000 sha256:${'2'.repeat(64)}`,
        `<none> sha256:${old}`,
      ].join(';'),
    });
    expect(r.code, r.all).toBe(0);
    const rm = t.docker.calls().filter((c) => c.startsWith('image rm '));
    expect(rm.map((c) => c.split(' ')[2])).toEqual(
      ['api', 'worker', 'web'].flatMap((i) => [
        `${REG}/hz-${i}:sha-0000000`,
        `${REG}/hz-${i}@sha256:${'2'.repeat(64)}`,
        `${REG}/hz-${i}@sha256:${old}`,
      ]),
    );
    expect(t.docker.calls().some((c) => /\b(image|system) prune\b/.test(c))).toBe(false);
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
    const ups = t.docker.calls().filter((c) => /compose -p hz-workspace-test .* up -d/.test(c));
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
    expect(writes(t.docker.calls())).toEqual([]);
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
        .some((c) => /compose -p hz-workspace-prod .* (run|up)/.test(c)),
    ).toBe(false);
    expect(t.state('prod', 'current')).toBe('v1.0.0');
  });

  it('productie start ook GlitchTip (hz-workspace-ops) zodra de server-secrets er zijn; test niet', async () => {
    const t = await setup();
    expect((await t.deploy('test', 'sha-aaaaaaa')).code).toBe(0);
    expect(t.docker.calls().some((c) => c.includes('compose -p hz-workspace-ops'))).toBe(false);
    const r = await t.deploy('prod', 'v1.0.0', { HZ_SKIP_PREDEPLOY_BACKUP: '1' });
    expect(r.code, r.all).toBe(0);
    expect(t.docker.calls().some((c) => /compose -p hz-workspace-ops .*compose\/ops\.yaml up -d/.test(c))).toBe(true);
  });

  it('weigert zonder server-secrets (previewwachtwoord voor de router)', async () => {
    const t = await setup({ missing: ['server'] });
    const r = await t.deploy('test', 'sha-aaaaaaa');
    expect(r.code).toBe(1);
    expect(r.err).toContain('server-secrets ontbreken: HZ_PREVIEW_USER HZ_PREVIEW_HASH');
    expect(writes(t.docker.calls())).toEqual([]);
  });

  it('voorcheck rood (netwerknaam van een ander project): uitrol stopt vóór secrets of containers', async () => {
    const t = await setup({ server: { networks: [...OTHER_NETWORKS, ['hz-workspace-net']] } });
    const r = await t.deploy('test', 'sha-aaaaaaa');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/FOUT\s+voorcheck netwerken\s+naam al in gebruik door iets anders: hz-workspace-net/);
    expect(r.err).toContain('voorcheck rood: uitrol gestopt, er is niets gewijzigd');
    expect(writes(t.docker.calls())).toEqual([]);
    expect(existsSync(join(t.env.HZ_RUN, 'test.env'))).toBe(false);
  });

  it('proxy op de host: router alleen op 127.0.0.1 (loopback), site-blok naar 127.0.0.1:<poort>', async () => {
    const hzEnv =
      'HZ_DOMAIN=hz.example.nl\nHZ_TEST_DOMAIN=test.hz.example.nl\nHZ_ACME_EMAIL=ops@example.nl\nHZ_REGISTRY=ghcr.io/homezerotech\nHZ_PROXY_KIND=caddy\nHZ_ROUTER_PORT=18780\nHZ_PROXY_CONFIG=/etc/caddy\n';
    // Caddy draait hier als dienst op de host: geen container op 443.
    const t = await setup({ hzEnv, server: { containers: OTHER_CONTAINERS.slice(1) } });
    const r = await t.deploy('test', 'sha-aaaaaaa');
    expect(r.code, r.all).toBe(0);
    expect(t.docker.calls().some((c) => /-p hz-workspace-router .*router-loopback\.yaml up -d/.test(c))).toBe(true);
    expect(readFileSync(join(t.env.HZ_ROOT, 'proxy/hz-workspace.caddy'), 'utf8')).toContain(
      'reverse_proxy 127.0.0.1:18780',
    );
  });

  it('eigen edge (HZW-082, server zonder proxy): edge op 443 met dezelfde site-blokken', async () => {
    const hzEnv =
      'HZ_DOMAIN=hz.example.nl\nHZ_TEST_DOMAIN=test.hz.example.nl\nHZ_ACME_EMAIL=ops@example.nl\nHZ_REGISTRY=ghcr.io/homezerotech\nHZ_PROXY_KIND=eigen\n';
    const t = await setup({
      hzEnv,
      server: { containers: [], ss: SS_GOOD.filter((l) => !/:(80|443) /.test(l)), caddyfile: '' },
    });
    const r = await t.deploy('test', 'sha-aaaaaaa');
    expect(r.code, r.all).toBe(0);
    expect(t.docker.calls().some((c) => /-p hz-workspace-edge .*compose\/edge\.yaml up -d/.test(c))).toBe(true);
    expect(readFileSync(join(t.env.HZ_ROOT, 'edge/hz-workspace.caddy'), 'utf8')).toContain('*.test.hz.example.nl {');
    expect(readFileSync(join(t.env.HZ_ROOT, 'edge/Caddyfile'), 'utf8')).toBe(
      readFileSync(join(INFRA, 'caddy/edge/Caddyfile'), 'utf8'),
    );
  });

  it('weigert onbekende omgevingen en tags; productie alleen v-tags, test alleen sha-tags, nooit een PR-tag', async () => {
    const t = await setup();
    expect((await t.deploy('staging', 'sha-aaaaaaa')).err).toContain('prod of test');
    expect((await t.deploy('test', 'latest')).err).toContain('ongeldige tag');
    expect((await t.deploy('test', 'sha-aaaaaaa;reboot')).code).toBe(1);
    for (const [e, tag] of [
      ['prod', 'pr-1-abcdef1'],
      ['test', 'pr-1-abcdef1'],
      ['prod', 'sha-aaaaaaa'],
      ['test', 'v1.0.0'],
    ]) {
      const r = await t.deploy(e!, tag!);
      expect(r.code, `${e} ${tag}`).toBe(1);
      expect(r.err).toContain(`ongeldige tag voor ${e}`);
    }
    expect(writes(t.docker.calls())).toEqual([]);
  });

  it('zonder vastgelegde images (nooit via hz-ssh-dispatch uitgerold) geen uitrol', async () => {
    const t = await setup();
    const r = await t.deploy('test', 'sha-eeeeeee', {}, false);
    expect(r.code).toBe(1);
    expect(r.err).toContain('geen vastgelegde images voor sha-eeeeeee');
    expect(writes(t.docker.calls())).toEqual([]);
  });
});

describe('preview per pull request (preview.sh, HZW-005)', () => {
  async function setup(extra: Record<string, string> = {}) {
    const s = await serverFixture();
    const docker = fakeDocker(join(s.data, 'bin'));
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
      'HZ_PG_AUTH_PASSWORD',
      'HZ_PG_WORKER_PASSWORD',
      'HZ_PG_INDEXER_PASSWORD',
      'HZ_PG_BOSS_PASSWORD',
    ])
      expect(env).toMatch(new RegExp(`^${k}=[0-9a-f]{48}$`, 'm'));
    expect(readFileSync(join(t.dir(12), 'app.env'), 'utf8')).toMatch(/^HZ_TOKEN_KEY=.{44}$/m);
    const up = t.docker.calls().find((c) => /compose -p hz-workspace-pr-12 .* up -d/.test(c))!;
    expect(up).toContain(
      'tag=pr-12-abcdef123456 instance=hz-workspace-pr-12 env=preview url=https://pr-12.test.hz.example.nl node_env=development devlogin=1',
    );
    expect(up).toContain(`img=${REG}/hz-api:pr-12-abcdef123456`);
    // De compose van de preview komt uit de bundel waar preview.sh staat (op de server: die van test).
    expect(up).toContain(`-f ${join(t.bundle, 'infra/compose/app.yaml')}`);
    expect(mode(t.dir(12))).toBe('755');
    expect(mode(join(t.dir(12), 'app.env'))).toBe('600');
    expect(
      t.docker.calls().some((c) => /compose -p hz-workspace-pr-12 .* exec -T web wget .*\/api\/health/.test(c)),
    ).toBe(true);
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
    expect(t.docker.calls().some((c) => /compose -p hz-workspace-pr-12 .* down -v --remove-orphans/.test(c))).toBe(
      true,
    );
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

  it('weigert ongeldige nummers en tags; alleen de images van deze PR (pr-<nr>-...)', async () => {
    const t = await setup();
    expect((await t.pv('up', '12a', 'pr-12-abcdef1')).code).toBe(1);
    expect((await t.pv('up', '12', 'main')).code).toBe(1);
    expect((await t.pv('down', '../x')).code).toBe(1);
    for (const tag of ['pr-13-abcdef1', 'v1.0.0', 'sha-abcdef1']) {
      const r = await t.pv('up', '12', tag);
      expect(r.code, tag).toBe(1);
      expect(r.err).toContain('verwacht pr-12-<commit>');
    }
    expect(writes(t.docker.calls())).toEqual([]);
  });
});

describe('forced command voor GitHub Actions (hz-ssh-dispatch, één rol per sleutel)', () => {
  const A = 'sha-abcdef1';
  const digests = (tag: string) => ['api', 'worker', 'web'].map((i) => dg(tag, i)).join(' ');

  async function setup() {
    const root = tmp('hz-e0-disp-');
    const etc = join(root, 'etc');
    mkdirSync(etc);
    writeFileSync(join(etc, 'hz.env'), `HZ_DOMAIN=hz.example.nl\nHZ_REGISTRY=${REG}\n`);
    // Nep-bundel in elk image (FAKE_DOCKER_BUNDLE): deploy.sh en preview.sh schrijven alleen op dat ze draaiden.
    // Het label laat zien uit welke bundel een script kwam; "IMAGE" is code uit een image (bij een PR: van de PR).
    const fakeBundle = (dir: string, label: string) => {
      mkdirSync(join(dir, 'infra/scripts'), { recursive: true });
      for (const s of ['deploy.sh', 'preview.sh'])
        writeFileSync(
          join(dir, 'infra/scripts', s),
          `#!/usr/bin/env bash\necho "${label} ${s} $* cfg=\${DOCKER_CONFIG:-}" >> "${root}/called"\n`,
          { mode: 0o755 },
        );
    };
    const bundle = join(root, 'image-bundle');
    fakeBundle(bundle, 'IMAGE');
    const docker = fakeDocker(join(root, 'bin'));
    const hzRoot = join(root, 'opt');
    const env = { HZ_ROOT: hzRoot, HZ_ETC: etc, HZ_DOCKER: docker.bin, FAKE_DOCKER_BUNDLE: bundle };
    const ssh = (role: string, cmd: string, stdin = '') =>
      run(script('hz-ssh-dispatch.sh'), role ? [role] : [], { ...env, SSH_ORIGINAL_COMMAND: cmd }, stdin);
    const called = () => (existsSync(join(root, 'called')) ? readFileSync(join(root, 'called'), 'utf8') : '');
    const lines = () =>
      called()
        .split('\n')
        .filter(Boolean)
        .map((l) => l.replace(/ cfg=.*/, ''));
    /** Bundel van main die op test draait (env/test/bundle -> releases/<sha>), met eigen label. */
    const testBundle = (tag = 'sha-0123456') => {
      const dir = join(hzRoot, 'releases', tag);
      fakeBundle(dir, 'TEST');
      writeFileSync(join(dir, '.compleet'), '');
      mkdirSync(join(hzRoot, 'env/test'), { recursive: true });
      execFileSync('ln', ['-sfn', dir, join(hzRoot, 'env/test/bundle')]);
    };
    return { root, env, hzRoot, docker, ssh, called, lines, testBundle };
  }

  it('deploy test: build van main met digests; token alleen in een tijdelijke DOCKER_CONFIG; images per digest; bundel uit dat image', async () => {
    const t = await setup();
    const r = await t.ssh('test', `deploy test ${A} ${digests(A)}`, 'ghs_tijdelijktoken\n');
    expect(r.code, r.all).toBe(0);
    const login = t.docker.calls().find((c) => c.startsWith('login ghcr.io -u hz-deploy --password-stdin'))!;
    const cfg = /cfg=(\S+)/.exec(login)![1]!;
    expect(existsSync(cfg)).toBe(false); // na afloop weg
    const pulls = t.docker.calls().filter((c) => c.startsWith('pull '));
    expect(pulls.map((c) => c.split(' ')[2])).toEqual(
      ['api', 'worker', 'web'].map((i) => `${REG}/hz-${i}@sha256:${dg(A, i)}`),
    );
    expect(t.docker.calls().some((c) => c.startsWith(`create ${REG}/hz-api@sha256:${dg(A, 'api')}`))).toBe(true);
    expect(readFileSync(join(t.hzRoot, `images/${A}.env`), 'utf8')).toContain(
      `HZ_IMAGE_WEB=${REG}/hz-web@sha256:${dg(A, 'web')}`,
    );
    expect(existsSync(join(t.hzRoot, `releases/${A}/.compleet`))).toBe(true);
    expect(t.called()).toMatch(new RegExp(`^IMAGE deploy\\.sh test ${A} cfg=\\S+\\n$`));
    expect(existsSync(join(t.hzRoot, `images/${A}.getest`))).toBe(true);
  });

  it('een tag krijgt nooit nieuwe images: opnieuw uitrollen gebruikt de vastgelegde digests, andere digests worden geweigerd', async () => {
    const t = await setup();
    // Zonder digests en zonder eerdere uitrol: geweigerd (alleen een build van main komt op test).
    let r = await t.ssh('test', `deploy test ${A}`);
    expect(r.code).toBe(1);
    expect(r.err).toContain('nog nooit uitgerold');
    expect(t.docker.calls()).toEqual([]);
    expect((await t.ssh('test', `deploy test ${A} ${digests(A)}`)).code).toBe(0);
    r = await t.ssh('test', `deploy test ${A}`);
    expect(r.code, r.all).toBe(0);
    // Iemand heeft de tag in de registry overschreven (bv. een workflow van een PR): de server neemt hem niet.
    const before = t.docker.calls().length;
    r = await t.ssh('test', `deploy test ${A} ${digests('kwaad')}`);
    expect(r.code).toBe(1);
    expect(r.err).toContain('eerder met andere images uitgerold');
    expect(t.docker.calls().length).toBe(before);
    expect(readFileSync(join(t.hzRoot, `images/${A}.env`), 'utf8')).toContain(dg(A, 'api'));
  });

  it('deploy prod: alleen een v-tag, en alleen met de images van een sha die op test groen was', async () => {
    const t = await setup();
    let r = await t.ssh('prod', `deploy prod v1.0.0 ${A}`);
    expect(r.code).toBe(1);
    expect(r.err).toContain('niet groen uitgerold op test');
    expect(t.docker.calls()).toEqual([]);
    expect((await t.ssh('test', `deploy test ${A} ${digests(A)}`)).code).toBe(0);
    const n = t.docker.calls().length;
    r = await t.ssh('prod', `deploy prod v1.0.0 ${A}`, 'ghs_token\n');
    expect(r.code, r.all).toBe(0);
    expect(
      t.docker
        .calls()
        .slice(n)
        .filter((c) => c.startsWith('pull '))
        .map((c) => c.split(' ')[2]),
    ).toEqual(['api', 'worker', 'web'].map((i) => `${REG}/hz-${i}@sha256:${dg(A, i)}`));
    expect(t.lines().pop()).toBe('IMAGE deploy.sh prod v1.0.0');
    // Opnieuw (of terugzetten via de workflow): dezelfde release zonder sha mag, een onbekende release niet.
    expect((await t.ssh('prod', 'deploy prod v1.0.0')).code).toBe(0);
    r = await t.ssh('prod', 'deploy prod v2.0.0');
    expect(r.code).toBe(1);
    expect(r.err).toContain('nog nooit');
    // Een test die rood eindigde telt niet als groen.
    const B = 'sha-bbbbbbb';
    writeFileSync(
      join(t.env.FAKE_DOCKER_BUNDLE, 'infra/scripts/deploy.sh'),
      `#!/usr/bin/env bash\necho "IMAGE deploy.sh $*" >> "${t.root}/called"; exit 1\n`,
      { mode: 0o755 },
    );
    expect((await t.ssh('test', `deploy test ${B} ${digests(B)}`)).code).toBe(1);
    expect(existsSync(join(t.hzRoot, `images/${B}.getest`))).toBe(false);
    expect((await t.ssh('prod', `deploy prod v1.1.0 ${B}`)).err).toContain('niet groen uitgerold op test');
  });

  it('PR-code kan nooit naar productie of test: "deploy prod pr-1-abcdef1" en elke PR-tag buiten preview geweigerd', async () => {
    const t = await setup();
    for (const role of ['prod', 'test', 'preview'])
      for (const cmd of [
        'deploy prod pr-1-abcdef1',
        'deploy test pr-1-abcdef1',
        `deploy prod pr-1-abcdef1 ${A}`,
        `deploy test pr-1-abcdef1 ${digests('pr')}`,
        'deploy prod sha-abcdef1',
        `deploy test v1.0.0 ${digests('v')}`,
      ]) {
        const r = await t.ssh(role, cmd);
        expect(r.code, `${role}: ${cmd}`).toBe(1);
      }
    expect(t.called()).toBe('');
    expect(t.docker.calls()).toEqual([]);
    expect(existsSync(join(t.hzRoot, 'releases'))).toBe(false);
    expect(existsSync(join(t.hzRoot, 'images'))).toBe(false);
  });

  it.each([
    ['', 'status'],
    ['admin', 'status'],
    ['preview', `deploy test ${A} ${'0'.repeat(64)} ${'0'.repeat(64)} ${'0'.repeat(64)}`],
    ['preview', 'deploy prod v1.0.0'],
    ['preview', 'rollback prod'],
    ['preview', 'status'],
    ['preview', 'check'],
    ['test', `deploy prod v1.0.0 ${A}`],
    ['test', 'rollback prod'],
    ['test', 'preview up 12 pr-12-abcdef1'],
    ['test', 'preview down 12'],
    ['prod', `deploy test ${A} ${'0'.repeat(64)} ${'0'.repeat(64)} ${'0'.repeat(64)}`],
    ['prod', 'rollback test'],
    ['prod', 'preview up 12 pr-12-abcdef1'],
  ])('rol %j mag niet: %s', async (role, cmd) => {
    const t = await setup();
    t.testBundle();
    const r = await t.ssh(role, cmd);
    expect(r.code).toBe(1);
    expect(t.called()).toBe('');
    expect(t.docker.calls()).toEqual([]);
  });

  it.each([
    [''],
    ['bash'],
    ['sh -c id'],
    ['deploy prod latest'],
    ['deploy staging sha-abcdef1'],
    ['deploy test sha-abcdef1 extra'],
    ['deploy test sha-abcdef1; reboot'],
    ['deploy test $(id)'],
    ['deploy test sha-abcdef1 abc def ghi'],
    ['rollback test'],
    ['scp -t /etc'],
  ])('weigert (rol test): %j', async (cmd) => {
    const t = await setup();
    const r = await t.ssh('test', cmd);
    expect(r.code).toBe(1);
    expect(t.called()).toBe('');
    expect(t.docker.calls()).toEqual([]);
  });

  it('preview up: preview.sh uit de bundel van test (main), nooit een script uit het PR-image; van de PR alleen de images', async () => {
    const t = await setup();
    // Zonder uitrol op test is er geen vertrouwde preview.sh: weigeren.
    let r = await t.ssh('preview', 'preview up 12 pr-12-abcdef123456');
    expect(r.code).toBe(1);
    expect(r.err).toContain('nog geen uitrol op test');
    t.testBundle();
    r = await t.ssh('preview', 'preview up 12 pr-12-abcdef123456', 'ghs_token\n');
    expect(r.code, r.all).toBe(0);
    expect(t.lines()).toEqual(['TEST preview.sh up 12 pr-12-abcdef123456']);
    expect(t.called()).not.toContain('IMAGE');
    // Geen bundel uit het PR-image: geen create/cp, geen releases/pr-*.
    expect(t.docker.calls().filter((c) => /^(create|cp|pull) /.test(c))).toEqual([]);
    expect(readdirSync(join(t.hzRoot, 'releases'))).toEqual(['sha-0123456']);
    expect(t.docker.calls().some((c) => c.startsWith('login ghcr.io'))).toBe(true);
    // Het nummer in de tag moet bij de PR horen.
    expect((await t.ssh('preview', 'preview up 12 pr-13-abcdef123456')).code).toBe(1);
  });

  it('preview down: ook met de bundel van test', async () => {
    const t = await setup();
    t.testBundle();
    mkdirSync(join(t.hzRoot, 'previews/pr-12'), { recursive: true });
    writeFileSync(join(t.hzRoot, 'previews/pr-12/tag'), 'pr-12-abcdef123456\n');
    const r = await t.ssh('preview', 'preview down 12');
    expect(r.code, r.all).toBe(0);
    expect(t.lines()).toEqual(['TEST preview.sh down 12']);
  });

  it('een symlink van test die buiten releases/ wijst wordt niet gevolgd', async () => {
    const t = await setup();
    const evil = join(t.root, 'elders/sha-0123456');
    mkdirSync(join(evil, 'infra/scripts'), { recursive: true });
    writeFileSync(join(evil, '.compleet'), '');
    writeFileSync(join(evil, 'infra/scripts/preview.sh'), `#!/usr/bin/env bash\necho EVIL >> "${t.root}/called"\n`, {
      mode: 0o755,
    });
    mkdirSync(join(t.hzRoot, 'env/test'), { recursive: true });
    mkdirSync(join(t.hzRoot, 'releases'), { recursive: true });
    execFileSync('ln', ['-sfn', evil, join(t.hzRoot, 'env/test/bundle')]);
    expect((await t.ssh('preview', 'preview up 12 pr-12-abcdef1')).code).toBe(1);
    expect(t.called()).toBe('');
  });

  it('voorcheck: zonder root, alleen de vaste kopie van server-check.sh met --voorcheck', async () => {
    const t = await setup();
    mkdirSync(join(t.hzRoot, 'bin'), { recursive: true });
    writeFileSync(
      join(t.hzRoot, 'bin/hz-server-check'),
      `#!/usr/bin/env bash\necho "check $*" >> "${t.root}/called"\n`,
      {
        mode: 0o755,
      },
    );
    expect((await t.ssh('test', 'voorcheck')).code).toBe(0);
    expect(t.called()).toBe('check --voorcheck --markdown\n');
    expect((await t.ssh('test', 'voorcheck extra')).code).toBe(1);
  });

  it('rollback naar de vorige versie die nog op de server staat (zelfde images)', async () => {
    const t = await setup();
    expect((await t.ssh('test', `deploy test ${A} ${digests(A)}`)).code).toBe(0);
    expect((await t.ssh('prod', `deploy prod v1.0.0 ${A}`)).code).toBe(0);
    mkdirSync(join(t.hzRoot, 'env/prod'), { recursive: true });
    writeFileSync(join(t.hzRoot, 'env/prod/previous'), 'v1.0.0\n');
    const r = await t.ssh('prod', 'rollback prod');
    expect(r.code, r.all).toBe(0);
    expect(t.called().trim().split('\n').pop()).toMatch(/^IMAGE deploy\.sh prod v1\.0\.0 cfg=$/);
    // Een vorige versie die geen release is (bv. een PR-tag in het bestand) wordt niet teruggezet.
    writeFileSync(join(t.hzRoot, 'env/prod/previous'), 'pr-1-abcdef1\n');
    expect((await t.ssh('prod', 'rollback prod')).code).toBe(1);
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
      'HZ_PG_AUTH_PASSWORD',
      'HZ_PG_BACKUP_PASSWORD',
      'HZ_PG_BOSS_PASSWORD',
      'HZ_PG_INDEXER_PASSWORD',
      'HZ_PG_MIGRATOR_PASSWORD',
      'HZ_PG_SUPERUSER_PASSWORD',
      'HZ_PG_WORKER_PASSWORD',
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

describe('servercontrole en voorcheck op de bestaande server (server-check.sh, HZW-002)', () => {
  const READ_ONLY = /^(ps -a --format|network ls --format|volume ls --format) /;

  async function check(o: ServerOpts = {}, args: string[] = [], env: Record<string, string> = {}) {
    const srv = otherProjectsServer(o);
    const docker = fakeDocker(join(srv.data, 'bin'));
    const before = treeHash(srv.root);
    const r = await run(script('server-check.sh'), args, { ...WS_ENV, ...srv.env, HZ_DOCKER: docker.bin, ...env });
    // De controle wijzigt niets: geen bestand op de server anders, en alleen lezende docker-opdrachten.
    expect(treeHash(srv.root)).toBe(before);
    expect(docker.calls().filter((c) => !READ_ONLY.test(c))).toEqual([]);
    const lines = (st: string) =>
      r.out
        .split('\n')
        .filter((l) => l.startsWith(st))
        .map((l) => l.split(/\s{2,}/)[1]);
    return { ...r, srv, docker, fout: lines('FOUT'), warn: lines('WAARSCHUWING') };
  }

  it('bestaande server met andere projecten (Caddy, blog, monitor, Home Assistant): alles groen, niets gewijzigd', async () => {
    const r = await check({}, ['--markdown']);
    expect(r.code, r.all).toBe(0);
    expect(r.out).toContain('| OK | tailscale | in het tailnet: 100.101.102.103 |');
    expect(r.out).toContain('| OK | ssh via tailnet | sshd luistert alleen op het tailnet-adres |');
    expect(r.out).toContain('| OK | poort 443 | de proxy luistert op 443 |');
    expect(r.out).toContain('| OK | ssh passwordauthentication | no |');
    expect(r.out).toContain(
      '| OK | voorcheck proxy | caddy in container caddy-caddy-1 (caddy:2.8.4-alpine), netwerk caddy |',
    );
    expect(r.out).toMatch(/\| OK \| voorcheck projecten \| geen botsing; andere projecten: blog caddy monitor/);
    expect(r.out).toMatch(/\| OK \| voorcheck mappen \| .*andere mappen: \/opt\/monitor \/srv\/blog \/srv\/caddy/);
    expect(r.out).toContain(
      '| OK | voorcheck domeinen | homezero.verveen.me, test.homezero.verveen.me, *.test.homezero.verveen.me en fouten.homezero.verveen.me komen nergens anders voor |',
    );
    // Het site-blok is nog niet aangesloten: melding, geen rood.
    expect(r.out).toContain('| WAARSCHUWING | voorcheck aangesloten |');
    expect(r.out).toContain('**Alles groen**');
    // Alleen de drie lezende docker-opdrachten.
    expect(r.docker.calls().map((c) => c.split(' ').slice(0, 2).join(' '))).toEqual([
      'ps -a',
      'network ls',
      'volume ls',
    ]);
  });

  it.each<[string, ServerOpts, Record<string, string>, string, RegExp]>([
    [
      'poort: de routerpoort is al van de monitor',
      {},
      { HZ_PROXY_NETWORK: '', HZ_ROUTER_PORT: '3000' },
      'voorcheck poorten',
      /bezet door een ander project: 3001 \(127\.0\.0\.1\) 3001 \(container monitor-kuma-1\)/,
    ],
    [
      'netwerk: hz-workspace-net bestaat al van iets anders',
      { networks: [...OTHER_NETWORKS, ['hz-workspace-net']] },
      {},
      'voorcheck netwerken',
      /naam al in gebruik door iets anders: hz-workspace-net/,
    ],
    [
      'domein: homezero.verveen.me staat al in de Caddyfile van een ander project',
      { caddyfile: `${CADDYFILE_OTHERS}\nhomezero.verveen.me {\n\treverse_proxy oud:80\n}\n` },
      {},
      'voorcheck domeinen',
      /al in gebruik bij een ander project: homezero\.verveen\.me \(proxyconfig\)/,
    ],
    [
      'domein: een Traefik-label van een andere container claimt het testdomein',
      {
        containers: [
          ...OTHER_CONTAINERS,
          {
            name: 'oud-1',
            project: 'oud',
            image: 'nginx:1.27',
            labels: 'traefik.http.routers.oud.rule=Host(`test.homezero.verveen.me`)',
          },
        ],
      },
      {},
      'voorcheck domeinen',
      /test\.homezero\.verveen\.me \(labels van oud-1\)/,
    ],
    [
      'compose-project: hz-workspace-prod draait al zonder ons label',
      {
        containers: [
          ...OTHER_CONTAINERS,
          { name: 'hz-workspace-prod-db-1', project: 'hz-workspace-prod', image: 'postgres:16' },
        ],
      },
      {},
      'voorcheck projecten',
      /hz-workspace-naam al in gebruik: hz-workspace-prod-db-1 \(project hz-workspace-prod\)/,
    ],
    [
      'volume: hz-workspace-prod_db-data bestaat al van iets anders',
      { volumes: [...OTHER_VOLUMES, ['hz-workspace-prod_db-data']] },
      {},
      'voorcheck volumes',
      /hz-workspace-prod_db-data/,
    ],
    [
      'map: /srv/hz-workspace bestaat al zonder merkbestand',
      { dirs: ['srv/hz-workspace'] },
      {},
      'voorcheck mappen',
      /niet van de workspace \(geen \.hz-workspace\): \/srv\/hz-workspace/,
    ],
    [
      'proxy: het is Caddy, niet Traefik',
      {},
      { HZ_PROXY_KIND: 'traefik' },
      'voorcheck proxy',
      /op 443 draait caddy-caddy-1 \(caddy:2\.8\.4-alpine\), niet traefik/,
    ],
    [
      'proxy: het netwerk "proxy" bestaat niet en de proxy zit er niet in',
      {},
      { HZ_PROXY_NETWORK: 'proxy' },
      'voorcheck proxy',
      /zit niet in netwerk proxy \(wel: caddy\)/,
    ],
    [
      'eigen edge terwijl er al een proxy op 443 draait',
      {},
      { HZ_PROXY_KIND: 'eigen', HZ_PROXY_NETWORK: '' },
      'voorcheck proxy',
      /443 is bezet door container caddy-caddy-1/,
    ],
    [
      'gebruiker hz-workspace bestaat al met een andere thuismap',
      { files: { 'etc/passwd': 'root:x:0:0::/root:/bin/bash\nhz-workspace:x:998:998::/home/hz-workspace:/bin/sh\n' } },
      {},
      'voorcheck gebruiker',
      /andere thuismap \(\/home\/hz-workspace\)/,
    ],
    [
      'gebruiker hz-preview bestaat al met een andere thuismap',
      { files: { 'etc/passwd': 'root:x:0:0::/root:/bin/bash\nhz-preview:x:997:997::/home/hz-preview:/bin/sh\n' } },
      {},
      'voorcheck gebruiker',
      /hz-preview bestaat al met een andere thuismap \(\/home\/hz-preview\)/,
    ],
    [
      'systemd-unit met onze naam van iets anders',
      { files: { 'etc/systemd/system/hz-workspace-backup.service': '[Unit]\nDescription=iets anders\n' } },
      {},
      'voorcheck units',
      /hz-workspace-backup\.service/,
    ],
  ])('botsing wordt rood: %s', async (_naam, o, env, controle, uitleg) => {
    const r = await check(o, ['--voorcheck'], env);
    expect(r.code, r.all).toBe(1);
    expect(r.fout).toContain(controle);
    expect(r.out).toMatch(uitleg);
  });

  it('een wildcard van een ander project die ons domein dekt: waarschuwing, geen rood', async () => {
    const r = await check({ caddyfile: `${CADDYFILE_OTHERS}\n*.verveen.me {\n\trespond "x"\n}\n` }, ['--voorcheck']);
    expect(r.code, r.all).toBe(0);
    expect(r.warn).toContain('voorcheck wildcard');
  });

  it('de workspace staat er al (alles met ons label, ons blok in de Caddyfile): geen botsing met zichzelf', async () => {
    const ours = (name: string, project: string, extra: Partial<Container> = {}): Container => ({
      name,
      project,
      ours: true,
      image: 'x:1',
      labels: 'nl.homezero.workspace=1',
      ...extra,
    });
    const snippet =
      '# >>> hz-workspace (infra/scripts/proxy-snippet.sh)\nhomezero.verveen.me, test.homezero.verveen.me, fouten.homezero.verveen.me {\n\treverse_proxy hz-workspace-router:8080\n}\n# <<< hz-workspace\n';
    const r = await check(
      {
        containers: [
          ...OTHER_CONTAINERS,
          ours('hz-workspace-prod-db-1', 'hz-workspace-prod'),
          ours('hz-workspace-router-router-1', 'hz-workspace-router', { networks: 'hz-workspace-net,caddy' }),
        ],
        networks: [...OTHER_NETWORKS, ['hz-workspace-net', true], ['hz-workspace-prod-net', true]],
        volumes: [...OTHER_VOLUMES, ['hz-workspace-prod_db-data', true]],
        dirs: ['srv/hz-workspace'],
        files: {
          'srv/hz-workspace/.hz-workspace': '# hz-workspace\n',
          'srv/hz-workspace/proxy/hz-workspace.caddy': snippet,
          'etc/caddy/Caddyfile': `${CADDYFILE_OTHERS}\nimport /srv/hz-workspace/proxy/hz-workspace.caddy\n${snippet}`,
          'etc/passwd': 'root:x:0:0::/root:/bin/bash\nhz-workspace:x:998:998::/srv/hz-workspace:/bin/bash\n',
          'etc/systemd/system/hz-workspace-backup.service': '# hz-workspace: eigen unit\n[Unit]\n',
        },
      },
      ['--voorcheck'],
    );
    expect(r.code, r.all).toBe(0);
    expect(r.out).toMatch(/OK\s+voorcheck aangesloten\s+de proxy importeert het site-blok/);
    expect(r.out).toMatch(/OK\s+voorcheck geheugen\s+.*de workspace draait al/);
  });

  it('SSH op alle adressen maar ufw laat 22 alleen toe op tailscale0: groen; 22 voor iedereen open: rood', async () => {
    const ss = SS_GOOD.map((l) => l.replace('100.101.102.103:22', '0.0.0.0:22'));
    const sshd = SSHD_GOOD.replace('listenaddress 100.101.102.103:22', 'listenaddress 0.0.0.0:22');
    const ufwBase =
      'Status: active\nLogging: on (low)\nDefault: deny (incoming), allow (outgoing), disabled (routed)\n\nTo Action From\n-- ------ ----\n';
    const ok = await check({
      ss,
      sshd,
      ufw: `${ufwBase}22/tcp on tailscale0 ALLOW IN Anywhere\n443 ALLOW IN Anywhere\n`,
    });
    expect(ok.code, ok.all).toBe(0);
    expect(ok.out).toMatch(/OK\s+ssh via tailnet\s+sshd luistert op 0\.0\.0\.0, ufw laat 22 alleen toe op tailscale0/);
    const bad = await check({
      ss,
      sshd,
      ufw: `${ufwBase}22/tcp ALLOW IN Anywhere\n22/tcp on tailscale0 ALLOW IN Anywhere\n`,
    });
    expect(bad.code).toBe(1);
    expect(bad.fout).toEqual(['ssh via tailnet']);
    const geenUfw = await check({ ss, sshd });
    expect(geenUfw.fout).toEqual(['ssh via tailnet']);
  });

  it('wachtwoordlogin, root met wachtwoord, geen Tailscale, geen updates, 443 niet bezet, Docker plat: allemaal rood', async () => {
    const r = await check({
      sshd: SSHD_GOOD.replace('passwordauthentication no', 'passwordauthentication yes').replace(
        'permitrootlogin no',
        'permitrootlogin yes',
      ),
      ss: [...SS_GOOD.filter((l) => !l.includes(':443 ')), 'tcp LISTEN 0 244 0.0.0.0:5432 0.0.0.0:*'],
      tailscaleIp: '',
      autoUpgrades: false,
    });
    expect(r.code).toBe(1);
    expect(r.fout).toEqual(
      expect.arrayContaining([
        'tailscale',
        'ssh passwordauthentication',
        'ssh permitrootlogin',
        'poort 443',
        'updates',
      ]),
    );
    expect(r.warn).toContain('andere poorten');
    expect(r.out).toMatch(/niet van de workspace\): tcp\/5432/);
    const plat = await check({}, [], { HZ_DOCKER: 'false' });
    expect(plat.fout).toEqual(expect.arrayContaining(['docker', 'voorcheck docker']));
  });

  it('de workspace zelf publiceert niets buiten 127.0.0.1: een publieke poort op een eigen container is rood', async () => {
    const r = await check({
      containers: [
        ...OTHER_CONTAINERS,
        {
          name: 'hz-workspace-prod-api-1',
          project: 'hz-workspace-prod',
          ours: true,
          image: 'x:1',
          ports: '0.0.0.0:8700->8700/tcp',
        },
      ],
    });
    expect(r.fout).toContain('workspace-poorten');
    expect(r.out).toMatch(/publiek gepubliceerd: hz-workspace-prod-api-1 0\.0\.0\.0:8700->8700\/tcp/);
  });

  it('van buitenaf: 443 open hoort, SSH en een open databasepoort zijn rood', async () => {
    const https: Server = createHttp(() => {});
    const sshd: Server = createHttp(() => {});
    const db: Server = createHttp(() => {});
    const listen = (srv: Server, port = 0) =>
      new Promise<number>((ok) => srv.listen(port, '127.0.0.1', () => ok((srv.address() as { port: number }).port)));
    const pHttps = await listen(https);
    const pSsh = await listen(sshd);
    const pDb = await listen(db);
    try {
      const r = await run(script('server-check.sh'), ['--extern', '127.0.0.1'], {
        HZ_EXTERN_HTTPS_PORT: String(pHttps),
        HZ_EXTERN_SSH_PORT: String(pSsh),
        HZ_EXTERN_HTTP_PORT: '1',
        HZ_EXTERN_DICHT: `2 ${pDb}`,
      });
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/OK\s+poort 443\s+open/);
      expect(r.out).toMatch(/FOUT\s+poort 22\s+SSH open van buitenaf/);
      expect(r.out).toMatch(new RegExp(`FOUT\\s+poort ${pDb}\\s+open van buitenaf`));
      sshd.close();
      const r2 = await run(script('server-check.sh'), ['--extern', '127.0.0.1'], {
        HZ_EXTERN_HTTPS_PORT: String(pHttps),
        HZ_EXTERN_SSH_PORT: String(pSsh),
        HZ_EXTERN_HTTP_PORT: '1',
        HZ_EXTERN_DICHT: '2',
      });
      expect(r2.code, r2.all).toBe(0);
      expect(r2.out).toMatch(/OK\s+poort 22\s+dicht van buitenaf/);
    } finally {
      for (const srv of [https, sshd, db]) await new Promise<void>((ok) => srv.close(() => ok()));
    }
  });
});

describe('server klaarzetten (server-setup.sh, HZW-002)', () => {
  async function setup(o: ServerOpts = {}, args: string[] = [], noKeys = false) {
    const srv = otherProjectsServer(o);
    const docker = fakeDocker(join(srv.data, 'bin'));
    const log = join(srv.data, 'cmds.log');
    const fake = (name: string, body = '') => {
      const f = join(srv.data, 'bin', name);
      writeFileSync(f, `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\n${body}\n`, { mode: 0o755 });
      return f;
    };
    // Drie CI-sleutels, elk met één doel.
    const keys = Object.fromEntries(
      ['test', 'prod', 'preview'].map((r) => {
        const f = join(srv.data, `ci-${r}.pub`);
        writeFileSync(f, `${sshPublicKey(`ci-${r}`)}\n`);
        return [r, f];
      }),
    ) as Record<'test' | 'prod' | 'preview', string>;
    const key = keys.prod;
    const env = {
      ...srv.env,
      HZ_DOCKER: docker.bin,
      HZ_SETUP_PREFIX: srv.root,
      HZ_USERADD: fake(
        'useradd',
        `u="\${@: -1}"; h=""; while (($#)); do [[ "$1" == --home-dir ]] && h="$2"; shift; done; echo "$u:x:998:998::$h:/bin/bash" >> "${srv.root}/etc/passwd"`,
      ),
      HZ_SYSTEMCTL: fake('systemctl'),
      HZ_SYSTEMD_TMPFILES: fake('systemd-tmpfiles'),
      HZ_CHOWN: fake('chown'),
      HZ_VISUDO: fake('visudo'),
      HZ_SSH_KEYGEN: fake(
        'ssh-keygen',
        'f="${@: -1}"; echo PRIVATE > "$f"; echo "ssh-ed25519 AAAA hz-workspace-backup" > "$f.pub"',
      ),
    };
    const args0 = [
      '--domain',
      'homezero.verveen.me',
      '--acme-email',
      'robert@homezero.nl',
      '--registry',
      'ghcr.io/homezerotech',
      '--proxy',
      'caddy',
      '--proxy-network',
      'caddy',
      '--proxy-config',
      '/etc/caddy',
    ];
    const keyArgs = ['--deploy-key-test', keys.test, '--deploy-key-prod', keys.prod, '--preview-key', keys.preview];
    const r = await run(script('server-setup.sh'), [...args0, ...(noKeys ? [] : keyArgs), ...args], env);
    const cmds = existsSync(log) ? readFileSync(log, 'utf8') : '';
    const again = (more: string[]) => run(script('server-setup.sh'), [...args0, ...more], env);
    return { ...r, srv, docker, cmds, key, keys, again, p: (rel: string) => join(srv.root, rel) };
  }

  it('droog (--dry-run): voorcheck groen, toont de stappen en wijzigt niets', async () => {
    const srv0 = otherProjectsServer();
    const before = treeHash(srv0.root);
    const r = await setup({}, ['--dry-run']);
    expect(r.code, r.all).toBe(0);
    expect(r.out).toContain('voorcheck');
    expect(r.out).toContain('+ map /srv/hz-workspace (0755 root:root)');
    expect(r.out).toContain('+ schrijf /etc/sudoers.d/hz-workspace');
    expect(r.err).toContain('droog gedraaid: er is niets gewijzigd');
    expect(existsSync(r.p('srv/hz-workspace'))).toBe(false);
    expect(r.cmds).toBe('');
    expect(r.docker.calls().filter((c) => !/^(ps -a|network ls|volume ls) /.test(c))).toEqual([]);
    expect(treeHash(srv0.root)).toBe(before); // (een verse nep-server met dezelfde inhoud blijft gelijk)
  });

  it('echt: eigen gebruiker, map met merkbestand, scripts, hz.env, CI-sleutel alleen voor hz-ssh-dispatch, units, netwerk', async () => {
    const r = await setup();
    expect(r.code, r.all).toBe(0);
    expect(r.cmds).toMatch(
      /^useradd --system --home-dir \/srv\/hz-workspace --no-create-home --shell \/bin\/bash --groups docker .* hz-workspace$/m,
    );
    // hz-preview: alleen docker, niet de groep hz-workspace (die de age-sleutel mag lezen).
    const pv = r.cmds.split('\n').find((l) => l.startsWith('useradd') && l.endsWith(' hz-preview'))!;
    expect(pv).toMatch(/--home-dir \/srv\/hz-workspace\/previews .*--groups docker /);
    expect(pv).not.toMatch(/--groups \S*hz-workspace/);
    expect(existsSync(r.p('srv/hz-workspace/.hz-workspace'))).toBe(true);
    for (const [bin, src] of <[string, string][]>[
      ['hz-ssh-dispatch', 'hz-ssh-dispatch.sh'],
      ['hz-run', 'hz-run.sh'],
      ['hz-server-check', 'server-check.sh'],
      ['lib.sh', 'lib.sh'],
    ])
      expect(readFileSync(r.p(`srv/hz-workspace/bin/${bin}`), 'utf8'), bin).toBe(readFileSync(script(src), 'utf8'));
    expect(mode(r.p('srv/hz-workspace/bin/hz-ssh-dispatch'))).toBe('755');
    expect(mode(r.p('srv/hz-workspace/etc'))).toBe('751');
    expect(mode(r.p('srv/hz-workspace/etc/hz.env'))).toBe('644');
    // De age-sleutel: alleen root en de groep hz-workspace (niet hz-preview).
    expect(mode(r.p('srv/hz-workspace/etc/age.key'))).toBe('640');
    expect(r.cmds).toContain(`chown root:hz-workspace ${r.p('srv/hz-workspace/etc/age.key')}`);
    expect(r.cmds).toContain(`chown hz-preview:hz-preview ${r.p('srv/hz-workspace/previews')}`);
    for (const d of ['releases', 'env', 'images']) expect(mode(r.p(`srv/hz-workspace/${d}`)), d).toBe('755');
    const env = readFileSync(r.p('srv/hz-workspace/etc/hz.env'), 'utf8');
    for (const l of [
      'HZ_DOMAIN=homezero.verveen.me',
      'HZ_TEST_DOMAIN=test.homezero.verveen.me',
      'HZ_PROXY_KIND=caddy',
      'HZ_PROXY_NETWORK=caddy',
      'HZ_PG_EXEC=docker exec -i hz-workspace-prod-db-1',
    ])
      expect(env).toContain(`${l}\n`);
    // Per sleutel een vaste rol; de preview-sleutel bij een andere gebruiker.
    const pub = (k: string) => readFileSync(k, 'utf8').trim();
    const ak = readFileSync(r.p('srv/hz-workspace/.ssh/authorized_keys'), 'utf8');
    expect(ak.split('\n').filter((l) => l.startsWith('restrict'))).toEqual([
      `restrict,command="/srv/hz-workspace/bin/hz-ssh-dispatch test" ${pub(r.keys.test)}`,
      `restrict,command="/srv/hz-workspace/bin/hz-ssh-dispatch prod" ${pub(r.keys.prod)}`,
    ]);
    expect(mode(r.p('srv/hz-workspace/.ssh/authorized_keys'))).toBe('600');
    const pk = readFileSync(r.p('srv/hz-workspace/previews/.ssh/authorized_keys'), 'utf8');
    expect(pk.split('\n').filter((l) => l.startsWith('restrict'))).toEqual([
      `restrict,command="/srv/hz-workspace/bin/hz-ssh-dispatch preview" ${pub(r.keys.preview)}`,
    ]);
    expect(mode(r.p('srv/hz-workspace/previews/.ssh/authorized_keys'))).toBe('600');
    expect(readFileSync(r.p('etc/sudoers.d/hz-workspace'), 'utf8')).toContain(
      'hz-workspace ALL=(root) NOPASSWD: /srv/hz-workspace/bin/hz-server-check --markdown',
    );
    for (const u of ['backup', 'heartbeat', 'hersteltest'])
      expect(readFileSync(r.p(`etc/systemd/system/hz-workspace-${u}.service`), 'utf8')).toBe(
        readFileSync(join(INFRA, `systemd/hz-workspace-${u}.service`), 'utf8'),
      );
    expect(r.cmds).toContain(
      'systemctl enable --now hz-workspace-backup.timer hz-workspace-heartbeat.timer hz-workspace-hersteltest.timer',
    );
    expect(readFileSync(r.p('srv/hz-workspace/etc/age.pub'), 'utf8')).toMatch(/^age1/);
    expect(
      r.docker.calls().some((c) => c.startsWith('network create --label nl.homezero.workspace=1 hz-workspace-net')),
    ).toBe(true);
    expect(readFileSync(r.p('srv/hz-workspace/log/sleutels.txt'), 'utf8')).not.toContain('AGE-SECRET-KEY');
    // De andere projecten blijven ongemoeid: Caddyfile, hun mappen.
    expect(readFileSync(r.p('etc/caddy/Caddyfile'), 'utf8')).toBe(CADDYFILE_OTHERS);
    expect(existsSync(r.p('srv/blog'))).toBe(true);
    // Na de installatie is de voorcheck nog steeds groen (de workspace botst niet met zichzelf).
    const again = await run(script('server-check.sh'), ['--voorcheck'], { ...r.srv.env, HZ_DOCKER: r.docker.bin });
    expect(again.code, again.all).toBe(0);
  });

  it('voorcheck rood (domein al in gebruik): stopt meteen, er verandert niets', async () => {
    const r = await setup({ caddyfile: `homezero.verveen.me {\n\trespond oud\n}\n` });
    expect(r.code).toBe(1);
    expect(r.err).toContain('voorcheck rood: er is niets gewijzigd');
    expect(existsSync(r.p('srv/hz-workspace'))).toBe(false);
    expect(r.cmds).toBe('');
    expect(r.docker.calls().filter((c) => !/^(ps -a|network ls|volume ls) /.test(c))).toEqual([]);
  });

  it('overschrijft nooit een sudo-regel van iets anders', async () => {
    const r = await setup({ files: { 'etc/sudoers.d/hz-workspace': 'iemand ALL=(ALL) ALL\n' } });
    expect(r.code).toBe(1);
    expect(r.err).toContain('/etc/sudoers.d/hz-workspace bestaat al en is niet van de workspace');
    expect(readFileSync(r.p('etc/sudoers.d/hz-workspace'), 'utf8')).toBe('iemand ALL=(ALL) ALL\n');
  });

  it('weigert ongeldige invoer', async () => {
    expect((await setup({}, ['--proxy', 'nginx'])).code).toBe(1);
    expect((await setup({}, ['--domain', 'niet een domein'])).code).toBe(1);
  });

  it('CI-sleutels: minstens één, nooit dezelfde voor twee rollen, de oude --deploy-key bestaat niet meer', async () => {
    const none = await setup({}, [], true);
    expect(none.code).toBe(1);
    expect(none.err).toContain('geen CI-sleutel');
    const same = await setup({}, [], true);
    const r1 = await same.again(['--deploy-key-prod', same.keys.prod, '--preview-key', same.keys.prod]);
    expect(r1.code).toBe(1);
    expect(r1.err).toContain('dezelfde sleutel voor twee rollen');
    const r2 = await same.again(['--deploy-key', same.keys.prod]);
    expect(r2.code).toBe(1);
    expect(r2.err).toContain('vervangen door --deploy-key-test, --deploy-key-prod en --preview-key');
    expect(existsSync(same.p('srv/hz-workspace'))).toBe(false);
  });

  it('opnieuw draaien met alleen een nieuwe preview-sleutel laat de sleutels van test en productie staan', async () => {
    const r = await setup();
    expect(r.code, r.all).toBe(0);
    const nieuw = join(r.srv.data, 'ci-preview-2.pub');
    writeFileSync(nieuw, `${sshPublicKey('ci-preview-2')}\n`);
    const r2 = await r.again(['--preview-key', nieuw]);
    expect(r2.code, r2.all).toBe(0);
    const ak = readFileSync(r.p('srv/hz-workspace/.ssh/authorized_keys'), 'utf8');
    expect(ak).toContain(`hz-ssh-dispatch test" ${readFileSync(r.keys.test, 'utf8').trim()}`);
    expect(ak).toContain(`hz-ssh-dispatch prod" ${readFileSync(r.keys.prod, 'utf8').trim()}`);
    const pk = readFileSync(r.p('srv/hz-workspace/previews/.ssh/authorized_keys'), 'utf8');
    expect(pk).toContain(readFileSync(nieuw, 'utf8').trim());
    expect(pk).not.toContain(readFileSync(r.keys.preview, 'utf8').trim());
  });
});

describe('SSH vanuit CI alleen over het tailnet (ci-ssh.sh, HZW-004)', () => {
  function ci(resolved: string) {
    const d = tmp('hz-e0-cissh-');
    const log = join(d, 'ssh.log');
    writeFileSync(join(d, 'ssh'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > "${log}"\ncat > "${d}/stdin"\n`, {
      mode: 0o755,
    });
    writeFileSync(join(d, 'resolve'), `#!/usr/bin/env bash\nfor a in ${resolved}; do echo "$a STREAM $1"; done\n`, {
      mode: 0o755,
    });
    let user: Record<string, string> = {};
    const go = (host: string, ...cmd: string[]) =>
      run(
        script('ci-ssh.sh'),
        [host, ...cmd],
        { HZ_SSH: join(d, 'ssh'), HZ_RESOLVE: join(d, 'resolve'), ...user },
        'ghs_token\n',
      );
    const as = (u: string) => (user = { HZ_SSH_USER: u });
    return { go, as, log, d };
  }

  it('tailnet-naam (100.x): verbindt met dat adres, vaste host-sleutel, gebruiker hz-workspace, token via stdin', async () => {
    const t = ci('100.101.102.103');
    const r = await t.go('hetzner.tail1234.ts.net', 'deploy', 'test', 'sha-abc1234');
    expect(r.code, r.all).toBe(0);
    const args = readFileSync(t.log, 'utf8');
    expect(args).toContain('-o StrictHostKeyChecking=yes');
    expect(args).toContain('-o HostKeyAlias=hetzner.tail1234.ts.net');
    expect(args.trim().endsWith('hz-workspace@100.101.102.103 deploy test sha-abc1234')).toBe(true);
    expect(readFileSync(join(t.d, 'stdin'), 'utf8')).toBe('ghs_token\n');
  });

  it.each([
    ['publiek IPv4', '203.0.113.10'],
    ['publiek en tailnet door elkaar', '100.101.102.103 203.0.113.10'],
    ['buiten 100.64.0.0/10', '100.128.0.1'],
    ['publiek IPv6', '2001:db8::1'],
    ['niet te vinden', ''],
  ])('weigert %s: geen publieke SSH', async (_n, addrs) => {
    const t = ci(addrs);
    const r = await t.go('server.example.nl', 'deploy', 'test', 'sha-abc1234');
    expect(r.code).toBe(1);
    expect(existsSync(t.log)).toBe(false);
  });

  it('previews als hz-preview (eigen sleutel en gebruiker); andere gebruikers geweigerd', async () => {
    const t = ci('100.101.102.103');
    t.as('hz-preview');
    expect((await t.go('hetzner', 'preview', 'up', '12', 'pr-12-abcdef1')).code).toBe(0);
    expect(readFileSync(t.log, 'utf8').trim().endsWith('hz-preview@100.101.102.103 preview up 12 pr-12-abcdef1')).toBe(
      true,
    );
    t.as('root');
    const r = await t.go('hetzner', 'status');
    expect(r.code).toBe(1);
    expect(r.err).toContain('ongeldige gebruiker');
  });

  it('tailnet IPv6 (fd7a:115c:a1e0::/48) mag', async () => {
    const t = ci('fd7a:115c:a1e0::1234');
    expect((await t.go('hetzner', 'status')).code).toBe(0);
  });
});

describe('router van de workspace echt in Caddy (HZW-003, HZW-005)', () => {
  let p: ReturnType<typeof startProcess> | undefined;
  let port = 0;
  let ask = 0;
  const allow = tmp('hz-e0-allow-');
  beforeAll(async () => {
    expect(has('caddy'), 'caddy moet geïnstalleerd zijn (CI: workspace-app installeert hem)').toBe(true);
    port = await freePort();
    ask = await freePort();
    writeFileSync(join(allow, 'pr-12.test.homezero.verveen.me'), '');
    const caddy = execFileSync('sh', ['-c', 'command -v caddy'], {
      env: { PATH: `${process.env.PATH}:/root/go/bin` },
      encoding: 'utf8',
    }).trim();
    p = startProcess(caddy, ['run', '--adapter', 'caddyfile', '--config', join(INFRA, 'caddy/router/Caddyfile')], {
      ...WS_ENV,
      HZ_ROUTER_LISTEN: String(port),
      HZ_ROUTER_ASK_LISTEN: String(ask),
      HZ_PREVIEWS_DIR: allow,
      HZ_PREVIEW_USER: 'hz',
      // caddy hash-password voor "geheim"
      HZ_PREVIEW_HASH: '$2a$14$G2NWpX09IchCmPyIGA53dONVz7eHveShu.uyDD1351un3PIZnt3Qa',
      XDG_DATA_HOME: tmp('hz-e0-caddy-'),
      XDG_CONFIG_HOME: tmp('hz-e0-caddy-'),
    });
    for (let i = 0; i < 100; i++) {
      try {
        await fetch(`http://127.0.0.1:${ask}/healthz`);
        return;
      } catch {
        await new Promise((ok) => setTimeout(ok, 100));
      }
    }
    throw new Error(`router start niet: ${p.output()}`);
  });
  afterAll(async () => {
    await p?.stop();
  });
  const get = (host: string, path = '/', auth?: string) =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined> }>((ok, fail) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          headers: { host, ...(auth ? { authorization: `Basic ${Buffer.from(auth).toString('base64')}` } : {}) },
        },
        (res) => {
          res.resume();
          res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers }));
        },
      );
      req.on('error', fail);
      req.end();
    });

  it('toestemming voor on-demand TLS: alleen vaste domeinen en aangemelde previews; geen pad-trucs', async () => {
    const q = async (d: string) => (await fetch(`http://127.0.0.1:${ask}/ask?domain=${encodeURIComponent(d)}`)).status;
    expect(await q('homezero.verveen.me')).toBe(200);
    expect(await q('fouten.homezero.verveen.me')).toBe(200);
    expect(await q('pr-12.test.homezero.verveen.me')).toBe(200);
    expect(await q('pr-13.test.homezero.verveen.me')).toBe(404);
    expect(await q('../../etc/passwd')).toBe(404);
    expect(await q('evil.example.com')).toBe(404);
    expect((await fetch(`http://127.0.0.1:${ask}/healthz`)).status).toBe(200);
  });

  it('routering: productie naar zijn upstream (502 zonder container), previews met wachtwoord, onbekend 404', async () => {
    const prod = await get('homezero.verveen.me', '/api/health');
    // Doorgezet naar hz-workspace-prod-web, dat hier niet bestaat: 502, of 503 zodra de actieve healthcheck hem ziek meldt.
    expect([502, 503]).toContain(prod.status);
    expect((await get('pr-12.test.homezero.verveen.me')).status).toBe(401);
    expect((await get('pr-12.test.homezero.verveen.me', '/', 'hz:fout')).status).toBe(401);
    expect((await get('pr-12.test.homezero.verveen.me', '/', 'hz:geheim')).status).toBe(502);
    const onbekend = await get('iets.test.homezero.verveen.me', '/', 'hz:geheim');
    expect(onbekend.status).toBe(404);
    expect(onbekend.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect(onbekend.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect((await get('ander.example.nl')).status).toBe(404);
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

  it('kijkt alleen naar containers van de workspace (andere projecten op de server tellen niet mee)', async () => {
    const d = tmp('hz-e0-hb-');
    const docker = fakeDocker(d);
    await run(script('heartbeat.sh'), [], {
      HZ_DOCKER: docker.bin,
      HZ_HEARTBEAT_PING_URL: `${ping.url}/ping/abc-123`,
      HZ_HEARTBEAT_CHECK_URL: `${health.url}/api/health`,
      HZ_HEARTBEAT_DISK_MAX: '100',
    });
    expect(docker.calls()[0]).toMatch(/^ps --filter health=unhealthy --filter label=nl\.homezero\.workspace=1 /);
  });

  it('unhealthy container en volle schijf worden gemeld; health onbereikbaar ook', async () => {
    expect(
      (await beat({ FAKE_DOCKER_UNHEALTHY: 'hz-workspace-prod-worker-1\n', HZ_HEARTBEAT_DISK_MAX: '0' })).code,
    ).toBe(1);
    expect(ping.hits[0]!.url).toBe('/ping/abc-123/fail');
    expect(ping.hits[0]!.body).toMatch(/unhealthy: hz-workspace-prod-worker-1 ; schijf \d+% vol; /);
    ping.hits.length = 0;
    expect((await beat({ HZ_HEARTBEAT_CHECK_URL: 'http://127.0.0.1:1/api/health' })).code).toBe(1);
    expect(ping.hits[0]!.body).toContain('health niet bereikbaar');
  });
});

describe('optioneel: eigen server bij Hetzner voor een verhuizing (hetzner-create.sh --dry-run, HZW-082)', () => {
  it('CX32, Ubuntu 24.04, Neurenberg, firewall alleen 443 (SSH via Tailscale), cloud-init; zonder iets aan te maken', async () => {
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
        tailscaleAuthKey: 'tskey-auth-voorbeeldvoorbeeld',
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
      `+ hcloud server create --name hz-workspace-2 --type cx32 --image ubuntu-24.04 --location nbg1 --ssh-key hz-workspace-2-beheer --firewall hz-workspace-web --user-data-from-file ${join(d, 'ud.yaml')} --label app=hz-workspace`,
    );
    const rules = lines.filter((l) => l.includes('add-rule'));
    expect(rules.map((l) => /--protocol (\S+)(?: --port (\S+))?/.exec(l)!.slice(1).join('/'))).toEqual([
      'tcp/443',
      'udp/443',
    ]);
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
