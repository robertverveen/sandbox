/**
 * Nep-server met andere projecten erop (HZW-002): zoals de bestaande Hetzner-server van Robert, in zijn tailnet,
 * met een Caddy op 80/443 voor een blog en een statuspagina, een monitor op 127.0.0.1:3001 en Home Assistant.
 * Alles is synthetisch. Server-check.sh, deploy.sh en server-setup.sh lezen deze map (HZ_CHECK_ROOT) en nep-docker
 * (FAKE_DOCKER_PS/NETWORKS/VOLUMES) in plaats van de echte server.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmp } from './helpers';

export interface Container {
  name: string;
  project?: string;
  ours?: boolean;
  image: string;
  ports?: string;
  networks?: string;
  labels?: string;
}

export interface ServerOpts {
  containers?: Container[];
  networks?: [string, boolean?][];
  volumes?: [string, boolean?][];
  ss?: string[];
  sshd?: string;
  ufw?: string;
  tailscaleIp?: string;
  caddyfile?: string;
  files?: Record<string, string>;
  dirs?: string[];
  autoUpgrades?: boolean;
  memAvailableKb?: number;
}

export const SSHD_GOOD = [
  'port 22',
  'listenaddress 100.101.102.103:22',
  'passwordauthentication no',
  'kbdinteractiveauthentication no',
  'permitrootlogin no',
  'pubkeyauthentication yes',
  'permitemptypasswords no',
  '',
].join('\n');

export const SS_GOOD = [
  'tcp   LISTEN 0 4096 100.101.102.103:22 0.0.0.0:*',
  'tcp   LISTEN 0 4096 0.0.0.0:80 0.0.0.0:*',
  'tcp   LISTEN 0 4096 [::]:80 [::]:*',
  'tcp   LISTEN 0 4096 0.0.0.0:443 0.0.0.0:*',
  'tcp   LISTEN 0 4096 [::]:443 [::]:*',
  'udp   UNCONN 0 0 0.0.0.0:443 0.0.0.0:*',
  'tcp   LISTEN 0 4096 127.0.0.1:3001 0.0.0.0:*',
  'tcp   LISTEN 0 4096 100.101.102.103:41112 0.0.0.0:*',
  'udp   UNCONN 0 0 0.0.0.0:41641 0.0.0.0:*',
  'udp   UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:*',
];

export const OTHER_CONTAINERS: Container[] = [
  {
    name: 'caddy-caddy-1',
    project: 'caddy',
    image: 'caddy:2.8.4-alpine',
    ports: '0.0.0.0:80->80/tcp, [::]:80->80/tcp, 0.0.0.0:443->443/tcp, [::]:443->443/tcp, 0.0.0.0:443->443/udp',
    networks: 'caddy',
    labels: 'com.docker.compose.project=caddy,com.docker.compose.service=caddy',
  },
  {
    name: 'blog-ghost-1',
    project: 'blog',
    image: 'ghost:5.96.0-alpine',
    ports: '2368/tcp',
    networks: 'blog_default,caddy',
    labels: 'com.docker.compose.project=blog',
  },
  {
    name: 'blog-db-1',
    project: 'blog',
    image: 'mysql:8.4',
    ports: '3306/tcp',
    networks: 'blog_default',
    labels: 'com.docker.compose.project=blog',
  },
  {
    name: 'monitor-kuma-1',
    project: 'monitor',
    image: 'louislam/uptime-kuma:1.23.15',
    ports: '127.0.0.1:3001->3001/tcp',
    networks: 'monitor_default',
    labels: 'com.docker.compose.project=monitor',
  },
  { name: 'homeassistant', image: 'ghcr.io/home-assistant/home-assistant:2024.10', networks: 'host' },
];

export const OTHER_NETWORKS: [string, boolean?][] = [
  ['bridge'],
  ['host'],
  ['none'],
  ['caddy'],
  ['blog_default'],
  ['monitor_default'],
];
export const OTHER_VOLUMES: [string, boolean?][] = [['blog_content'], ['blog_db'], ['monitor_data']];

export const CADDYFILE_OTHERS = `{
	email robert@example.nl
}

blog.verveen.me {
	reverse_proxy blog-ghost-1:2368
}

status.verveen.me {
	reverse_proxy 172.17.0.1:3001
}
`;

/** De instellingen van de workspace zoals in hz.env op deze server. */
export const WS_ENV = {
  HZ_DOMAIN: 'homezero.verveen.me',
  HZ_TEST_DOMAIN: 'test.homezero.verveen.me',
  HZ_ERRORS_DOMAIN: 'fouten.homezero.verveen.me',
  HZ_PROXY_KIND: 'caddy',
  HZ_PROXY_NETWORK: 'caddy',
  HZ_PROXY_CONFIG: '/etc/caddy',
};

const row = (c: Container) =>
  [c.name, c.project ?? '', c.ours ? '1' : '', c.image, c.ports ?? '', c.networks ?? '', c.labels ?? ''].join('\t');

/** Bouw de nep-server; geeft de omgeving voor server-check.sh (zonder HZ_DOCKER: die zet de test). */
export function otherProjectsServer(o: ServerOpts = {}) {
  const root = tmp('hz-e0-bestaand-');
  const w = (rel: string, text: string) => {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
    return p;
  };
  w('etc/passwd', 'root:x:0:0:root:/root:/bin/bash\nrobert:x:1000:1000::/home/robert:/bin/bash\n');
  if (o.autoUpgrades !== false)
    w(
      'etc/apt/apt.conf.d/20auto-upgrades',
      'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n',
    );
  w('etc/caddy/Caddyfile', o.caddyfile ?? CADDYFILE_OTHERS);
  w('proc/meminfo', `MemTotal: 16000000 kB\nMemAvailable: ${o.memAvailableKb ?? 9000000} kB\n`);
  for (const d of ['srv/blog', 'srv/caddy', 'opt/monitor', ...(o.dirs ?? [])])
    mkdirSync(join(root, d), { recursive: true });
  for (const [rel, text] of Object.entries(o.files ?? {})) w(rel, text);
  const data = join(root, '..', `${root.split('/').pop()}-data`);
  mkdirSync(data, { recursive: true });
  const d = (f: string, text: string) => (writeFileSync(join(data, f), text), join(data, f));
  const env = {
    HZ_CHECK_ROOT: root,
    HZ_ETC: join(root, 'srv/hz-workspace/etc'),
    HZ_SSHD_T: `cat ${d('sshd', o.sshd ?? SSHD_GOOD)}`,
    HZ_SS: `cat ${d('ss', (o.ss ?? SS_GOOD).join('\n') + '\n')}`,
    HZ_UFW: `cat ${d('ufw', o.ufw ?? 'Status: inactive\n')}`,
    HZ_TAILSCALE_IP: `echo ${o.tailscaleIp ?? '100.101.102.103'}`,
    FAKE_DOCKER_PS: d('ps', (o.containers ?? OTHER_CONTAINERS).map(row).join('\n') + '\n'),
    FAKE_DOCKER_NETWORKS: d(
      'networks',
      (o.networks ?? OTHER_NETWORKS).map(([n, ours]) => `${n}\t${ours ? '1' : ''}`).join('\n') + '\n',
    ),
    FAKE_DOCKER_VOLUMES: d(
      'volumes',
      (o.volumes ?? OTHER_VOLUMES).map(([n, ours]) => `${n}\t${ours ? '1' : ''}`).join('\n') + '\n',
    ),
  };
  return { root, data, env };
}

/** Inhoud, rechten en namen van alles onder een map: verandert er iets, dan verandert de hash. */
export function treeHash(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      h.update(`${p.slice(dir.length)} ${st.mode} ${st.size}\n`);
      if (st.isDirectory()) walk(p);
      else h.update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}
