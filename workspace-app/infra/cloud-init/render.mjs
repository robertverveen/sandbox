#!/usr/bin/env node
/**
 * OPTIONEEL, alleen voor HZW-082 (verhuizen naar een eigen server). NIET de hoofdroute: de workspace draait op de
 * bestaande server van Robert (in zijn tailnet, naast andere projecten), en die wordt klaargezet met
 * infra/scripts/server-setup.sh na de voorcheck (RUNBOOK.md §2). Dit script maakt de cloud-init (user-data) voor
 * een nieuwe, lege Hetzner Cloud-server die zich daarna precies zo gedraagt als de bestaande:
 *
 *   - Tailscale geïnstalleerd en aangemeld (eenmalige, getagde auth-key uit een bestand; niet in Git);
 *   - ufw: standaard dicht, publiek alleen 443 (tcp en udp), SSH (22) alleen op tailscale0;
 *   - SSH alleen met sleutel, geen root, geen wachtwoorden; automatische beveiligingsupdates; Docker;
 *   - dan server-setup.sh --proxy eigen (eigen edge op 443, want er draait nog geen proxy): gebruiker hz-workspace,
 *     /srv/hz-workspace, vaste scripts, timers, sleutels. Zelfde script als op de bestaande server.
 *
 *   node infra/cloud-init/render.mjs \
 *     --domain proef.homezero.nl --acme-email robert@homezero.nl --registry ghcr.io/homezerotech \
 *     --admin-keys ~/.ssh/id_ed25519.pub --deploy-key hz_deploy.pub --tailscale-authkey-file ts.key \
 *     --out user-data.yaml
 *
 * Een tweede server of een ander domein is alleen andere waarden, geen codewijziging.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { stringify } from 'yaml';

const infra = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(infra, p), 'utf8');

const DOMAIN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SSH_KEY =
  /^(ssh-ed25519|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ssh-rsa|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/=]+( [^\n]*)?$/;
const TS_KEY = /^tskey-auth-[A-Za-z0-9_-]{8,}$/;

/** Docker-repository (officieel), sleutel op vingerafdruk zodat apt hem zelf controleert. */
const DOCKER_KEY_FINGERPRINT = '9DC858229FC7DD38854AE2D88D81803C0EBFCD88';

/** Map waarin cloud-init de installatiebestanden uitpakt; server-setup.sh installeert ze daarvandaan. */
export const SETUP_DIR = '/root/hz-workspace-setup/infra';
/** Wat server-setup.sh nodig heeft (scripts die het installeert of aanroept, en de systemd-units). */
export const SETUP_FILES = [
  'scripts/server-setup.sh',
  'scripts/server-check.sh',
  'scripts/lib.sh',
  'scripts/hz-ssh-dispatch.sh',
  'scripts/hz-run.sh',
  ...['backup', 'heartbeat', 'hersteltest'].flatMap((u) => [
    `systemd/hz-workspace-${u}.service`,
    `systemd/hz-workspace-${u}.timer`,
  ]),
];

/** Minimale ustar-tarball (vaste tijd en eigenaar, dus elke keer dezelfde bytes), gzip erover. */
export function setupTarball() {
  const blocks = [];
  const field = (buf, off, len, str) => buf.write(str, off, len, 'ascii');
  const octal = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  for (const f of SETUP_FILES) {
    const body = Buffer.from(read(f));
    const h = Buffer.alloc(512);
    field(h, 0, 100, f);
    field(h, 100, 8, octal(f.startsWith('scripts/') ? 0o755 : 0o644, 8));
    field(h, 108, 8, octal(0, 8));
    field(h, 116, 8, octal(0, 8));
    field(h, 124, 12, octal(body.length, 12));
    field(h, 136, 12, octal(0, 12));
    field(h, 148, 8, '        ');
    field(h, 156, 1, '0');
    field(h, 257, 6, 'ustar\0');
    field(h, 263, 2, '00');
    let sum = 0;
    for (const b of h) sum += b;
    field(h, 148, 8, octal(sum, 7) + ' ');
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

export function renderCloudInit(o) {
  for (const [k, v] of Object.entries({ domain: o.domain, testDomain: o.testDomain, errorsDomain: o.errorsDomain }))
    if (!DOMAIN.test(v ?? '')) throw new Error(`ongeldig domein voor ${k}: ${v}`);
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(o.acmeEmail ?? '')) throw new Error('ongeldig e-mailadres voor ACME');
  if (!/^[a-z0-9.-]+(\/[a-z0-9._-]+)+$/.test(o.registry ?? ''))
    throw new Error('ongeldige registry (bv. ghcr.io/homezerotech)');
  const adminKeys = (o.adminKeys ?? []).map((k) => k.trim()).filter(Boolean);
  if (!adminKeys.length) throw new Error('minstens één SSH-sleutel van een beheerder nodig');
  for (const k of [...adminKeys, o.deployKey ?? ''])
    if (!SSH_KEY.test(k.trim())) throw new Error(`geen geldige publieke SSH-sleutel: ${k.slice(0, 30)}…`);
  if (!TS_KEY.test((o.tailscaleAuthKey ?? '').trim()))
    throw new Error('Tailscale-auth-key ontbreekt of is ongeldig (tskey-auth-…, eenmalig, getagd, uit een bestand)');
  const hostname = o.hostname ?? 'hz-workspace';
  if (!/^[a-z0-9-]{3,40}$/.test(hostname)) throw new Error('ongeldige hostnaam');

  const file = (path, content, permissions = '0644', owner = 'root:root') => ({ path, content, permissions, owner });
  // De installatiebestanden als één tar.gz (base64): Hetzner neemt user-data tot 32 KiB.
  const bundle = {
    path: '/root/hz-workspace-setup/infra.tar.gz',
    encoding: 'b64',
    content: setupTarball().toString('base64'),
    permissions: '0600',
    owner: 'root:root',
  };
  const setup = [
    `${SETUP_DIR}/scripts/server-setup.sh`,
    '--proxy',
    'eigen',
    '--domain',
    o.domain,
    '--test-domain',
    o.testDomain,
    '--errors-domain',
    o.errorsDomain,
    '--acme-email',
    o.acmeEmail,
    '--registry',
    o.registry,
    '--deploy-key',
    '/root/hz-workspace-setup/deploy.pub',
  ];

  const doc = {
    hostname,
    timezone: 'Europe/Amsterdam',
    package_update: true,
    package_upgrade: true,
    package_reboot_if_required: true,
    apt: {
      sources: {
        docker: {
          source: 'deb [arch=amd64 signed-by=$KEY_FILE] https://download.docker.com/linux/ubuntu $RELEASE stable',
          keyid: DOCKER_KEY_FINGERPRINT,
          keyserver: 'keyserver.ubuntu.com',
        },
      },
    },
    packages: [
      'ca-certificates',
      'curl',
      'ufw',
      'unattended-upgrades',
      'apt-listchanges',
      'age',
      'jq',
      'openssh-client',
      'docker-ce',
      'docker-ce-cli',
      'containerd.io',
      'docker-buildx-plugin',
      'docker-compose-plugin',
    ],
    swap: { filename: '/swapfile', size: '2G', maxsize: '2G' },
    ssh_pwauth: false,
    disable_root: true,
    users: [
      {
        name: 'hz',
        gecos: 'HomeZero beheer (alleen via het tailnet)',
        groups: ['sudo', 'docker'],
        shell: '/bin/bash',
        sudo: 'ALL=(ALL) NOPASSWD:ALL',
        lock_passwd: true,
        ssh_authorized_keys: adminKeys,
      },
    ],
    write_files: [
      file(
        '/etc/ssh/sshd_config.d/10-hz-workspace.conf',
        [
          '# hz-workspace (HZW-002): alleen sleutels, geen root, geen wachtwoorden. ufw laat 22 alleen toe op tailscale0.',
          'PasswordAuthentication no',
          'KbdInteractiveAuthentication no',
          'PermitRootLogin no',
          'PubkeyAuthentication yes',
          'PermitEmptyPasswords no',
          'MaxAuthTries 3',
          'X11Forwarding no',
          'AllowUsers hz hz-workspace',
          '',
        ].join('\n'),
      ),
      file(
        '/etc/apt/apt.conf.d/20auto-upgrades',
        'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\nAPT::Periodic::AutocleanInterval "7";\n',
      ),
      file(
        '/etc/apt/apt.conf.d/52unattended-upgrades-hz-workspace',
        [
          '// hz-workspace (HZW-002): beveiligingsupdates automatisch, ook Docker en Tailscale; herstart om 04:00 als het moet.',
          'Unattended-Upgrade::Origins-Pattern { "origin=Docker,label=Docker CE"; "origin=Tailscale"; };',
          'Unattended-Upgrade::Automatic-Reboot "true";',
          'Unattended-Upgrade::Automatic-Reboot-Time "04:00";',
          'Unattended-Upgrade::Remove-Unused-Dependencies "true";',
          '',
        ].join('\n'),
      ),
      file(
        '/etc/docker/daemon.json',
        JSON.stringify(
          {
            'log-driver': 'local',
            'log-opts': { 'max-size': '10m', 'max-file': '5' },
            'live-restore': true,
            'no-new-privileges': true,
          },
          null,
          2,
        ) + '\n',
      ),
      // Eenmalige auth-key: na 'tailscale up' meteen weg (runcmd).
      file('/root/hz-workspace-setup/tailscale.key', `${o.tailscaleAuthKey.trim()}\n`, '0600'),
      file('/root/hz-workspace-setup/deploy.pub', `${o.deployKey.trim()}\n`),
      bundle,
    ],
    runcmd: [
      ['systemctl', 'restart', 'ssh'],
      // Tailscale volgens de installatie-instructies voor Ubuntu 24.04 (pakketbron van Tailscale, ondertekend).
      [
        'sh',
        '-c',
        'curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.noarmor.gpg -o /usr/share/keyrings/tailscale-archive-keyring.gpg && curl -fsSL https://pkgs.tailscale.com/stable/ubuntu/noble.tailscale-keyring.list -o /etc/apt/sources.list.d/tailscale.list && apt-get update -q && apt-get install -y -q tailscale',
      ],
      ['systemctl', 'enable', '--now', 'tailscaled'],
      [
        'sh',
        '-c',
        `tailscale up --auth-key=file:/root/hz-workspace-setup/tailscale.key --hostname=${hostname} && shred -u /root/hz-workspace-setup/tailscale.key`,
      ],
      // Firewall: publiek alleen 443; SSH alleen over het tailnet.
      ['ufw', 'default', 'deny', 'incoming'],
      ['ufw', 'default', 'allow', 'outgoing'],
      ['ufw', 'allow', 'in', 'on', 'tailscale0', 'to', 'any', 'port', '22', 'proto', 'tcp'],
      ['ufw', 'allow', '443/tcp'],
      ['ufw', 'allow', '443/udp'],
      ['ufw', '--force', 'enable'],
      ['systemctl', 'enable', '--now', 'docker', 'unattended-upgrades'],
      ['sh', '-c', `mkdir -p ${SETUP_DIR} && tar -xzf /root/hz-workspace-setup/infra.tar.gz -C ${SETUP_DIR}`],
      // Zelfde stap als op de bestaande server: voorcheck, gebruiker, map, scripts, timers, sleutels, netwerk.
      setup,
    ],
    final_message:
      'HomeZero Workspace-server klaar na $UPTIME s. Publieke sleutels: /srv/hz-workspace/log/sleutels.txt (via het tailnet)',
  };

  return `#cloud-config\n# HomeZero Workspace, eigen server (optie voor HZW-082). Gemaakt met infra/cloud-init/render.mjs; niet met de hand aanpassen.\n${stringify(doc, { lineWidth: 0 })}`;
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`onverwacht argument: ${a}`);
    out[a.slice(2)] = argv[++i];
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const a = args(process.argv.slice(2));
    const domain = a.domain ?? process.env.HZ_DOMAIN;
    const keysFile = a['admin-keys'];
    const text = renderCloudInit({
      domain,
      testDomain: a['test-domain'] ?? process.env.HZ_TEST_DOMAIN ?? `test.${domain}`,
      errorsDomain: a['errors-domain'] ?? process.env.HZ_ERRORS_DOMAIN ?? `fouten.${domain}`,
      acmeEmail: a['acme-email'] ?? process.env.HZ_ACME_EMAIL,
      registry: a.registry ?? process.env.HZ_REGISTRY,
      adminKeys: keysFile ? readFileSync(keysFile, 'utf8').split('\n') : [],
      deployKey: a['deploy-key'] ? readFileSync(a['deploy-key'], 'utf8') : '',
      tailscaleAuthKey: a['tailscale-authkey-file'] ? readFileSync(a['tailscale-authkey-file'], 'utf8') : '',
      hostname: a.hostname,
    });
    if (a.out) writeFileSync(a.out, text);
    else process.stdout.write(text);
  } catch (e) {
    console.error(`cloud-init: ${e.message}`);
    process.exit(1);
  }
}
