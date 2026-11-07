#!/usr/bin/env node
/**
 * Maakt de cloud-init (user-data) voor een nieuwe Hetzner Cloud-server (HZW-002, HZW-082).
 * Alles wat de server vóór de eerste uitrol nodig heeft staat hierin: gebruikers (hz voor beheerders, deploy voor
 * GitHub Actions), SSH alleen met sleutel, firewall 22/80/443, automatische beveiligingsupdates, Docker, de vaste
 * scripts (/opt/hz/bin) en de timers voor back-up, hersteltest en hartslag. De rest komt per uitrol uit de bundel.
 *
 *   node infra/cloud-init/render.mjs \
 *     --domain homezero.verveen.me --test-domain test.homezero.verveen.me \
 *     --acme-email robert@homezero.nl --registry ghcr.io/homezerotech \
 *     --admin-keys ~/.ssh/id_ed25519.pub --deploy-key deploy_ed25519.pub \
 *     --out user-data.yaml
 *
 * Een tweede server of een ander domein (verhuizen, HZW-082) is alleen andere waarden, geen codewijziging.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';

const infra = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(infra, p), 'utf8');

const DOMAIN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SSH_KEY = /^(ssh-ed25519|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ssh-rsa|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/=]+( [^\n]*)?$/;

/** Docker-repository (officieel), sleutel op vingerafdruk zodat apt hem zelf controleert. */
const DOCKER_KEY_FINGERPRINT = '9DC858229FC7DD38854AE2D88D81803C0EBFCD88';

export function renderCloudInit(o) {
  for (const [k, v] of Object.entries({ domain: o.domain, testDomain: o.testDomain, errorsDomain: o.errorsDomain }))
    if (!DOMAIN.test(v ?? '')) throw new Error(`ongeldig domein voor ${k}: ${v}`);
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(o.acmeEmail ?? '')) throw new Error('ongeldig e-mailadres voor ACME');
  if (!/^[a-z0-9.-]+(\/[a-z0-9._-]+)+$/.test(o.registry ?? '')) throw new Error('ongeldige registry (bv. ghcr.io/homezerotech)');
  const adminKeys = (o.adminKeys ?? []).map((k) => k.trim()).filter(Boolean);
  if (!adminKeys.length) throw new Error('minstens één SSH-sleutel van een beheerder nodig');
  for (const k of [...adminKeys, o.deployKey ?? '']) if (!SSH_KEY.test(k.trim())) throw new Error(`geen geldige publieke SSH-sleutel: ${k.slice(0, 30)}…`);

  const hzEnv = [
    '# Niet-geheime instellingen van deze server (cloud-init). Geheimen staan versleuteld in de repo (infra/secrets).',
    `HZ_DOMAIN=${o.domain}`,
    `HZ_TEST_DOMAIN=${o.testDomain}`,
    `HZ_ERRORS_DOMAIN=${o.errorsDomain}`,
    `HZ_ACME_EMAIL=${o.acmeEmail}`,
    `HZ_REGISTRY=${o.registry}`,
    'HZ_BACKUP_PREFIX=hz-prod',
    '# Back-up en herstel via de db-container (de database heeft geen open poort).',
    'HZ_PG_EXEC=docker exec -i hz-prod-db-1',
    'HZ_RESTORE_ADMIN_DSN=postgresql:///postgres?user=postgres',
    '',
  ].join('\n');

  const file = (path, content, permissions = '0644', owner = 'root:root', defer = false) => ({
    path,
    content,
    permissions,
    owner,
    ...(defer ? { defer: true } : {}),
  });
  const units = ['hz-backup', 'hz-heartbeat', 'hz-hersteltest'].flatMap((u) => [
    file(`/etc/systemd/system/${u}.service`, read(`systemd/${u}.service`)),
    file(`/etc/systemd/system/${u}.timer`, read(`systemd/${u}.timer`)),
  ]);

  const doc = {
    hostname: o.hostname ?? 'hz-workspace',
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
      'fail2ban',
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
    groups: ['docker'],
    users: [
      {
        name: 'hz',
        gecos: 'HomeZero beheer',
        groups: ['sudo', 'docker'],
        shell: '/bin/bash',
        sudo: 'ALL=(ALL) NOPASSWD:ALL',
        lock_passwd: true,
        ssh_authorized_keys: adminKeys,
      },
      {
        name: 'deploy',
        gecos: 'Uitrol vanuit GitHub Actions (alleen hz-ssh-dispatch)',
        groups: ['docker'],
        shell: '/bin/bash',
        lock_passwd: true,
        ssh_authorized_keys: [`restrict,command="/opt/hz/bin/hz-ssh-dispatch" ${o.deployKey.trim()}`],
      },
    ],
    write_files: [
      file(
        '/etc/ssh/sshd_config.d/10-hz.conf',
        [
          '# HZW-002: alleen sleutels, geen root, geen wachtwoorden.',
          'PasswordAuthentication no',
          'KbdInteractiveAuthentication no',
          'PermitRootLogin no',
          'PubkeyAuthentication yes',
          'PermitEmptyPasswords no',
          'MaxAuthTries 3',
          'X11Forwarding no',
          'AllowUsers hz deploy',
          '',
        ].join('\n'),
      ),
      file(
        '/etc/apt/apt.conf.d/20auto-upgrades',
        'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\nAPT::Periodic::AutocleanInterval "7";\n',
      ),
      file(
        '/etc/apt/apt.conf.d/52unattended-upgrades-hz',
        [
          '// HZW-002: beveiligingsupdates automatisch, ook voor Docker; herstart als het moet om 04:00.',
          'Unattended-Upgrade::Origins-Pattern { "origin=Docker,label=Docker CE"; };',
          'Unattended-Upgrade::Automatic-Reboot "true";',
          'Unattended-Upgrade::Automatic-Reboot-Time "04:00";',
          'Unattended-Upgrade::Remove-Unused-Dependencies "true";',
          '',
        ].join('\n'),
      ),
      file(
        '/etc/docker/daemon.json',
        JSON.stringify(
          { 'log-driver': 'local', 'log-opts': { 'max-size': '10m', 'max-file': '5' }, 'live-restore': true, 'no-new-privileges': true },
          null,
          2,
        ) + '\n',
      ),
      file('/etc/fail2ban/jail.d/sshd.local', '[sshd]\nenabled = true\nmaxretry = 5\nbantime = 1h\n'),
      file('/etc/tmpfiles.d/hz.conf', 'd /run/hz 0700 deploy deploy -\n'),
      file('/etc/hz/hz.env', hzEnv, '0640', 'root:deploy', true),
      file('/etc/sudoers.d/hz-deploy', 'deploy ALL=(root) NOPASSWD: /opt/hz/bin/hz-server-check --markdown\n', '0440'),
      file('/opt/hz/bin/lib.sh', read('scripts/lib.sh'), '0644'),
      file('/opt/hz/bin/hz-ssh-dispatch', read('scripts/hz-ssh-dispatch.sh'), '0755'),
      file('/opt/hz/bin/hz-run', read('scripts/hz-run.sh'), '0755'),
      file('/opt/hz/bin/hz-server-check', read('scripts/server-check.sh'), '0755'),
      ...units,
    ],
    runcmd: [
      ['systemctl', 'restart', 'ssh'],
      ['ufw', 'default', 'deny', 'incoming'],
      ['ufw', 'default', 'allow', 'outgoing'],
      ['ufw', 'allow', '22/tcp'],
      ['ufw', 'allow', '80/tcp'],
      ['ufw', 'allow', '443/tcp'],
      ['ufw', 'allow', '443/udp'],
      ['ufw', '--force', 'enable'],
      ['systemctl', 'enable', '--now', 'fail2ban', 'docker', 'unattended-upgrades'],
      [
        'sh',
        '-c',
        'mkdir -p /opt/hz/releases /opt/hz/env /opt/hz/edge /opt/hz/previews/allow /var/log/hz && chown -R deploy:deploy /opt/hz/releases /opt/hz/env /opt/hz/edge /opt/hz/previews /var/log/hz && systemd-tmpfiles --create /etc/tmpfiles.d/hz.conf',
      ],
      // Sleutel van de server voor de secrets (age): de geheime helft verlaat de server nooit.
      [
        'sh',
        '-c',
        'test -f /etc/hz/age.key || (umask 027 && age-keygen -o /etc/hz/age.key 2>/dev/null); chgrp deploy /etc/hz/age.key && chmod 0640 /etc/hz/age.key && age-keygen -y /etc/hz/age.key > /etc/hz/age.pub',
      ],
      // SSH-sleutel voor de Storage Box (back-ups).
      [
        'su',
        '-s',
        '/bin/sh',
        'deploy',
        '-c',
        'test -f ~/.ssh/hz_backup_ed25519 || ssh-keygen -q -t ed25519 -N "" -C hz-backup -f ~/.ssh/hz_backup_ed25519',
      ],
      ['sh', '-c', 'docker network inspect hz-edge >/dev/null 2>&1 || docker network create hz-edge'],
      ['systemctl', 'daemon-reload'],
      ['systemctl', 'enable', '--now', 'hz-backup.timer', 'hz-heartbeat.timer', 'hz-hersteltest.timer'],
      [
        'sh',
        '-c',
        '{ echo "age (secrets, zet in infra/secrets/recipients.txt):"; cat /etc/hz/age.pub; echo "Storage Box (back-ups):"; cat /home/deploy/.ssh/hz_backup_ed25519.pub; } | tee /var/log/hz/sleutels.txt',
      ],
    ],
    final_message: 'HomeZero Workspace-server klaar na $UPTIME s. Publieke sleutels: /var/log/hz/sleutels.txt',
  };

  return `#cloud-config\n# HomeZero Workspace (HZW-002). Gemaakt met infra/cloud-init/render.mjs; niet met de hand aanpassen.\n${stringify(doc, { lineWidth: 0 })}`;
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
      hostname: a.hostname,
    });
    if (a.out) writeFileSync(a.out, text);
    else process.stdout.write(text);
  } catch (e) {
    console.error(`cloud-init: ${e.message}`);
    process.exit(1);
  }
}
