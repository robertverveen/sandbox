/**
 * Foutregistratie (HZW-007): een kleine Sentry-compatibele client voor GlitchTip (zelf gehost) of Sentry.
 * Geen SDK: alleen het envelope-protocol, zodat we precies weten wat er de deur uit gaat. Elke tekst gaat eerst
 * door scrub(): geen e-mail, IP, tokens of wachtwoorden. Zonder HZ_ERROR_DSN doet de client niets.
 */
import { randomBytes } from 'node:crypto';
import { scrub } from './scrub';

export interface Dsn {
  /** https://host[:port] */
  origin: string;
  publicKey: string;
  projectId: string;
  raw: string;
}

/** Parse een DSN als `https://<sleutel>@fouten.example.nl/<project>`. Gooit bij een ongeldige DSN. */
export function parseDsn(dsn: string): Dsn {
  const u = new URL(dsn);
  const projectId = u.pathname.replace(/^\/+|\/+$/g, '');
  if (!u.username || !/^\d+$/.test(projectId) || !/^https?:$/.test(u.protocol))
    throw new Error('ongeldige HZ_ERROR_DSN (verwacht https://<sleutel>@host/<project>)');
  return { origin: `${u.protocol}//${u.host}`, publicKey: u.username, projectId, raw: dsn };
}

interface Frame {
  filename: string;
  function: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
}

function frames(stack: string | undefined): Frame[] {
  if (!stack) return [];
  const out: Frame[] = [];
  for (const line of stack.split('\n').slice(1)) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (!m) continue;
    const filename = scrub(m[2] ?? '?');
    out.push({
      function: m[1] ?? '?',
      filename,
      lineno: Number(m[3]),
      colno: Number(m[4]),
      in_app: !filename.includes('node_modules') && !filename.startsWith('node:'),
    });
  }
  // Sentry verwacht de oudste frame eerst.
  return out.reverse();
}

export interface ErrorEvent {
  event_id: string;
  timestamp: number;
  platform: 'node';
  level: 'error' | 'fatal';
  logger: string;
  environment: string;
  release: string;
  tags: Record<string, string>;
  exception: { values: { type: string; value: string; stacktrace: { frames: Frame[] } }[] };
}

export interface Reporter {
  readonly enabled: boolean;
  capture(err: unknown, level?: 'error' | 'fatal'): Promise<boolean>;
  /** Wacht tot alle lopende verzendingen klaar zijn (bij afsluiten). */
  flush(): Promise<void>;
}

export interface ReporterOptions {
  dsn?: string | undefined;
  service: string;
  environment?: string | undefined;
  release?: string | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function toEvent(
  err: unknown,
  o: { service: string; environment: string; release: string; level: 'error' | 'fatal' },
): ErrorEvent {
  const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : JSON.stringify(err));
  return {
    event_id: randomBytes(16).toString('hex'),
    timestamp: Date.now() / 1000,
    platform: 'node',
    level: o.level,
    logger: o.service,
    environment: o.environment,
    release: o.release,
    tags: { service: o.service },
    exception: {
      values: [{ type: e.name || 'Error', value: scrub(e.message), stacktrace: { frames: frames(e.stack) } }],
    },
  };
}

export function createReporter(o: ReporterOptions): Reporter {
  const dsn = o.dsn ? parseDsn(o.dsn) : null;
  const doFetch = o.fetch ?? fetch;
  const pending = new Set<Promise<boolean>>();
  const environment = o.environment ?? 'development';
  const release = o.release ?? 'dev';

  async function send(ev: ErrorEvent): Promise<boolean> {
    if (!dsn) return false;
    const body =
      JSON.stringify({ event_id: ev.event_id, sent_at: new Date().toISOString() }) +
      '\n' +
      JSON.stringify({ type: 'event' }) +
      '\n' +
      JSON.stringify(ev) +
      '\n';
    try {
      const res = await doFetch(`${dsn.origin}/api/${dsn.projectId}/envelope/`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-sentry-envelope',
          'x-sentry-auth': `Sentry sentry_version=7, sentry_client=hz-ops/0.1, sentry_key=${dsn.publicKey}`,
        },
        body,
        signal: AbortSignal.timeout(o.timeoutMs ?? 5000),
      });
      return res.ok;
    } catch {
      // Foutregistratie mag de app nooit laten vallen.
      return false;
    }
  }

  return {
    enabled: !!dsn,
    capture(err, level = 'error') {
      const p = send(toEvent(err, { service: o.service, environment, release, level }));
      pending.add(p);
      void p.finally(() => pending.delete(p));
      return p;
    },
    async flush() {
      await Promise.allSettled([...pending]);
    },
  };
}
