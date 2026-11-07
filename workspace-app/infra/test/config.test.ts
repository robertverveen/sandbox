/**
 * Configuratie als code, geparst en tegen de officiële schema's gecontroleerd:
 * compose (HZW-004/005), Caddyfiles (HZW-003), Dockerfiles (HZW-004/006), workflows (HZW-001/004/005),
 * cloud-init (HZW-002, HZW-082) en geen secrets leesbaar in Git (HZW-006).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import AjvDraft04 from 'ajv-draft-04';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { renderCloudInit, SETUP_FILES } from '../cloud-init/render.mjs';
import { buildCsp, inlineScriptHashes } from '../docker/web-csp.mjs';
import { findAll, parseCaddyfile, site, type Node } from './caddyfile';
import { APP, APP_PREFIX, INFRA, ROOT, sshPublicKey, tmp } from './helpers';

const read = (p: string) => readFileSync(join(INFRA, p), 'utf8');
const schema = (f: string) => JSON.parse(readFileSync(join(INFRA, 'test/schemas', f), 'utf8'));
const errorsOf = (v: { errors?: unknown }) => JSON.stringify(v.errors, null, 1)?.slice(0, 2000);

type Service = {
  image?: string;
  ports?: unknown[];
  healthcheck?: unknown;
  restart?: string;
  environment?: Record<string, string>;
  networks?: Record<string, { aliases?: string[] } | null> | string[];
  labels?: Record<string, string>;
  mem_limit?: string | number;
  cpus?: string | number;
  user?: string;
  read_only?: boolean;
  cap_drop?: string[];
  env_file?: string[];
};
type Compose = {
  name?: string;
  services: Record<string, Service>;
  networks?: Record<string, { external?: boolean; name?: string; labels?: Record<string, string> }>;
  volumes?: Record<string, { labels?: Record<string, string> } | null>;
};

const compose = (f: string) => parse(read(`compose/${f}`), { merge: true }) as Compose;
const FILES = [
  'app.yaml',
  'ops.yaml',
  'router.yaml',
  'router-network.yaml',
  'router-loopback.yaml',
  'router-traefik.yaml',
  'edge.yaml',
];
const FULL = ['app.yaml', 'ops.yaml', 'router.yaml', 'edge.yaml'];
/** '1g', '512m', 768 (bytes) of '${HZ_MEM_DB:-1g}' -> MiB, met de standaardwaarde. */
const mib = (v: string | number | undefined): number => {
  const t = String(v ?? '').replace(/^\$\{[A-Z_]+:-([^}]+)\}$/, '$1');
  const m = /^(\d+(?:\.\d+)?)([mg])$/.exec(t);
  if (!m) throw new Error(`geen geheugenlimiet: ${v}`);
  return Number(m[1]) * (m[2] === 'g' ? 1024 : 1);
};
const cpu = (v: string | number | undefined): number =>
  Number(String(v ?? '').replace(/^\$\{[A-Z_]+:-([^}]+)\}$/, '$1'));

describe('compose (HZW-002, HZW-004, HZW-005)', () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile(schema('compose-spec.json'));

  it.each(FILES)('%s voldoet aan de compose-specificatie', (f) => {
    const doc = parse(read(`compose/${f}`), { merge: true });
    expect(validate(doc), errorsOf(validate)).toBe(true);
  });

  it('instantie: db, migrate, api, worker, web; alles met healthcheck behalve de eenmalige migratie', () => {
    const c = compose('app.yaml');
    expect(Object.keys(c.services).sort()).toEqual(['api', 'db', 'migrate', 'web', 'worker']);
    for (const [name, s] of Object.entries(c.services)) {
      if (name === 'migrate') expect(s.restart).toBe('no');
      else {
        expect(s.healthcheck, `${name} healthcheck`).toBeTruthy();
        expect(s.restart).toBe('unless-stopped');
      }
    }
  });

  it('eigen namen naast andere projecten: projecten, netwerken en het gedeelde netwerk heten hz-workspace-*', () => {
    expect(compose('app.yaml').name).toBe('${HZ_INSTANCE:?HZ_INSTANCE ontbreekt}');
    expect(compose('ops.yaml').name).toBe('hz-workspace-ops');
    expect(compose('router.yaml').name).toBe('hz-workspace-router');
    expect(compose('edge.yaml').name).toBe('hz-workspace-edge');
    expect(compose('app.yaml').networks!.default).toMatchObject({ name: '${HZ_INSTANCE}-net' });
    expect(compose('ops.yaml').networks!.default).toMatchObject({ name: 'hz-workspace-ops-net' });
    for (const f of ['app.yaml', 'ops.yaml', 'router.yaml', 'edge.yaml'])
      expect(compose(f).networks!.hzw, f).toEqual({ external: true, name: 'hz-workspace-net' });
    // De instanties krijgen hun projectnaam van deploy.sh en preview.sh: altijd hz-workspace-<omgeving|pr-nr>.
    expect(read('scripts/deploy.sh')).toContain('instance="hz-workspace-$env"');
    expect(read('scripts/preview.sh')).toContain('compose -p "hz-workspace-pr-$nr"');
    expect(read('scripts/deploy.sh')).toContain('compose -p hz-workspace-router');
    expect(read('scripts/deploy.sh')).toContain('compose -p hz-workspace-ops');
    // Geen oude, te algemene namen meer (hz-prod, hz-edge, /opt/hz) die met een ander project kunnen botsen.
    for (const f of [...FILES.map((x) => `compose/${x}`), 'scripts/deploy.sh', 'scripts/preview.sh', 'scripts/lib.sh'])
      expect(read(f), f).not.toMatch(/\bhz-(prod|test|edge|ops|pr)\b|\/(opt|etc)\/hz\//);
  });

  it('label nl.homezero.workspace=1 op elke service, elk eigen netwerk en elk volume (zo herkent de voorcheck wat van ons is)', () => {
    for (const f of FULL) {
      const c = compose(f);
      for (const [n, s] of Object.entries(c.services))
        expect(s.labels?.['nl.homezero.workspace'], `${f}/${n}`).toBe('1');
      for (const [n, v] of Object.entries(c.volumes ?? {}))
        expect(v?.labels?.['nl.homezero.workspace'], `${f} volume ${n}`).toBe('1');
      for (const [n, net] of Object.entries(c.networks ?? {}))
        if (!net.external) expect(net.labels?.['nl.homezero.workspace'], `${f} netwerk ${n}`).toBe('1');
    }
  });

  it('limieten op geheugen en CPU voor elke service; previews kleiner; som past bij de voorcheck', () => {
    for (const f of FULL)
      for (const [n, s] of Object.entries(compose(f).services)) {
        expect(mib(s.mem_limit), `${f}/${n} mem_limit`).toBeGreaterThan(0);
        expect(mib(s.mem_limit), `${f}/${n} mem_limit`).toBeLessThanOrEqual(1024);
        expect(cpu(s.cpus), `${f}/${n} cpus`).toBeGreaterThan(0);
        expect(cpu(s.cpus), `${f}/${n} cpus`).toBeLessThanOrEqual(1);
      }
    const app = compose('app.yaml').services;
    const inst = ['db', 'api', 'worker', 'web'].reduce((t, n) => t + mib(app[n]!.mem_limit), 0);
    const ops = Object.values(compose('ops.yaml').services).reduce((t, s) => t + mib(s.mem_limit), 0);
    const router = mib(compose('router.yaml').services.router!.mem_limit);
    const total = 2 * inst + ops + router; // productie + test + GlitchTip + router
    expect(read('scripts/server-check.sh')).toContain(`limits_mib=${total}\n`);
    const preview = read('scripts/preview.sh');
    for (const v of [
      'HZ_MEM_DB="${HZ_PREVIEW_MEM_DB:-384m}"',
      'HZ_MEM_API="${HZ_PREVIEW_MEM_API:-256m}"',
      'HZ_CPUS_DB=0.5',
    ])
      expect(preview).toContain(v);
    expect(preview).toContain('max="${HZ_PREVIEW_MAX:-3}"');
  });

  it('geen publieke poort: app, ops en router publiceren niets; loopback alleen op 127.0.0.1; eigen edge alleen 443', () => {
    for (const f of ['app.yaml', 'ops.yaml', 'router.yaml', 'router-network.yaml', 'router-traefik.yaml'])
      for (const [name, s] of Object.entries(compose(f).services)) expect(s.ports, `${f}/${name}`).toBeUndefined();
    expect(compose('router-loopback.yaml').services.router!.ports).toEqual([
      '127.0.0.1:${HZ_ROUTER_PORT:?HZ_ROUTER_PORT ontbreekt in hz.env}:8080',
      '127.0.0.1:${HZ_ROUTER_ASK_PORT:?}:8081',
    ]);
    expect(compose('edge.yaml').services.caddy!.ports).toEqual(['443:443', '443:443/udp']);
  });

  it('alleen de router doet mee in het netwerk van de bestaande proxy; de app-containers alleen in hz-workspace-net', () => {
    expect(compose('router-network.yaml').networks!.proxy).toEqual({
      external: true,
      name: '${HZ_PROXY_NETWORK:?HZ_PROXY_NETWORK ontbreekt in hz.env}',
    });
    expect(compose('router-network.yaml').services.router!.networks).toEqual({
      proxy: { aliases: ['hz-workspace-router'] },
    });
    for (const f of ['app.yaml', 'ops.yaml', 'router.yaml', 'edge.yaml'])
      expect(read(`compose/${f}`), f).not.toContain('HZ_PROXY_NETWORK');
    const c = compose('app.yaml');
    expect((c.services.web!.networks as Record<string, { aliases?: string[] }>).hzw!.aliases).toEqual([
      '${HZ_INSTANCE}-web',
    ]);
    for (const n of ['db', 'api', 'worker', 'migrate']) expect(c.services[n]!.networks, n).toBeUndefined();
    expect(read('scripts/lib.sh')).toContain('HZ_NET=hz-workspace-net');
  });

  it('Traefik (ook Coolify): labels op de router voor onze domeinen en previews, via het proxynetwerk', () => {
    const l = compose('router-traefik.yaml').services.router!.labels!;
    expect(l['traefik.enable']).toBe('true');
    expect(l['traefik.docker.network']).toBe('${HZ_PROXY_NETWORK:?}');
    expect(l['traefik.http.routers.hz-workspace.rule']).toBe(
      'Host(`${HZ_DOMAIN}`) || Host(`${HZ_TEST_DOMAIN}`) || Host(`${HZ_ERRORS_DOMAIN}`)',
    );
    expect(l['traefik.http.routers.hz-workspace-pr.rule']).toBe(
      'HostRegexp(`^pr-[0-9]{1,6}\\.${HZ_TEST_DOMAIN_RE:?}$$`)',
    );
    expect(l['traefik.http.services.hz-workspace.loadbalancer.server.port']).toBe('8080');
  });

  it('api en worker: elk een eigen login (stuk E2), migratierol alleen voor migrate, geen superuser-wachtwoord', () => {
    const s = compose('app.yaml').services;
    expect(s.api!.environment!.DATABASE_URL).toMatch(
      /^postgres:\/\/hz_app_login:\$\{HZ_PG_APP_PASSWORD\}@db:5432\/hz$/,
    );
    expect(s.api!.environment!.HZ_AUTH_DATABASE_URL).toMatch(
      /^postgres:\/\/hz_auth_login:\$\{HZ_PG_AUTH_PASSWORD\}@db:5432\/hz$/,
    );
    expect(s.worker!.environment!.DATABASE_URL).toMatch(
      /^postgres:\/\/hz_worker_login:\$\{HZ_PG_WORKER_PASSWORD\}@db:5432\/hz$/,
    );
    // pg-boss nooit als de migratierol (de worker weigert dat in productie): een eigen login met alleen zijn schema.
    expect(s.worker!.environment!.HZ_BOSS_DATABASE_URL).toMatch(
      /^postgres:\/\/hz_boss:\$\{HZ_PG_BOSS_PASSWORD\}@db:5432\/hz$/,
    );
    expect(s.migrate!.environment!.DATABASE_URL).toMatch(/^postgres:\/\/hz_migrator:/);
    for (const n of ['api', 'worker', 'web', 'migrate']) {
      expect(JSON.stringify(s[n])).not.toContain('HZ_PG_SUPERUSER_PASSWORD');
      expect(JSON.stringify(s[n])).not.toContain('HZ_PG_BACKUP_PASSWORD');
    }
    for (const n of ['api', 'worker', 'web']) expect(JSON.stringify(s[n]), n).not.toContain('HZ_PG_MIGRATOR_PASSWORD');
    expect(JSON.stringify(s.api)).not.toMatch(/HZ_PG_(WORKER|BOSS|INDEXER)_PASSWORD/);
    expect(JSON.stringify(s.worker)).not.toMatch(/HZ_PG_(APP|AUTH|INDEXER)_PASSWORD/);
    expect(s.api!.environment!.HZ_STORE).toBe('db');
    expect(s.api!.environment!.HZ_DEV_LOGIN).toBe('${HZ_DEV_LOGIN:-0}');
  });

  it('app-containers en router: alleen-lezen bestandssysteem, geen extra rechten', () => {
    for (const n of ['api', 'worker', 'web', 'migrate']) {
      const s = compose('app.yaml').services[n]!;
      expect(s.read_only, n).toBe(true);
      expect(s.cap_drop, n).toEqual(['ALL']);
    }
    const r = compose('router.yaml').services.router!;
    expect(r.read_only).toBe(true);
    expect(r.cap_drop).toEqual(['ALL']);
  });

  it('images met vaste versies (geen latest), app-images per digest of PR-tag', () => {
    for (const f of FULL)
      for (const [n, s] of Object.entries(compose(f).services)) {
        expect(s.image, `${f}/${n}`).toBeTruthy();
        expect(s.image, `${f}/${n}`).not.toMatch(/:latest$|^[^:]+$/);
      }
    const s = compose('app.yaml').services;
    // Per digest (test/productie, vastgelegd door hz-ssh-dispatch) of per PR-tag (preview): nooit vast op een tag.
    expect(s.migrate!.image).toBe('${HZ_IMAGE_API:?HZ_IMAGE_API ontbreekt}');
    expect(s.api!.image).toBe('${HZ_IMAGE_API:?HZ_IMAGE_API ontbreekt}');
    expect(s.worker!.image).toBe('${HZ_IMAGE_WORKER:?HZ_IMAGE_WORKER ontbreekt}');
    expect(s.web!.image).toBe('${HZ_IMAGE_WEB:?HZ_IMAGE_WEB ontbreekt}');
  });

  it('elke variabele in app.yaml komt uit de secrets (prod.keys), hz.env of deploy.sh/preview.sh', () => {
    const vars = new Set([...read('compose/app.yaml').matchAll(/\$\{([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]!));
    const keys = new Set(
      read('secrets/prod.keys')
        .split('\n')
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => l.split(' ')[0]!.replace(/^\?/, '')),
    );
    const hzEnv = new Set(['HZ_REGISTRY', 'HZ_DOMAIN', 'HZ_TEST_DOMAIN']);
    const deploy = read('scripts/deploy.sh') + read('scripts/preview.sh');
    for (const v of vars) {
      const known = keys.has(v) || hzEnv.has(v) || new RegExp(`\\b${v}=`).test(deploy);
      expect(known, `${v} heeft geen bron`).toBe(true);
    }
  });
});

const ENV = {
  HZ_DOMAIN: 'homezero.verveen.me',
  HZ_TEST_DOMAIN: 'test.homezero.verveen.me',
  HZ_ERRORS_DOMAIN: 'fouten.homezero.verveen.me',
};

describe('router van de workspace (HZW-003, HZW-005)', () => {
  const nodes = parseCaddyfile(read('caddy/router/Caddyfile'));
  const directive = (n: Node, name: string) => findAll(n.children ?? [], name);

  it('parset: geen TLS (dat doet de bestaande proxy), sites voor productie, test, previews, fouten, rest en /ask', () => {
    const addresses = nodes.filter((n) => n.children).map((n) => n.tokens.join(' '));
    expect(addresses).toEqual([
      '',
      '(beveiliging)',
      '(log-zonder-pii)',
      'http://{$HZ_DOMAIN}:{$HZ_ROUTER_LISTEN:8080}',
      'http://{$HZ_TEST_DOMAIN}:{$HZ_ROUTER_LISTEN:8080}',
      'http://*.{$HZ_TEST_DOMAIN}:{$HZ_ROUTER_LISTEN:8080}',
      'http://{$HZ_ERRORS_DOMAIN}:{$HZ_ROUTER_LISTEN:8080}',
      'http://:{$HZ_ROUTER_LISTEN:8080}',
      'http://:{$HZ_ROUTER_ASK_LISTEN:8081}',
    ]);
    expect(findAll(nodes[0]!.children!, 'auto_https')[0]!.tokens).toEqual(['auto_https', 'off']);
  });

  it('productie, test, previews en GlitchTip naar hun eigen container op hz-workspace-net', () => {
    const rp = (a: string) => directive(site(nodes, a), 'reverse_proxy')[0]!.tokens;
    expect(rp('http://{$HZ_DOMAIN}:{$HZ_ROUTER_LISTEN:8080}')).toEqual(['reverse_proxy', 'hz-workspace-prod-web:8080']);
    expect(rp('http://{$HZ_TEST_DOMAIN}:{$HZ_ROUTER_LISTEN:8080}')).toEqual([
      'reverse_proxy',
      'hz-workspace-test-web:8080',
    ]);
    expect(rp('http://{$HZ_ERRORS_DOMAIN}:{$HZ_ROUTER_LISTEN:8080}')).toEqual([
      'reverse_proxy',
      'hz-workspace-ops-glitchtip:8000',
    ]);
    const p = site(nodes, 'http://*.{$HZ_TEST_DOMAIN}:{$HZ_ROUTER_LISTEN:8080}');
    expect(directive(p, '@preview')[0]!.tokens).toEqual([
      '@preview',
      'header_regexp',
      'pr',
      'Host',
      '^pr-([0-9]{1,6})\\.',
    ]);
    expect(directive(p, 'basic_auth')[0]!.children![0]!.tokens).toEqual(['{$HZ_PREVIEW_USER}', '{$HZ_PREVIEW_HASH}']);
    expect(directive(p, 'reverse_proxy')[0]!.tokens).toEqual(['reverse_proxy', 'hz-workspace-pr-{re.pr.1}-web:8080']);
  });

  it('HSTS en nosniff op alle sites; logs zonder IP, headers of OAuth-codes', () => {
    const sec = site(nodes, '(beveiliging)');
    const headers = sec.children![0]!.children!.map((n) => n.tokens[0]);
    expect(headers).toContain('Strict-Transport-Security');
    expect(headers).toContain('X-Content-Type-Options');
    for (const a of ['{$HZ_DOMAIN}', '{$HZ_TEST_DOMAIN}', '*.{$HZ_TEST_DOMAIN}', '{$HZ_ERRORS_DOMAIN}']) {
      const imports = directive(site(nodes, `http://${a}:{$HZ_ROUTER_LISTEN:8080}`), 'import').map((n) => n.tokens[1]);
      expect(imports, a).toEqual(['beveiliging', 'log-zonder-pii']);
    }
    const log = JSON.stringify(site(nodes, '(log-zonder-pii)'));
    expect(log).toContain('request>remote_ip');
    expect(log).toContain('ip_mask');
    expect(log).toContain('"request>headers","delete"');
    expect(log).toContain('"replace","code","REDACTED"');
  });

  it('een fout in de Caddyfile wordt gevonden', () => {
    expect(() => parseCaddyfile('a {\n b\n')).toThrow(/ontbrekende/);
    expect(() => parseCaddyfile('a {\n b }\n}\n')).toThrow(/eigen regel/);
  });
});

describe('site-blok voor de bestaande proxy (proxy-snippet.sh, HZW-003)', () => {
  const snippet = (env: Record<string, string>, kind = 'caddy') =>
    execFileSync('bash', [join(INFRA, 'scripts/proxy-snippet.sh'), kind], {
      env: { PATH: process.env.PATH, ...ENV, ...env },
      encoding: 'utf8',
    });

  it('Caddy in Docker: onze drie domeinen en de wildcard voor previews naar hz-workspace-router, tussen markeringen', () => {
    const out = snippet({ HZ_PROXY_NETWORK: 'caddy' });
    const nodes = parseCaddyfile(out);
    const sites = nodes.filter((n) => n.children).map((n) => n.tokens.join(' '));
    expect(sites).toEqual([
      'homezero.verveen.me, test.homezero.verveen.me, fouten.homezero.verveen.me',
      '*.test.homezero.verveen.me',
      'on_demand_tls',
    ]);
    expect(findAll(nodes, 'reverse_proxy').map((n) => n.tokens)).toEqual([
      ['reverse_proxy', 'hz-workspace-router:8080'],
      ['reverse_proxy', 'hz-workspace-router:8080'],
    ]);
    expect(findAll(site(nodes, '*.test.homezero.verveen.me').children!, 'on_demand')).toHaveLength(1);
    expect(findAll(nodes, 'ask')[0]!.tokens).toEqual(['ask', 'http://hz-workspace-router:8081/ask']);
    expect(out.match(/^# >>> hz-workspace/gm)).toHaveLength(2);
    expect(out.match(/^# <<< hz-workspace$/gm)).toHaveLength(2);
  });

  it('Caddy op de host: naar 127.0.0.1 op de routerpoort', () => {
    const out = snippet({ HZ_ROUTER_PORT: '18780' });
    expect(out).toContain('reverse_proxy 127.0.0.1:18780');
    expect(out).toContain('ask http://127.0.0.1:18781/ask');
  });

  it('Traefik: niets aan Traefik zelf, wel een netwerk; zonder netwerk weigert het', () => {
    expect(snippet({ HZ_PROXY_NETWORK: 'coolify' }, 'traefik')).toContain('Netwerk: coolify');
    expect(() => snippet({ HZ_ROUTER_PORT: '18780' }, 'traefik')).toThrow();
  });

  it('de eigen edge (alleen voor HZW-082) gebruikt exact dezelfde site-blokken via import', () => {
    const edge = parseCaddyfile(read('caddy/edge/Caddyfile'));
    expect(findAll(edge, 'import').map((n) => n.tokens[1])).toEqual([
      '/etc/caddy/hz-workspace.global.caddy',
      '/etc/caddy/hz-workspace.caddy',
    ]);
    expect(findAll(edge, 'reverse_proxy')).toHaveLength(0);
    expect(read('scripts/deploy.sh')).toContain('"$here/proxy-snippet.sh" caddy --out "$HZ_ROOT/edge"');
  });
});

describe('web-container (Caddy + SPA)', () => {
  const nodes = parseCaddyfile(read('docker/web.Caddyfile'));
  const srv = site(nodes, ':8080');

  it('/api naar de api van dezelfde instantie, zonder buffer (SSE); SPA-terugval op index.html', () => {
    const api = findAll(srv.children!, 'handle').find((h) => h.tokens[1] === '/api/*')!;
    const rp = findAll(api.children!, 'reverse_proxy')[0]!;
    expect(rp.tokens).toEqual(['reverse_proxy', '{$HZ_API_UPSTREAM:api:8700}']);
    expect(rp.children!.map((c) => c.tokens)).toEqual([['flush_interval', '-1']]);
    expect(findAll(srv.children!, 'try_files')[0]!.tokens).toEqual(['try_files', '{path}', '/index.html']);
    expect(findAll(srv.children!, 'import')[0]!.tokens).toEqual(['import', '/etc/caddy/csp.caddy']);
    expect(findAll(nodes[0]!.children!, 'auto_https')[0]!.tokens).toEqual(['auto_https', 'off']);
  });

  it('CSP: script-src alleen self plus de hash van het inline thema-script; geen inbedding', () => {
    const html = readFileSync(join(APP, 'apps/web/index.html'), 'utf8');
    const inline = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
    const hash = `'sha256-${createHash('sha256').update(inline).digest('base64')}'`;
    expect(inlineScriptHashes(html)).toEqual([hash]);
    const csp: string = buildCsp(html);
    const scriptSrc = csp.split('; ').find((d) => d.startsWith('script-src'))!;
    expect(scriptSrc).toBe(`script-src 'self' ${hash}`);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
  });
});

describe('Dockerfiles (HZW-004, HZW-006)', () => {
  const files = ['api', 'worker', 'web'].map((n) => [n, read(`docker/${n}.Dockerfile`)] as const);

  it.each(files)('%s: vaste basisversies, niet-root, healthcheck, geen secrets in ENV/ARG', (name, text) => {
    const froms = [...text.matchAll(/^ARG (NODE_IMAGE|CADDY_IMAGE)=(\S+)/gm)].map((m) => m[2]!);
    expect(froms.length).toBeGreaterThan(0);
    for (const f of froms) expect(f, name).toMatch(/:\d+\.\d+\.\d+-alpine/);
    const final = text.slice(text.lastIndexOf('\nFROM '));
    expect(final).toMatch(/^USER (node|65534:65534)$/m);
    expect(final).toMatch(/^HEALTHCHECK /m);
    for (const m of text.matchAll(/^(ENV|ARG) (.+)$/gm))
      expect(m[2], name).not.toMatch(/(PASSWORD|SECRET|TOKEN_KEY|API_KEY)=/);
    expect(text).toContain('pnpm install --offline --frozen-lockfile');
  });

  it('api en worker bouwen met hetzelfde script dat de lokale test draait', () => {
    expect(read('docker/api.Dockerfile')).toContain('RUN infra/docker/build-app.sh api /out');
    expect(read('docker/worker.Dockerfile')).toContain('RUN infra/docker/build-app.sh worker /out');
    expect(read('docker/web.Dockerfile')).toContain(
      'node infra/docker/web-csp.mjs apps/web/dist/index.html /out/csp.caddy',
    );
  });

  it('.dockerignore houdt node_modules, builds, .env en ontsleutelde secrets buiten het image', () => {
    const ig = readFileSync(join(APP, '.dockerignore'), 'utf8').split('\n');
    for (const l of ['**/node_modules', '**/dist', '.env', '.env.*', 'infra/secrets/*.env']) expect(ig).toContain(l);
  });
});

describe('GitHub Actions (HZW-001, HZW-004, HZW-005)', () => {
  const wfDir = join(ROOT, '.github/workflows');
  const ajv = new Ajv({ strict: false, allErrors: true });
  const validate = ajv.compile(schema('github-workflow.json'));
  const wf = (f: string) => parse(readFileSync(join(wfDir, f), 'utf8'));
  const names = readdirSync(wfDir).filter((f) => f.startsWith('workspace-'));

  it('alle workflows van de workspace voldoen aan het workflow-schema', () => {
    expect(names.sort()).toEqual([
      'workspace-app.yml',
      'workspace-deploy.yml',
      'workspace-infra.yml',
      'workspace-preview.yml',
      'workspace-server-check.yml',
    ]);
    for (const f of names) expect(validate(wf(f)), `${f}: ${errorsOf(validate)}`).toBe(true);
  });

  it('CI draait lint, typecheck, test (met age, shellcheck en caddy voor de infra-tests), build en e2e', () => {
    const steps = wf('workspace-app.yml').jobs.check.steps as { run?: string }[];
    const runs = steps.map((s) => s.run ?? '');
    for (const r of ['pnpm lint', 'pnpm typecheck', 'pnpm test', 'pnpm build', 'pnpm test:e2e'])
      expect(runs).toContain(r);
    const iAge = runs.findIndex((r) => r.includes('install') && r.includes(' age'));
    expect(iAge).toBeGreaterThan(-1);
    expect(runs[iAge]).toContain('shellcheck');
    expect(runs[iAge]).toContain('caddy');
    expect(iAge).toBeLessThan(runs.indexOf('pnpm test'));
  });

  it('uitrol: images naar GHCR, test bij merge op main, productie bij een release met goedkeuring, health-check', () => {
    const d = wf('workspace-deploy.yml');
    expect(d.on.push.branches).toEqual(['main']);
    // Uit tot de server bestaat: zonder HZ_DEPLOY_HOST slaat de hele uitrol zich over (nieuwe repo blijft groen).
    expect(d.jobs.meta.if).toBe("vars.HZ_DEPLOY_HOST != ''");
    expect(wf('workspace-server-check.yml').jobs.check.if).toBe("vars.HZ_DEPLOY_HOST != ''");
    expect(d.on.release.types).toEqual(['published']);
    const build = d.jobs.build;
    const pushes = build.steps.filter((s: { uses?: string }) => s.uses?.startsWith('docker/build-push-action'));
    expect(pushes.map((p: { id: string }) => p.id)).toEqual(['api', 'worker', 'web']);
    for (const p of pushes) {
      expect(p.with.push).toBe(true);
      expect(p.with.tags).toContain(`/hz-${p.id}:\${{ needs.meta.outputs.sha_tag }}`);
      expect(p.with.file).toBe(`${APP_PREFIX}infra/docker/${p.id}.Dockerfile`);
    }
    // De digests uit deze run gaan mee naar de server (die legt ze vast; tags in de registry zijn overschrijfbaar).
    expect(build.outputs.digests).toBe('${{ steps.d.outputs.digests }}');
    const dstep = build.steps.find((s: { id?: string }) => s.id === 'd');
    expect(dstep.env).toEqual({
      API: '${{ steps.api.outputs.digest }}',
      WORKER: '${{ steps.worker.outputs.digest }}',
      WEB: '${{ steps.web.outputs.digest }}',
    });
    expect(JSON.stringify(d.jobs.meta)).toContain('ghcr.io/${OWNER,,}');
    // Release bouwt niet opnieuw: de geteste images krijgen de releasetag.
    expect(d.jobs.retag.if).toBe("github.event_name == 'release'");
    expect(JSON.stringify(d.jobs.retag)).toContain('imagetools create');
    // Productie alleen via de omgeving 'production' (verplichte goedkeuring = één klik).
    expect(d.jobs.deploy.environment.name).toBe('${{ needs.meta.outputs.environment }}');
    const meta = JSON.stringify(d.jobs.meta);
    expect(meta).toContain('environment=production');
    expect(meta).toContain('environment=test');
    // Wat de server te horen krijgt: test met de digests van de build, productie de release plus de sha die op test
    // stond, handmatig productie alleen een bestaande v-tag.
    expect(meta).toContain('command=deploy prod $RELEASE_TAG $sha_tag');
    expect(meta).toContain('command=deploy test $sha_tag');
    expect(meta).toContain('command=deploy prod $INPUT_TAG');
    expect(meta).toContain('productie: alleen een bestaande releasetag');
    const steps = JSON.stringify(d.jobs.deploy.steps);
    expect(steps).toContain('ci-ssh.sh \\"$HOST\\" $COMMAND $DIGESTS');
    expect(steps).toContain('${{ needs.build.outputs.digests }}');
    expect(steps).toContain('/api/health');
    expect(steps).toContain('tls-check.sh');
  });

  it('preview: bouwt en start per PR, link in de PR, ruimt op bij sluiten/mergen, nooit voor forks', () => {
    const p = wf('workspace-preview.yml');
    expect(p.on.pull_request.types).toEqual(['opened', 'synchronize', 'reopened', 'closed']);
    expect(p.jobs.meta.if).toBe(
      "github.event.pull_request.head.repo.full_name == github.repository && vars.HZ_DEPLOY_HOST != ''",
    );
    expect(JSON.stringify(p.jobs.up.steps)).toContain('preview up \\"$PR\\" \\"$TAG\\"');
    expect(JSON.stringify(p.jobs.up.steps)).toContain('gh pr comment');
    expect(p.jobs.down.if).toBe("github.event.action == 'closed'");
    expect(JSON.stringify(p.jobs.down.steps)).toContain('preview down \\"$PR\\"');
    expect(p.jobs.up.environment.url).toBe(
      'https://pr-${{ github.event.pull_request.number }}.${{ vars.HZ_TEST_DOMAIN }}',
    );
    // Beide jobs in de environment 'preview', als gebruiker hz-preview met de preview-sleutel.
    for (const j of ['up', 'down']) {
      expect(p.jobs[j].environment.name, j).toBe('preview');
      const st = JSON.stringify(p.jobs[j].steps);
      expect(st, j).toContain('"HZ_SSH_USER":"hz-preview"');
      expect(st, j).toContain('${{ secrets.HZ_PREVIEW_SSH_KEY }}');
    }
  });

  it('secrets per doel (HZW-004): sleutels en Tailscale alleen in een environment, preview nooit bij test of productie', () => {
    const SECRET = /secrets\.(TS_OAUTH_\w+|HZ_DEPLOY_SSH_KEY\w*|HZ_PREVIEW_SSH_KEY)/g;
    const used: Record<string, Set<string>> = {};
    for (const f of names)
      for (const [job, j] of Object.entries(wf(f).jobs as Record<string, { environment?: { name: string } }>)) {
        const found = [...JSON.stringify(j).matchAll(SECRET)].map((m) => m[1]!);
        if (!found.length) continue;
        // Wie een sleutel of de Tailscale-client gebruikt, staat in een environment (anders zou het een repo-secret
        // moeten zijn, en die kan elke pull request lezen).
        expect(j.environment?.name, `${f}/${job}`).toBeTruthy();
        used[`${f}/${job}`] = new Set(found);
      }
    expect(Object.fromEntries(Object.entries(used).map(([k, v]) => [k, [...v].sort()]))).toEqual({
      'workspace-deploy.yml/deploy': [
        'HZ_DEPLOY_SSH_KEY_PROD',
        'HZ_DEPLOY_SSH_KEY_TEST',
        'TS_OAUTH_CLIENT_ID',
        'TS_OAUTH_SECRET',
      ],
      'workspace-preview.yml/up': ['HZ_PREVIEW_SSH_KEY', 'TS_OAUTH_CLIENT_ID', 'TS_OAUTH_SECRET'],
      'workspace-preview.yml/down': ['HZ_PREVIEW_SSH_KEY', 'TS_OAUTH_CLIENT_ID', 'TS_OAUTH_SECRET'],
      'workspace-server-check.yml/check': ['HZ_DEPLOY_SSH_KEY_TEST', 'TS_OAUTH_CLIENT_ID', 'TS_OAUTH_SECRET'],
    });
    // De productiesleutel alleen als de environment production is.
    const key = JSON.stringify(wf('workspace-deploy.yml').jobs.deploy.steps);
    expect(key).toContain(
      "needs.meta.outputs.environment == 'production' && secrets.HZ_DEPLOY_SSH_KEY_PROD || secrets.HZ_DEPLOY_SSH_KEY_TEST",
    );
    expect(wf('workspace-server-check.yml').jobs.check.environment.name).toBe('test');
  });

  it('gereedschap uit een download alleen na een sha256-controle (geen curl | tar)', () => {
    let downloads = 0;
    for (const f of names)
      for (const j of Object.values(wf(f).jobs as Record<string, { steps?: Step[] }>))
        for (const st of j.steps ?? []) {
          const run = st.run ?? '';
          expect(run, `${f}: ${st.name}`).not.toMatch(/curl [^\n]*\|\s*(sudo )?(tar|sh|bash)\b/);
          for (const m of run.matchAll(/curl -fsSL -o "([^"]+)"/g)) {
            downloads++;
            const file = m[1]!;
            const check = run.indexOf(`sha256sum -c -`, m.index);
            const use = run.indexOf(`tar -xzf "${file}"`);
            expect(check, `${f}: ${file} zonder sha256-controle`).toBeGreaterThan(m.index!);
            expect(use, `${f}: ${file} gebruikt vóór de controle`).toBeGreaterThan(check);
            expect(run).toMatch(
              new RegExp(`echo "\\$\\{\\w+_SHA256\\}  ${file.replace(/\$/g, '\\$')}" \\| sha256sum -c -`),
            );
          }
        }
    expect(downloads).toBe(3); // caddy (app, infra) en actionlint (infra)
    for (const f of ['workspace-app.yml', 'workspace-infra.yml'])
      expect(JSON.stringify(wf(f))).toMatch(/"CADDY_SHA256":"[0-9a-f]{64}"/);
  });

  it('servercontrole: wekelijks, van buiten vóór de Tailscale-stap, van binnen via het tailnet, uitkomst in het issue', () => {
    const s = wf('workspace-server-check.yml');
    expect(s.on.schedule[0].cron).toMatch(/^\d+ \d+ \* \* 1$/);
    const steps = s.jobs.check.steps as Step[];
    const iExtern = steps.findIndex((st) => st.run?.includes('server-check.sh --extern'));
    const iTs = steps.findIndex((st) => st.uses?.startsWith('tailscale/github-action@'));
    const iIn = steps.findIndex((st) => st.run?.includes('ci-ssh.sh "$HOST" check'));
    expect(iExtern).toBeGreaterThan(-1);
    expect(iExtern).toBeLessThan(iTs);
    expect(iTs).toBeLessThan(iIn);
    expect(JSON.stringify(steps)).toContain('gh issue comment');
  });

  type Step = { name?: string; uses?: string; run?: string; with?: Record<string, string> };
  it('nooit publieke SSH (HZW-004): vóór elke SSH-stap een tijdelijke Tailscale-node met tag:ci, SSH alleen via ci-ssh.sh', () => {
    let sshSteps = 0;
    for (const f of names) {
      for (const [job, j] of Object.entries(wf(f).jobs as Record<string, { steps?: Step[] }>)) {
        const steps = j.steps ?? [];
        steps.forEach((st, i) => {
          const run = st.run ?? '';
          // Elke ssh/scp-aanroep naar de server loopt via ci-ssh.sh; geen kale ssh of 'deploy@<host>'.
          const bare = run
            .split('\n')
            .filter((l) => /(^|[\s|;&(])(ssh|scp|sftp)\s/.test(l) && !l.includes('ci-ssh.sh'));
          expect(bare, `${f}/${job}: ${st.name}`).toEqual([]);
          expect(run, `${f}/${job}`).not.toMatch(/\w@\$\{?\{? ?(vars\.)?HZ_DEPLOY_HOST|deploy@/);
          if (!run.includes('ci-ssh.sh')) return;
          sshSteps++;
          const ts = steps.slice(0, i).find((p) => p.uses?.startsWith('tailscale/github-action@'));
          expect(ts, `${f}/${job}: ${st.name} zonder Tailscale-stap ervoor`).toBeTruthy();
          expect(ts!.with).toEqual({
            'oauth-client-id': '${{ secrets.TS_OAUTH_CLIENT_ID }}',
            'oauth-secret': '${{ secrets.TS_OAUTH_SECRET }}',
            tags: 'tag:ci',
          });
        });
      }
    }
    // deploy, preview up, preview down en de servercontrole.
    expect(sshSteps).toBe(4);
  });

  it('standaard alleen leesrechten; schrijfrechten alleen per job waar nodig', () => {
    for (const f of names) expect(wf(f).permissions ?? { contents: 'read' }, f).toMatchObject({ contents: 'read' });
  });
});

describe('cloud-init: alleen een optie voor een eigen server (HZW-082)', () => {
  const base = {
    domain: 'homezero.verveen.me',
    testDomain: 'test.homezero.verveen.me',
    errorsDomain: 'fouten.homezero.verveen.me',
    acmeEmail: 'robert@homezero.nl',
    registry: 'ghcr.io/homezerotech',
    adminKeys: [sshPublicKey('robert')],
    deployKey: sshPublicKey('deploy'),
    tailscaleAuthKey: 'tskey-auth-voorbeeldvoorbeeld',
  };
  const text: string = renderCloudInit(base);
  const doc = parse(text);
  const files = new Map<string, { content: string; permissions: string; owner: string; encoding?: string }>(
    doc.write_files.map((f: { path: string }) => [f.path, f]),
  );
  const cmds = (doc.runcmd as (string | string[])[]).map((c) => (Array.isArray(c) ? c.join(' ') : c));

  it('is een geldige cloud-config volgens het schema van cloud-init, en past in de 32 KiB van Hetzner', () => {
    expect(text.startsWith('#cloud-config\n')).toBe(true);
    const ajv = new AjvDraft04({ strict: false, allErrors: true });
    const validate = ajv.compile(schema('cloud-config-v1.json'));
    expect(validate(doc), errorsOf(validate)).toBe(true);
    expect(Buffer.byteLength(text)).toBeLessThan(32 * 1024);
  });

  it('is als optie gemarkeerd, niet de hoofdroute (die is server-setup.sh op de bestaande server)', () => {
    const src = read('cloud-init/render.mjs');
    expect(src).toContain('OPTIONEEL, alleen voor HZW-082');
    expect(read('scripts/hetzner-create.sh')).toContain('OPTIONEEL, alleen voor HZW-082');
    expect(text).toContain('eigen server (optie voor HZW-082)');
  });

  it('Tailscale geïnstalleerd en aangemeld met een eenmalige sleutel, die daarna weg is', () => {
    expect(cmds.some((c) => c.includes('pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg'))).toBe(true);
    const up = cmds.find((c) => c.includes('tailscale up'))!;
    expect(up).toContain('--auth-key=file:/root/hz-workspace-setup/tailscale.key');
    expect(up).toContain('shred -u /root/hz-workspace-setup/tailscale.key');
    expect(files.get('/root/hz-workspace-setup/tailscale.key')!.permissions).toBe('0600');
    expect(() => renderCloudInit({ ...base, tailscaleAuthKey: '' })).toThrow(/Tailscale/);
  });

  it('firewall: standaard dicht, publiek alleen 443, SSH alleen op tailscale0 (pas nadat Tailscale draait)', () => {
    const ufw = doc.runcmd.filter((c: string[]) => c[0] === 'ufw').map((c: string[]) => c.slice(1).join(' '));
    expect(ufw).toEqual([
      'default deny incoming',
      'default allow outgoing',
      'allow in on tailscale0 to any port 22 proto tcp',
      'allow 443/tcp',
      'allow 443/udp',
      '--force enable',
    ]);
    expect(cmds.findIndex((c) => c.includes('tailscale up'))).toBeLessThan(cmds.indexOf('ufw --force enable'));
    expect(text).not.toMatch(/allow (22|80)\/tcp/);
  });

  it('SSH alleen met sleutel: geen wachtwoorden, geen root; alleen de beheerder hz en hz-workspace', () => {
    expect(doc.ssh_pwauth).toBe(false);
    expect(doc.disable_root).toBe(true);
    const sshd = files.get('/etc/ssh/sshd_config.d/10-hz-workspace.conf')!.content;
    for (const l of [
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'PermitRootLogin no',
      'PubkeyAuthentication yes',
      'AllowUsers hz hz-workspace',
    ])
      expect(sshd).toContain(l);
    expect(doc.users).toHaveLength(1);
    expect(doc.users[0].name).toBe('hz');
    expect(doc.users[0].lock_passwd).toBe(true);
    expect(doc.users[0].ssh_authorized_keys).toEqual(base.adminKeys);
  });

  it('automatische beveiligingsupdates met herstart om 04:00; Docker uit de officiële repository', () => {
    expect(files.get('/etc/apt/apt.conf.d/20auto-upgrades')!.content).toContain(
      'APT::Periodic::Unattended-Upgrade "1";',
    );
    expect(files.get('/etc/apt/apt.conf.d/52unattended-upgrades-hz-workspace')!.content).toContain(
      'Automatic-Reboot-Time "04:00"',
    );
    expect(doc.packages).toEqual(
      expect.arrayContaining(['unattended-upgrades', 'docker-ce', 'docker-compose-plugin', 'age', 'ufw']),
    );
    expect(doc.apt.sources.docker.keyid).toBe('9DC858229FC7DD38854AE2D88D81803C0EBFCD88');
  });

  it('daarna precies dezelfde stap als op de bestaande server: server-setup.sh met een eigen edge; bestanden exact uit de repo', () => {
    const setup = doc.runcmd.find((c: string[]) => Array.isArray(c) && c[0]?.endsWith('/scripts/server-setup.sh'));
    expect(setup.slice(1, 3)).toEqual(['--proxy', 'eigen']);
    expect(setup).toEqual(expect.arrayContaining(['--domain', 'homezero.verveen.me', '--deploy-key-prod']));
    expect(files.get('/root/hz-workspace-setup/deploy.pub')!.content).toBe(`${base.deployKey}\n`);
    const tgz = files.get('/root/hz-workspace-setup/infra.tar.gz')!;
    expect(tgz.encoding).toBe('b64');
    const dir = tmp('hz-e0-ci-');
    writeFileSync(join(dir, 'b.tgz'), Buffer.from(tgz.content, 'base64'));
    execFileSync('tar', ['-xzf', join(dir, 'b.tgz'), '-C', dir]);
    for (const f of SETUP_FILES) expect(readFileSync(join(dir, f), 'utf8'), f).toBe(read(f));
    expect(SETUP_FILES).toEqual(expect.arrayContaining(['scripts/server-setup.sh', 'scripts/server-check.sh']));
    expect(cmds.findIndex((c) => c.includes('infra.tar.gz'))).toBeLessThan(
      cmds.findIndex((c) => c.includes('server-setup.sh')),
    );
  });

  it('ander domein of tweede server = alleen andere waarden (geen codewijziging)', () => {
    const other = parse(
      renderCloudInit({
        ...base,
        domain: 'proef.homezero.nl',
        testDomain: 'test.proef.homezero.nl',
        errorsDomain: 'fouten.proef.homezero.nl',
      }),
    );
    const strip = (d: { runcmd: unknown[] }) => ({
      ...d,
      runcmd: d.runcmd.filter((c) => !(Array.isArray(c) && String(c[0]).endsWith('server-setup.sh'))),
    });
    expect(strip(other)).toEqual(strip(doc));
    expect(JSON.stringify(other.runcmd)).toContain('proef.homezero.nl');
  });

  it('weigert ongeldige invoer', () => {
    expect(() => renderCloudInit({ ...base, domain: 'niet een domein' })).toThrow(/domein/);
    expect(() => renderCloudInit({ ...base, adminKeys: [] })).toThrow(/beheerder/);
    expect(() => renderCloudInit({ ...base, deployKey: 'ssh-rsa' })).toThrow(/SSH-sleutel/);
    expect(() => renderCloudInit({ ...base, registry: 'GHCR' })).toThrow(/registry/);
  });
});

describe('Tailscale-policy voor CI (HZW-004)', () => {
  const hujson = read('tailscale/acl.hujson');
  // HuJSON -> JSON: commentaar en komma's aan het eind weg.
  const policy = JSON.parse(
    hujson
      .split('\n')
      .map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/ .*$/, ''))
      .join('\n')
      .replace(/,(\s*[}\]])/g, '$1'),
  );

  it('tag:ci mag alleen naar poort 22 van de server; Tailscale controleert dat zelf met tests bij het opslaan', () => {
    expect(policy.tagOwners['tag:ci']).toEqual(['autogroup:admin']);
    const fromCi = policy.acls.filter((r: { src: string[] }) => r.src.includes('tag:ci'));
    expect(fromCi).toEqual([{ action: 'accept', src: ['tag:ci'], dst: ['hz-server:22'] }]);
    expect(policy.acls.some((r: { src: string[] }) => r.src.includes('*'))).toBe(false);
    expect(policy.tests).toEqual([
      expect.objectContaining({
        src: 'tag:ci',
        accept: ['hz-server:22'],
        deny: expect.arrayContaining(['hz-server:443']),
      }),
    ]);
    expect(hujson).toContain('autogroup:member');
  });
});

describe('geen secrets leesbaar in Git (HZW-006)', () => {
  const tracked = execFileSync('git', ['ls-files', '-z', '--', '.'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .filter((f) => !/\.(png|woff2|jpg|ico)$/.test(f));

  const patterns: [string, RegExp][] = [
    ['age-geheime sleutel', /AGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}/],
    ['privésleutel', /-----BEGIN (OPENSSH|RSA|EC|PGP)? ?PRIVATE KEY( BLOCK)?-----/],
    ['Slack-token', /xox[abposr]-\d{6,}-\d{6,}-[A-Za-z0-9]{10,}/],
    ['GitHub-token', /\bgh[pousr]_[A-Za-z0-9]{36}\b|github_pat_[A-Za-z0-9_]{60,}/],
    ['Anthropic-sleutel', /sk-ant-[A-Za-z0-9_-]{40,}/],
    ['Google-clientgeheim', /GOCSPX-[A-Za-z0-9_-]{20,}/],
    ['Hetzner-token', /HCLOUD_TOKEN=[A-Za-z0-9]{64}/],
    ['Tailscale-sleutel', /tskey-(auth|client|api)-[A-Za-z0-9]{6,}-[A-Za-z0-9]{16,}/],
  ];

  it('geen tokens, sleutels of privésleutels in de bestanden van de repo', () => {
    const hits: string[] = [];
    for (const f of tracked) {
      const p = join(ROOT, f);
      if (!existsSync(p)) continue;
      const t = readFileSync(p, 'utf8');
      for (const [what, re] of patterns) if (re.test(t)) hits.push(`${f}: ${what}`);
    }
    expect(hits).toEqual([]);
  });

  it('infra/secrets: alleen versleutelde .age-bestanden, .keys zonder waarden en publieke sleutels', () => {
    const dir = join(INFRA, 'secrets');
    for (const f of readdirSync(dir)) {
      const t = readFileSync(join(dir, f), 'utf8');
      if (f.endsWith('.env.age')) expect(t.startsWith('age-encryption.org/v1\n'), f).toBe(true);
      else if (f.endsWith('.keys')) {
        for (const l of t.split('\n').filter((x) => x && !x.startsWith('#')))
          expect(l, f).toMatch(/^\??[A-Z_][A-Z0-9_]* (gen:hex|gen:b64|mens:C\d+)$/);
      } else if (f === 'recipients.txt') {
        for (const l of t.split('\n').filter((x) => x && !x.startsWith('#')))
          expect(l, f).toMatch(/^age1[0-9a-z]{58}$/);
      } else throw new Error(`onverwacht bestand in infra/secrets: ${f}`);
    }
  });

  it('.gitignore houdt .env-bestanden buiten Git', () => {
    const gi = readFileSync(join(APP, '.gitignore'), 'utf8').split('\n');
    expect(gi).toContain('.env');
    expect(gi).toContain('.env.*');
  });
});
