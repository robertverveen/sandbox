/**
 * Hulpmiddelen voor de infra-tests: scripts echt draaien (bash) met tijdelijke mappen, nep-docker en lokale
 * HTTP-servers, en een superuser op de lokale Postgres voor de back-up- en verhuistests.
 * Er gaat niets naar buiten: geen echte registry, server, Storage Box of uptime-dienst.
 */
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { inject } from 'vitest';

export const INFRA = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const APP = resolve(INFRA, '..');
export const ROOT = resolve(APP, '..');
export const SCRIPTS = join(INFRA, 'scripts');

export function tmp(prefix = 'hz-e0-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export interface Run {
  code: number;
  out: string;
  err: string;
  all: string;
}

function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const base: Record<string, string> = {
    PATH: `${process.env.PATH ?? ''}:/root/go/bin`,
    HOME: process.env.HOME ?? '/root',
    LANG: 'C.UTF-8',
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
  };
  for (const [k, v] of Object.entries(env)) if (v !== undefined) base[k] = v;
  return base;
}

/**
 * Draai een script met een schone, voorspelbare omgeving (PATH en HOME blijven). Asynchroon: de nep-servers in dit
 * proces (health, uptime-dienst, TLS) moeten kunnen antwoorden terwijl het script loopt.
 */
export function run(
  cmd: string,
  args: string[],
  env: Record<string, string | undefined> = {},
  input?: string,
): Promise<Run> {
  return new Promise((resolveRun, reject) => {
    const p = spawn(cmd, args, { env: cleanEnv(env) });
    let out = '';
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), 170_000);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ code: code ?? -1, out, err, all: out + err });
    });
    // Een script dat stdin niet leest en snel stopt, geeft EPIPE: dat is geen fout.
    p.stdin.on('error', () => {});
    p.stdin.end(input ?? '');
  });
}

/** Synchrone variant voor scripts die niet met servers in dit proces praten. */
export function runSync(
  cmd: string,
  args: string[],
  env: Record<string, string | undefined> = {},
  input?: string,
): Run {
  const r: SpawnSyncReturns<string> = spawnSync(cmd, args, {
    env: cleanEnv(env),
    encoding: 'utf8',
    input: input ?? '',
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
}

export const script = (name: string) => join(SCRIPTS, name);

export function has(bin: string): boolean {
  return (
    spawnSync('sh', ['-c', `command -v ${bin}`], { env: { PATH: `${process.env.PATH}:/root/go/bin` } }).status === 0
  );
}

/** age-sleutelpaar in een map: { key, pub, recipients } */
export function ageKeys(dir: string) {
  mkdirSync(dir, { recursive: true });
  const key = join(dir, 'age.key');
  const r = spawnSync('age-keygen', ['-o', key], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`age-keygen faalt: ${r.stderr}`);
  const pub = spawnSync('age-keygen', ['-y', key], { encoding: 'utf8' }).stdout.trim();
  const recipients = join(dir, 'recipients.txt');
  writeFileSync(recipients, `# test\n${pub}\n`);
  return { key, pub, recipients };
}

/** Publieke OpenSSH-sleutel (ed25519) zonder ssh-keygen. */
export function sshPublicKey(comment = 'test@hz'): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const s = (b: Buffer) => {
    const l = Buffer.alloc(4);
    l.writeUInt32BE(b.length);
    return Buffer.concat([l, b]);
  };
  return `ssh-ed25519 ${Buffer.concat([s(Buffer.from('ssh-ed25519')), s(raw)]).toString('base64')} ${comment}`;
}

/**
 * Nep-docker: logt elke aanroep (argumenten en de belangrijkste omgevingsvariabelen) in $FAKE_DOCKER_LOG en doet
 * alsof alles lukt. Gedrag is te sturen met omgevingsvariabelen:
 *   FAKE_DOCKER_FAIL_UP_TAG   'compose up' van een instantie (niet router of edge) faalt als HZ_TAG gelijk is
 *   FAKE_DOCKER_HEALTH        uitvoer van 'compose exec web wget ... /api/health'
 *   FAKE_DOCKER_UNHEALTHY     uitvoer van 'ps --filter health=unhealthy'
 *   FAKE_DOCKER_BUNDLE        map die 'docker cp <cid>:/app/bundle/.' kopieert
 *   FAKE_DOCKER_PS, FAKE_DOCKER_NETWORKS, FAKE_DOCKER_VOLUMES   bestanden met de uitvoer van 'ps -a', 'network ls',
 *                             'volume ls' (tab-gescheiden, zoals server-check.sh ze opvraagt)
 */
export function fakeDocker(dir: string): { bin: string; log: string; calls(): string[] } {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'docker');
  const log = join(dir, 'docker.log');
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
set -u
printf '%s | tag=%s instance=%s env=%s url=%s node_env=%s devlogin=%s appenv=%s edge=%s cfg=%s\\n' "$*" "\${HZ_TAG:-}" "\${HZ_INSTANCE:-}" "\${HZ_ENVIRONMENT:-}" "\${HZ_PUBLIC_URL:-}" "\${HZ_NODE_ENV:-}" "\${HZ_DEV_LOGIN:-}" "\${HZ_APP_ENV_FILE:-}" "\${HZ_EDGE_DIR:-}" "\${DOCKER_CONFIG:-}" >> "${log}"
args=" $* "
case "$args" in
  *" network inspect "*) [[ -f "${dir}/net" ]] || exit 1; exit 0 ;;
  *" network create "*) touch "${dir}/net"; exit 0 ;;
  *" login "*) cat > "\${DOCKER_CONFIG:-/dev/null}/token-seen" 2>/dev/null || cat >/dev/null; exit 0 ;;
  *" create "*) echo cid123; exit 0 ;;
  *" cp cid123:/app/bundle/. "*) dest="\${@: -1}"; cp -R "\${FAKE_DOCKER_BUNDLE:?}/." "$dest"; exit 0 ;;
  *" ps --filter health=unhealthy "*) printf '%s' "\${FAKE_DOCKER_UNHEALTHY:-}"; exit 0 ;;
  *" image ls "*) printf '%s\n' \${FAKE_DOCKER_IMAGE_TAGS:-}; exit 0 ;;
  *" ps -a --format "*) [[ -n "\${FAKE_DOCKER_PS:-}" ]] && cat "$FAKE_DOCKER_PS"; exit 0 ;;
  *" network ls --format "*) [[ -n "\${FAKE_DOCKER_NETWORKS:-}" ]] && cat "$FAKE_DOCKER_NETWORKS"; exit 0 ;;
  *" volume ls --format "*) [[ -n "\${FAKE_DOCKER_VOLUMES:-}" ]] && cat "$FAKE_DOCKER_VOLUMES"; exit 0 ;;
  *" compose "*" up "*) [[ "$args" != *" -p hz-workspace-router "* && "$args" != *" -p hz-workspace-edge "* && -n "\${FAKE_DOCKER_FAIL_UP_TAG:-}" && "\${HZ_TAG:-}" == "\${FAKE_DOCKER_FAIL_UP_TAG}" ]] && { echo "container unhealthy" >&2; exit 1; }; exit 0 ;;
  *" compose "*" exec "*"wget"*) printf '%s' "\${FAKE_DOCKER_HEALTH:-{\\"ok\\":true,\\"db\\":\\"ok\\"}}"; exit 0 ;;
  *) exit 0 ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    log,
    calls: () => {
      try {
        return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}

export interface Hit {
  method: string;
  url: string;
  body: string;
}

/** Kleine HTTP-server op 127.0.0.1 met een eigen handler; houdt alle verzoeken bij. */
export async function httpServer(
  handler: (req: IncomingMessage, body: string) => { status: number; body?: string; headers?: Record<string, string> },
) {
  const hits: Hit[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ method: req.method ?? '', url: req.url ?? '', body });
      const r = handler(req, body);
      res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) }).end(r.body ?? '');
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const a = server.address();
  const port = typeof a === 'object' && a ? a.port : 0;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

/* ------------------------------------------------------------------ Postgres ------------------------------------- */

export const DEV_URL = 'postgres://hz_dev:hz_dev@localhost:5432/postgres';

/**
 * Een superuser-verbinding (database 'postgres') voor wat alleen een beheerder mag: BYPASSRLS-rollen maken en als
 * rol herstellen. Komt uit test/global-setup.ts (HZ_PG_ADMIN_URL, in CI postgres met PGPASSWORD, of lokaal als root
 * een tijdelijke hz_e0_admin met een willekeurig wachtwoord, die na de run weer weg is, net als alle andere
 * hz_e0_*-rollen). Lukt het niet, dan faalt de test met uitleg (geen stille skip).
 */
export async function adminUrl(): Promise<string> {
  const url = inject('hzAdminUrl');
  if (url) return url;
  throw new Error(
    'Geen Postgres-superuser voor de infra-tests: zet HZ_PG_ADMIN_URL=postgres://<superuser>:...@localhost:5432/postgres',
  );
}

export function dbUrl(base: string, db: string, user?: string, password?: string): string {
  const u = new URL(base);
  u.pathname = `/${db}`;
  if (user) u.username = user;
  if (password !== undefined) u.password = password;
  return u.toString();
}

export async function sql<T extends pg.QueryResultRow = pg.QueryResultRow>(
  url: string,
  text: string,
  params: unknown[] = [],
) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<T>(text, params)).rows;
  } finally {
    await c.end();
  }
}

export async function recreateDb(admin: string, name: string) {
  if (!/^hz_e0_[a-z0-9_]+$/.test(name)) throw new Error(`testdatabases beginnen met hz_e0_: ${name}`);
  await sql(admin, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await sql(admin, `CREATE DATABASE ${name}`);
}

export async function dropDb(admin: string, name: string) {
  await sql(admin, `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
}

/** Wacht tot een proces een regel print die matcht, of faalt na timeout. */
export function startProcess(cmd: string, args: string[], env: Record<string, string>, cwd?: string) {
  const p = spawn(cmd, args, { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/root', ...env }, cwd });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  const exited = new Promise<number>((ok) => p.on('exit', (c) => ok(c ?? -1)));
  return { p, output: () => out, exited, stop: () => (p.kill('SIGTERM'), exited) };
}

/** Een vrije poort van het besturingssysteem (botst niet met de vaste poorten van de stukken). */
export function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createNetServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => ok(port));
    });
  });
}
