/**
 * Beheeropdrachten in de api-container (HZW-007):
 *   node dist/ops-cli.js test-error     stuurt een kunstmatige fout naar HZ_ERROR_DSN (exit 0 = aangekomen)
 *   node dist/ops-cli.js heartbeat-ok   exit 0 als HZ_WORKER_HEARTBEAT recent is (healthcheck van de worker)
 */
import { createReporter } from './errors';
import { heartbeatFresh } from './heartbeat';

const cmd = process.argv[2];

if (cmd === 'test-error') {
  const env = process.env;
  if (!env.HZ_ERROR_DSN) {
    console.error('HZ_ERROR_DSN ontbreekt');
    process.exit(2);
  }
  const r = createReporter({
    dsn: env.HZ_ERROR_DSN,
    service: env.HZ_SERVICE ?? 'api',
    environment: env.HZ_ENVIRONMENT,
    release: env.HZ_RELEASE,
  });
  const ok = await r.capture(new Error('HZ testfout (kunstmatig, HZW-007): foutregistratie werkt'));
  console.log(ok ? 'testfout aangekomen in de foutregistratie' : 'testfout NIET aangekomen');
  process.exit(ok ? 0 : 1);
} else if (cmd === 'heartbeat-ok') {
  const f = process.env.HZ_WORKER_HEARTBEAT;
  process.exit(f && heartbeatFresh(f, Number(process.env.HZ_HEARTBEAT_MAX_MS ?? 90_000)) ? 0 : 1);
} else {
  console.error('gebruik: ops-cli test-error | heartbeat-ok');
  process.exit(2);
}
