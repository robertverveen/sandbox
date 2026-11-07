/**
 * Configuratie als code, geparst en tegen de officiële schema's gecontroleerd:
 * compose (HZW-004/005), Caddyfiles (HZW-003), Dockerfiles (HZW-004/006), workflows (HZW-001/004/005),
 * cloud-init (HZW-002, HZW-082) en geen secrets leesbaar in Git (HZW-006).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import AjvDraft04 from 'ajv-draft-04';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { renderCloudInit } from '../cloud-init/render.mjs';
import { buildCsp, inlineScriptHashes } from '../docker/web-csp.mjs';
import { findAll, parseCaddyfile, site, type Node } from './caddyfile';
import { APP, INFRA, ROOT, sshPublicKey } from './helpers';

const read = (p: string) => readFileSync(join(INFRA, p), 'utf8');
const schema = (f: string) => JSON.parse(readFileSync(join(INFRA, 'test/schemas', f), 'utf8'));
const errorsOf = (v: { errors?: unknown }) => JSON.stringify(v.errors, null, 1)?.slice(0, 2000);

type Service = {
  image?: string;
  ports?: unknown[];
  healthcheck?: unknown;
  restart?: string;
  environment?: Record<string, string>;
  networks?: Record<string, { aliases?: string[] } | null>;
  user?: string;
  read_only?: boolean;
  cap_drop?: string[];
  env_file?: string[];
};
type Compose = { name: string; services: Record<string, Service>; networks?: Record<string, { external?: boolean; name?: string }> };

const compose = (f: string) => parse(read(`compose/${f}`), { merge: true }) as Compose;

describe('compose (HZW-004, HZW-005)', () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const validate = ajv.compile(schema('compose-spec.json'));

  it.each(['app.yaml', 'edge.yaml', 'ops.yaml'])('%s voldoet aan de compose-specificatie', (f) => {
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

  it('alleen de edge publiceert poorten (80/443); de database heeft geen open poort', () => {
    for (const [name, s] of Object.entries(compose('app.yaml').services)) expect(s.ports, name).toBeUndefined();
    for (const [name, s] of Object.entries(compose('ops.yaml').services)) expect(s.ports, name).toBeUndefined();
    expect(compose('edge.yaml').services.caddy!.ports).toEqual(['80:80', '443:443', '443:443/udp']);
  });

  it('api en worker: app-login (hz_app_login) voor de app, migratierol alleen voor migrate en pg-boss, geen superuser-wachtwoord', () => {
    const s = compose('app.yaml').services;
    expect(s.api!.environment!.DATABASE_URL).toMatch(/^postgres:\/\/hz_app_login:\$\{HZ_PG_APP_PASSWORD\}@db:5432\/hz$/);
    expect(s.worker!.environment!.DATABASE_URL).toMatch(/^postgres:\/\/hz_app_login:/);
    expect(s.worker!.environment!.HZ_BOSS_DATABASE_URL).toMatch(/^postgres:\/\/hz_migrator:/);
    expect(s.migrate!.environment!.DATABASE_URL).toMatch(/^postgres:\/\/hz_migrator:/);
    for (const n of ['api', 'worker', 'web', 'migrate']) {
      expect(JSON.stringify(s[n])).not.toContain('HZ_PG_SUPERUSER_PASSWORD');
      expect(JSON.stringify(s[n])).not.toContain('HZ_PG_BACKUP_PASSWORD');
    }
    expect(s.api!.environment!.HZ_STORE).toBe('db');
    expect(s.api!.environment!.HZ_DEV_LOGIN).toBe('${HZ_DEV_LOGIN:-0}');
  });

  it('app-containers: alleen-lezen bestandssysteem, geen extra rechten', () => {
    for (const n of ['api', 'worker', 'web', 'migrate']) {
      const s = compose('app.yaml').services[n]!;
      expect(s.read_only, n).toBe(true);
      expect(s.cap_drop, n).toEqual(['ALL']);
    }
  });

  it('web hangt aan het edge-netwerk als <instantie>-web; de edge routeert daarheen', () => {
    const c = compose('app.yaml');
    expect(c.services.web!.networks!.edge!.aliases).toEqual(['${HZ_INSTANCE}-web']);
    expect(c.networks!.edge).toEqual({ external: true, name: 'hz-edge' });
    expect(compose('edge.yaml').networks!.edge).toEqual({ external: true, name: 'hz-edge' });
  });

  it('images met vaste versies (geen latest), app-images uit de registry met de uitroltag', () => {
    for (const f of ['app.yaml', 'edge.yaml', 'ops.yaml'])
      for (const [n, s] of Object.entries(compose(f).services)) {
        expect(s.image, `${f}/${n}`).toBeTruthy();
        expect(s.image, `${f}/${n}`).not.toMatch(/:latest$|^[^:]+$/);
      }
    const s = compose('app.yaml').services;
    expect(s.api!.image).toBe('${HZ_REGISTRY}/hz-api:${HZ_TAG}');
    expect(s.worker!.image).toBe('${HZ_REGISTRY}/hz-worker:${HZ_TAG}');
    expect(s.web!.image).toBe('${HZ_REGISTRY}/hz-web:${HZ_TAG}');
  });

  it('elke variabele in app.yaml komt uit de secrets (prod.keys), /etc/hz/hz.env of deploy.sh', () => {
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

describe('edge-Caddyfile (HZW-003, HZW-005)', () => {
  const nodes = parseCaddyfile(read('caddy/Caddyfile'));
  const directive = (n: Node, name: string) => findAll(n.children ?? [], name);

  it('parset: globale opties, snippets en de sites voor productie, test, previews, fouten', () => {
    const addresses = nodes.filter((n) => n.children).map((n) => n.tokens.join(' '));
    expect(addresses).toEqual([
      '',
      '(beveiliging)',
      '(log-zonder-pii)',
      '{$HZ_DOMAIN}',
      '{$HZ_TEST_DOMAIN}',
      '*.{$HZ_TEST_DOMAIN}',
      '{$HZ_ERRORS_DOMAIN}',
      'http://127.0.0.1:5555',
      'http://127.0.0.1:8081',
    ]);
  });

  it('automatische TLS met ACME-mail; productie en test naar hun eigen web-container', () => {
    const global = nodes[0]!;
    expect(findAll(global.children!, 'email')[0]!.tokens).toEqual(['email', '{$HZ_ACME_EMAIL}']);
    expect(directive(site(nodes, '{$HZ_DOMAIN}'), 'reverse_proxy')[0]!.tokens).toEqual(['reverse_proxy', 'hz-prod-web:8080']);
    expect(directive(site(nodes, '{$HZ_TEST_DOMAIN}'), 'reverse_proxy')[0]!.tokens).toEqual(['reverse_proxy', 'hz-test-web:8080']);
    // Geen 'auto_https off' of http://-adres voor de publieke sites: Caddy stuurt http zelf door naar https.
    expect(findAll(nodes, 'auto_https')).toHaveLength(0);
  });

  it('preview: on-demand TLS alleen voor aangemelde previews, wachtwoord, routering op pr-<nr>', () => {
    const p = site(nodes, '*.{$HZ_TEST_DOMAIN}');
    expect(directive(p, 'on_demand')).toHaveLength(1);
    expect(directive(p, '@preview')[0]!.tokens).toEqual(['@preview', 'header_regexp', 'pr', 'Host', '^pr-([0-9]{1,6})\\.']);
    expect(directive(p, 'basic_auth')[0]!.children![0]!.tokens).toEqual(['{$HZ_PREVIEW_USER}', '{$HZ_PREVIEW_HASH}']);
    expect(directive(p, 'reverse_proxy')[0]!.tokens).toEqual(['reverse_proxy', 'hz-pr-{re.pr.1}-web:8080']);
    const ask = findAll(nodes[0]!.children!, 'ask')[0]!;
    expect(ask.tokens).toEqual(['ask', 'http://127.0.0.1:5555/ask']);
    const askSite = site(nodes, 'http://127.0.0.1:5555');
    expect(directive(askSite, 'bind')[0]!.tokens).toEqual(['bind', '127.0.0.1']);
    expect(directive(askSite, 'try_files')[0]!.tokens).toEqual(['try_files', '{query.domain}']);
  });

  it('HSTS en nosniff op alle publieke sites; logs zonder IP, headers of OAuth-codes', () => {
    const sec = site(nodes, '(beveiliging)');
    const headers = sec.children![0]!.children!.map((n) => n.tokens[0]);
    expect(headers).toContain('Strict-Transport-Security');
    expect(headers).toContain('X-Content-Type-Options');
    for (const a of ['{$HZ_DOMAIN}', '{$HZ_TEST_DOMAIN}', '*.{$HZ_TEST_DOMAIN}', '{$HZ_ERRORS_DOMAIN}']) {
      const imports = directive(site(nodes, a), 'import').map((n) => n.tokens[1]);
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
    for (const m of text.matchAll(/^(ENV|ARG) (.+)$/gm)) expect(m[2], name).not.toMatch(/(PASSWORD|SECRET|TOKEN_KEY|API_KEY)=/);
    expect(text).toContain('pnpm install --offline --frozen-lockfile');
  });

  it('api en worker bouwen met hetzelfde script dat de lokale test draait', () => {
    expect(read('docker/api.Dockerfile')).toContain('RUN infra/docker/build-app.sh api /out');
    expect(read('docker/worker.Dockerfile')).toContain('RUN infra/docker/build-app.sh worker /out');
    expect(read('docker/web.Dockerfile')).toContain('node infra/docker/web-csp.mjs apps/web/dist/index.html /out/csp.caddy');
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

  it('CI draait lint, typecheck, test (met age voor de infra-tests), build en e2e', () => {
    const steps = wf('workspace-app.yml').jobs.check.steps as { run?: string }[];
    const runs = steps.map((s) => s.run ?? '');
    for (const r of ['pnpm lint', 'pnpm typecheck', 'pnpm test', 'pnpm build', 'pnpm test:e2e']) expect(runs).toContain(r);
    const iAge = runs.findIndex((r) => r.includes('install') && r.includes(' age'));
    expect(iAge).toBeGreaterThan(-1);
    expect(iAge).toBeLessThan(runs.indexOf('pnpm test'));
  });

  it('uitrol: images naar GHCR, test bij merge op main, productie bij een release met goedkeuring, health-check', () => {
    const d = wf('workspace-deploy.yml');
    expect(d.on.push.branches).toEqual(['main']);
    expect(d.on.release.types).toEqual(['published']);
    const build = d.jobs.build;
    expect(build.strategy.matrix.image).toEqual(['api', 'worker', 'web']);
    const push = build.steps.find((s: { uses?: string }) => s.uses?.startsWith('docker/build-push-action'));
    expect(push.with.push).toBe(true);
    expect(push.with.tags).toContain('/hz-${{ matrix.image }}:${{ needs.meta.outputs.sha_tag }}');
    expect(JSON.stringify(d.jobs.meta)).toContain('ghcr.io/${OWNER,,}');
    // Release bouwt niet opnieuw: de geteste images krijgen de releasetag.
    expect(d.jobs.retag.if).toBe("github.event_name == 'release'");
    expect(JSON.stringify(d.jobs.retag)).toContain('imagetools create');
    // Productie alleen via de omgeving 'production' (verplichte goedkeuring = één klik).
    expect(d.jobs.deploy.environment.name).toBe('${{ needs.meta.outputs.environment }}');
    const meta = JSON.stringify(d.jobs.meta);
    expect(meta).toContain('environment=production');
    expect(meta).toContain('environment=test');
    const steps = JSON.stringify(d.jobs.deploy.steps);
    expect(steps).toContain('deploy $target $TAG');
    expect(steps).toContain('/api/health');
    expect(steps).toContain('tls-check.sh');
  });

  it('preview: bouwt en start per PR, link in de PR, ruimt op bij sluiten/mergen, nooit voor forks', () => {
    const p = wf('workspace-preview.yml');
    expect(p.on.pull_request.types).toEqual(['opened', 'synchronize', 'reopened', 'closed']);
    expect(p.jobs.meta.if).toBe('github.event.pull_request.head.repo.full_name == github.repository');
    expect(JSON.stringify(p.jobs.up.steps)).toContain('preview up $PR $TAG');
    expect(JSON.stringify(p.jobs.up.steps)).toContain('gh pr comment');
    expect(p.jobs.down.if).toBe("github.event.action == 'closed'");
    expect(JSON.stringify(p.jobs.down.steps)).toContain('preview down $PR');
    expect(p.jobs.up.environment.url).toBe('https://pr-${{ github.event.pull_request.number }}.${{ vars.HZ_TEST_DOMAIN }}');
  });

  it('servercontrole: wekelijks, uitkomst in het issue', () => {
    const s = wf('workspace-server-check.yml');
    expect(s.on.schedule[0].cron).toMatch(/^\d+ \d+ \* \* 1$/);
    expect(JSON.stringify(s.jobs.check.steps)).toContain('gh issue comment');
    expect(JSON.stringify(s.jobs.check.steps)).toContain('server-check.sh --extern');
  });

  it('standaard alleen leesrechten; schrijfrechten alleen per job waar nodig', () => {
    for (const f of names) expect(wf(f).permissions ?? { contents: 'read' }, f).toMatchObject({ contents: 'read' });
  });
});

describe('cloud-init (HZW-002, HZW-082)', () => {
  const base = {
    domain: 'homezero.verveen.me',
    testDomain: 'test.homezero.verveen.me',
    errorsDomain: 'fouten.homezero.verveen.me',
    acmeEmail: 'robert@homezero.nl',
    registry: 'ghcr.io/homezerotech',
    adminKeys: [sshPublicKey('robert')],
    deployKey: sshPublicKey('deploy'),
  };
  const text: string = renderCloudInit(base);
  const doc = parse(text);
  const files = new Map<string, { content: string; permissions: string; owner: string }>(
    doc.write_files.map((f: { path: string }) => [f.path, f]),
  );

  it('is een geldige cloud-config volgens het schema van cloud-init', () => {
    expect(text.startsWith('#cloud-config\n')).toBe(true);
    const ajv = new AjvDraft04({ strict: false, allErrors: true });
    const validate = ajv.compile(schema('cloud-config-v1.json'));
    expect(validate(doc), errorsOf(validate)).toBe(true);
  });

  it('SSH alleen met sleutel: geen wachtwoorden, geen root; CI-sleutel alleen voor hz-ssh-dispatch', () => {
    expect(doc.ssh_pwauth).toBe(false);
    expect(doc.disable_root).toBe(true);
    const sshd = files.get('/etc/ssh/sshd_config.d/10-hz.conf')!.content;
    for (const l of ['PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'PermitRootLogin no', 'PubkeyAuthentication yes'])
      expect(sshd).toContain(l);
    const [hz, deploy] = doc.users;
    expect(hz.lock_passwd).toBe(true);
    expect(hz.ssh_authorized_keys).toEqual(base.adminKeys);
    expect(deploy.ssh_authorized_keys).toEqual([`restrict,command="/opt/hz/bin/hz-ssh-dispatch" ${base.deployKey}`]);
    expect(deploy.groups).toEqual(['docker']);
  });

  it('firewall: standaard dicht, alleen 22, 80 en 443 open', () => {
    const ufw = doc.runcmd.filter((c: string[]) => c[0] === 'ufw').map((c: string[]) => c.slice(1).join(' '));
    expect(ufw).toEqual(['default deny incoming', 'default allow outgoing', 'allow 22/tcp', 'allow 80/tcp', 'allow 443/tcp', 'allow 443/udp', '--force enable']);
  });

  it('automatische beveiligingsupdates met herstart om 04:00; Docker uit de officiële repository', () => {
    expect(files.get('/etc/apt/apt.conf.d/20auto-upgrades')!.content).toContain('APT::Periodic::Unattended-Upgrade "1";');
    expect(files.get('/etc/apt/apt.conf.d/52unattended-upgrades-hz')!.content).toContain('Automatic-Reboot-Time "04:00"');
    expect(doc.packages).toEqual(expect.arrayContaining(['unattended-upgrades', 'docker-ce', 'docker-compose-plugin', 'age', 'ufw', 'fail2ban']));
    expect(doc.apt.sources.docker.keyid).toBe('9DC858229FC7DD38854AE2D88D81803C0EBFCD88');
  });

  it('vaste scripts zijn exact de bestanden uit de repo; timers voor back-up, hersteltest en hartslag staan aan', () => {
    expect(files.get('/opt/hz/bin/hz-ssh-dispatch')!.content).toBe(read('scripts/hz-ssh-dispatch.sh'));
    expect(files.get('/opt/hz/bin/hz-run')!.content).toBe(read('scripts/hz-run.sh'));
    expect(files.get('/opt/hz/bin/hz-server-check')!.content).toBe(read('scripts/server-check.sh'));
    expect(files.get('/opt/hz/bin/lib.sh')!.content).toBe(read('scripts/lib.sh'));
    expect(files.get('/opt/hz/bin/hz-ssh-dispatch')!.permissions).toBe('0755');
    expect(files.get('/etc/systemd/system/hz-backup.timer')!.content).toBe(read('systemd/hz-backup.timer'));
    const enable = doc.runcmd.find((c: string[]) => c.includes('hz-backup.timer'));
    expect(enable).toEqual(['systemctl', 'enable', '--now', 'hz-backup.timer', 'hz-heartbeat.timer', 'hz-hersteltest.timer']);
    expect(files.get('/etc/sudoers.d/hz-deploy')!.content).toBe('deploy ALL=(root) NOPASSWD: /opt/hz/bin/hz-server-check --markdown\n');
  });

  it('server maakt zijn eigen age-sleutel; alleen de publieke helft komt naar buiten', () => {
    const cmd = JSON.stringify(doc.runcmd);
    expect(cmd).toContain('age-keygen -o /etc/hz/age.key');
    expect(cmd).toContain('age-keygen -y /etc/hz/age.key > /etc/hz/age.pub');
    expect(cmd).not.toContain('cat /etc/hz/age.key');
  });

  it('ander domein of tweede server = alleen andere waarden (geen codewijziging)', () => {
    const other: string = renderCloudInit({ ...base, domain: 'workspace.homezero.nl', testDomain: 'test.workspace.homezero.nl', errorsDomain: 'fouten.workspace.homezero.nl' });
    const a = parse(text);
    const b = parse(other);
    const env = (d: typeof a) => d.write_files.find((f: { path: string }) => f.path === '/etc/hz/hz.env').content as string;
    expect(env(b)).toContain('HZ_DOMAIN=workspace.homezero.nl');
    a.write_files = a.write_files.filter((f: { path: string }) => f.path !== '/etc/hz/hz.env');
    b.write_files = b.write_files.filter((f: { path: string }) => f.path !== '/etc/hz/hz.env');
    expect(b).toEqual(a);
  });

  it('weigert ongeldige invoer', () => {
    expect(() => renderCloudInit({ ...base, domain: 'niet een domein' })).toThrow(/domein/);
    expect(() => renderCloudInit({ ...base, adminKeys: [] })).toThrow(/beheerder/);
    expect(() => renderCloudInit({ ...base, deployKey: 'ssh-rsa' })).toThrow(/SSH-sleutel/);
    expect(() => renderCloudInit({ ...base, registry: 'GHCR' })).toThrow(/registry/);
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
        for (const l of t.split('\n').filter((x) => x && !x.startsWith('#'))) expect(l, f).toMatch(/^\??[A-Z_][A-Z0-9_]* (gen:hex|gen:b64|mens:C\d+)$/);
      } else if (f === 'recipients.txt') {
        for (const l of t.split('\n').filter((x) => x && !x.startsWith('#'))) expect(l, f).toMatch(/^age1[0-9a-z]{58}$/);
      } else throw new Error(`onverwacht bestand in infra/secrets: ${f}`);
    }
  });

  it('.gitignore houdt .env-bestanden buiten Git', () => {
    const gi = readFileSync(join(APP, '.gitignore'), 'utf8').split('\n');
    expect(gi).toContain('.env');
    expect(gi).toContain('.env.*');
  });
});
