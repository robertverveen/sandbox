/** Start de worker: `pnpm --filter @hz/worker dev`. Vereist DATABASE_URL (standaard hz_fundament lokaal). */
import { createProviders } from '@hz/providers';
import { DEFAULT_DATABASE_URL, ensureDatabase } from '@hz/db';
import { startWorker } from './worker';

const url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
await ensureDatabase(url);
const w = await startWorker({ connectionString: url, bundle: createProviders(process.env) });
await w.send({});
console.log('[worker] gestart; voorbeeldjob context.tel-acties verstuurd');
const stop = async () => {
  await w.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
