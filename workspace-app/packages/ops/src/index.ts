/**
 * Beheer in de processen zelf (HZW-007): foutregistratie, gestructureerde logs zonder persoonsgegevens en een
 * hartslag. Eén aanroep bij het starten van api en worker: `installOps({ service: 'api' })`.
 *
 * Omgevingsvariabelen (allemaal optioneel; lokaal staat alles uit):
 * - HZ_ERROR_DSN      DSN van GlitchTip (zelf gehost) of Sentry; zonder: geen foutregistratie
 * - HZ_LOG_FORMAT     json (productie) | text (standaard)
 * - HZ_ENVIRONMENT    production | test | preview | development
 * - HZ_RELEASE        image-tag (bijv. sha-1a2b3c4), zet de uitrol
 */
import { createReporter, type Reporter } from './errors';
import { patchConsole, withAccessLog, type Write } from './log';

export { scrub, maskPath } from './scrub';
export { createReporter, parseDsn, toEvent, type ErrorEvent, type Reporter } from './errors';
export { formatLine, patchConsole, withAccessLog } from './log';
export { startHeartbeat, heartbeatFresh } from './heartbeat';

export interface Ops {
  reporter: Reporter;
  json: boolean;
  /** Fetch-handler met access-log (alleen bij json-logs; anders ongewijzigd). */
  wrapFetch<A extends unknown[]>(h: (req: Request, ...rest: A) => Response | Promise<Response>): typeof h;
  uninstall(): void;
}

export function installOps(o: {
  service: string;
  env?: Record<string, string | undefined>;
  write?: Write;
  fetch?: typeof fetch;
  /** Standaard true: bij een niet-afgevangen fout melden en het proces stoppen (Docker herstart het). */
  handleProcessErrors?: boolean;
}): Ops {
  const env = o.env ?? process.env;
  const write: Write = o.write ?? ((l) => process.stdout.write(l + '\n'));
  const reporter = createReporter({
    dsn: env.HZ_ERROR_DSN || undefined,
    service: o.service,
    environment: env.HZ_ENVIRONMENT ?? env.NODE_ENV,
    release: env.HZ_RELEASE,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  const json = env.HZ_LOG_FORMAT === 'json';
  const capture = (e: Error) => void reporter.capture(e);
  const unpatch = json ? patchConsole(o.service, write, capture) : () => {};
  // Ook zonder json-logs: fouten die via console.error gaan, naar de foutregistratie.
  let restoreError = () => {};
  if (!json && reporter.enabled) {
    const orig = console.error;
    console.error = (...args: unknown[]) => {
      orig(...args);
      for (const a of args) if (a instanceof Error) capture(a);
    };
    restoreError = () => (console.error = orig);
  }

  const onUncaught = async (err: unknown) => {
    console.error(err instanceof Error ? err : new Error(String(err)));
    await reporter.capture(err, 'fatal');
    await reporter.flush();
    process.exit(1);
  };
  const onRejection = (err: unknown) => void reporter.capture(err);
  if (o.handleProcessErrors !== false) {
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onRejection);
  }

  return {
    reporter,
    json,
    wrapFetch: (h) => (json ? withAccessLog(o.service, h, write) : h),
    uninstall() {
      unpatch();
      restoreError();
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onRejection);
    },
  };
}
