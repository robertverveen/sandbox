/** Start de worker: `pnpm --filter @hz/worker dev`. Vereist DATABASE_URL (standaard hz_fundament lokaal). */
import { createProviders } from '@hz/providers';
import { DEFAULT_DATABASE_URL, ensureDatabase, parseMasterKey } from '@hz/db';
import { startWorker } from './worker';

const url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
await ensureDatabase(url);
// Sync-motor alleen met een hoofdsleutel (tokens zijn versleuteld) en minstens één live bron.
const liveOn = Object.keys(process.env).some((k) => k.startsWith('HZ_LIVE_') && process.env[k] === '1');
const sync =
  process.env.HZ_TOKEN_KEY && liveOn
    ? { masterKey: parseMasterKey(process.env.HZ_TOKEN_KEY), env: process.env }
    : undefined;
const w = await startWorker({ connectionString: url, bundle: createProviders(process.env), sync });
await w.send({});
console.log('[worker] gestart; voorbeeldjob context.tel-acties verstuurd');
const stop = async () => {
  await w.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
