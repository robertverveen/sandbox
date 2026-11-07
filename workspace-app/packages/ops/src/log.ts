/**
 * Gestructureerde logs zonder persoonsgegevens (HZW-007). In productie (HZ_LOG_FORMAT=json) wordt elke
 * console-regel één JSON-regel met tijd, niveau, dienst en een geschoonde boodschap. Geen IP, geen user-agent,
 * geen querystring, geen e-mailadres. Docker bewaart de regels (log-driver local, met rotatie).
 */
import { maskPath, scrub } from './scrub';

export type Level = 'debug' | 'info' | 'warn' | 'error';

export interface LogLine {
  ts: string;
  level: Level;
  svc: string;
  msg: string;
  [k: string]: unknown;
}

function fmtArg(a: unknown): string {
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

/** Eén logregel als JSON, geschoond. */
export function formatLine(svc: string, level: Level, args: unknown[], extra: Record<string, unknown> = {}): string {
  const line: LogLine = {
    ts: new Date().toISOString(),
    level,
    svc,
    msg: scrub(args.map(fmtArg).join(' ')),
  };
  for (const [k, v] of Object.entries(extra)) line[k] = typeof v === 'string' ? scrub(v) : v;
  return JSON.stringify(line);
}

export type Write = (line: string) => void;

/**
 * Vervang console.log/info/warn/error door JSON-regels. onError krijgt elke Error die via console.error
 * gelogd wordt (de API logt onverwachte fouten zo), zodat hij ook in de foutregistratie komt.
 */
export function patchConsole(svc: string, write: Write, onError?: (err: Error) => void): () => void {
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  const mk =
    (level: Level) =>
    (...args: unknown[]) => {
      write(formatLine(svc, level, args));
      if (level === 'error' && onError) for (const a of args) if (a instanceof Error) onError(a);
    };
  console.log = mk('info');
  console.info = mk('info');
  console.debug = mk('debug');
  console.warn = mk('warn');
  console.error = mk('error');
  return () => Object.assign(console, orig);
}

type FetchHandler<A extends unknown[]> = (req: Request, ...rest: A) => Response | Promise<Response>;

/** Access-log rond een fetch-handler (Hono): methode, gemaskeerd pad, status en duur. Geen IP of user-agent. */
export function withAccessLog<A extends unknown[]>(svc: string, handler: FetchHandler<A>, write: Write): FetchHandler<A> {
  return async (req, ...rest) => {
    const t0 = performance.now();
    const path = maskPath(new URL(req.url).pathname);
    try {
      const res = await handler(req, ...rest);
      write(
        formatLine(svc, res.status >= 500 ? 'error' : 'info', ['request'], {
          method: req.method,
          path,
          status: res.status,
          ms: Math.round(performance.now() - t0),
        }),
      );
      return res;
    } catch (e) {
      write(formatLine(svc, 'error', ['request'], { method: req.method, path, status: 500, ms: Math.round(performance.now() - t0) }));
      throw e;
    }
  };
}
