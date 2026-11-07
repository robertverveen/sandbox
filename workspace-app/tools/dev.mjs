#!/usr/bin/env node
/**
 * `pnpm dev`: API (tsx watch, poort HZ_API_PORT=8700) en web (Vite, HZ_WEB_PORT=5700) samen.
 * `pnpm dev -- --worker` start ook de worker (vereist Postgres; DATABASE_URL of hz_fundament lokaal).
 *
 * Eerst wordt gecontroleerd of de poorten vrij zijn: is er een bezet, dan start er niets en zie je welke
 * poort en hoe je verder kunt (in plaats van een API die stil crasht terwijl web gewoon start).
 * Stopt de API of de worker onverwacht, dan stopt alles. Ctrl+C stopt alles.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const withWorker = process.argv.includes('--worker');
const apiPort = Number(process.env.HZ_API_PORT ?? 8700);
const webPort = Number(process.env.HZ_WEB_PORT ?? 5700);

/** true als er al iets luistert op de poort (IPv4 of IPv6). */
export function portBusy(port, host) {
  return new Promise((ok) => {
    const s = createServer();
    s.once('error', (e) => ok(e.code === 'EADDRINUSE' || e.code === 'EACCES'));
    s.once('listening', () => s.close(() => ok(false)));
    s.listen({ port, host, exclusive: true });
  });
}

async function busy(port) {
  for (const host of ['127.0.0.1', '::']) {
    try {
      if (await portBusy(port, host)) return true;
    } catch {
      /* host niet beschikbaar (bv. geen IPv6): negeren */
    }
  }
  return false;
}

const taken = [];
for (const [name, port, env] of [
  ['api', apiPort, 'HZ_API_PORT'],
  ['web', webPort, 'HZ_WEB_PORT'],
]) {
  if (await busy(port)) taken.push({ name, port, env });
}
if (taken.length) {
  for (const t of taken)
    console.error(
      `[dev] poort ${t.port} (${t.name}) is al bezet. Stop het proces dat er draait ` +
        `(bv. \`lsof -i :${t.port}\` of \`fuser -k ${t.port}/tcp\`) of kies een andere: ${t.env}=<poort> pnpm dev`,
    );
  console.error('[dev] niets gestart.');
  process.exit(1);
}

let stopping = false;
const procs = [
  ['api', 'pnpm', ['--filter', '@hz/api', 'dev'], true],
  ['web', 'pnpm', ['--filter', '@hz/web', 'dev'], false],
  ...(withWorker ? [['worker', 'pnpm', ['--filter', '@hz/worker', 'dev'], true]] : []),
].map(([name, cmd, args, critical]) => {
  const p = spawn(cmd, args, {
    cwd: root,
    env: { ...process.env, HZ_API_PORT: String(apiPort), HZ_WEB_PORT: String(webPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = (d) =>
    String(d)
      .split('\n')
      .filter(Boolean)
      .forEach((l) => console.log(`[${name}] ${l}`));
  p.stdout.on('data', out);
  p.stderr.on('data', out);
  p.on('exit', (code) => {
    console.log(`[${name}] gestopt (${code})`);
    if (!stopping && (critical || code)) {
      console.error(`[dev] ${name} stopte onverwacht; alles wordt gestopt.`);
      stop(1);
    }
  });
  return p;
});
console.log(`web: http://127.0.0.1:${webPort}  ·  api: http://127.0.0.1:${apiPort}/api/health`);

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const p of procs) p.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
