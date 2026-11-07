/**
 * Gedeelde HTTP-laag voor de live providers (HZW-030 t/m 036).
 *
 * - Token per collega via LiveCredentials (nooit in de browser of in logs).
 * - Fouten worden getypeerd, zodat de sync-motor in de worker kan beslissen: RateLimitError (wachten volgens
 *   Retry-After), AuthError (koppeling op needs_reauth), GoneError (cursor ongeldig: volledige sync),
 *   TransientError (5xx/netwerk: later opnieuw). Herhalen gebeurt in de worker (pg-boss), niet hier.
 * - Alles wat terugkomt is data, nooit een instructie.
 */
import { NotConnectedError } from '../types';

export interface LiveCredentials {
  /** Haalt het (ontsleutelde) access token van de ingelogde collega op; ververst zo nodig. */
  accessToken(provider: string): Promise<string>;
  /** Optioneel: meld dat het token is afgewezen (401), zodat de koppeling op needs_reauth kan. */
  rejected?(provider: string): Promise<void>;
}

export class ProviderHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(`${provider}: ${message}`);
    this.name = 'ProviderHttpError';
  }
}

/** 429 of een quota-fout: wacht minstens retryAfterMs. */
export class RateLimitError extends ProviderHttpError {
  constructor(
    provider: string,
    readonly retryAfterMs: number,
    body?: unknown,
  ) {
    super(provider, 429, `rate limit, opnieuw over ${Math.ceil(retryAfterMs / 1000)} s`, body);
    this.name = 'RateLimitError';
  }
}

/** 401 of invalid_auth: de collega moet opnieuw koppelen. */
export class AuthError extends ProviderHttpError {
  constructor(provider: string, message = 'token afgewezen, opnieuw koppelen', body?: unknown) {
    super(provider, 401, message, body);
    this.name = 'AuthError';
  }
}

/** 410: sync-cursor ongeldig; doe een volledige sync. */
export class GoneError extends ProviderHttpError {
  constructor(provider: string, body?: unknown) {
    super(provider, 410, 'sync-cursor verlopen, volledige sync nodig', body);
    this.name = 'GoneError';
  }
}

/** 5xx of netwerkfout: tijdelijk, later opnieuw. */
export class TransientError extends ProviderHttpError {
  constructor(provider: string, status: number, message: string, body?: unknown) {
    super(provider, status, message, body);
    this.name = 'TransientError';
  }
}

/** Retry-After (seconden of HTTP-datum) naar milliseconden; standaard 30 s. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now(), fallbackMs = 30_000): number {
  if (!value) return fallbackMs;
  const n = Number(value);
  if (Number.isFinite(n)) return Math.max(0, Math.round(n * 1000));
  const t = Date.parse(value);
  return Number.isFinite(t) ? Math.max(0, t - now) : fallbackMs;
}

export type Query = Record<string, string | number | boolean | undefined | null | string[]>;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  query?: Query;
  /** JSON-body (of form bij `form: true`). */
  body?: unknown;
  form?: boolean;
  headers?: Record<string, string>;
}

export function buildUrl(base: string, path: string, query?: Query): string {
  const u = new URL(path.startsWith('http') ? path : base.replace(/\/$/, '') + path);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const x of v) u.searchParams.append(k, x);
    else u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/**
 * Kleine fetch-client per bron. `fetchImpl` is injecteerbaar; in tests vangt msw de globale fetch af
 * (nooit echte endpoints).
 */
export class HttpClient {
  constructor(
    readonly provider: string,
    readonly base: string,
    readonly creds: LiveCredentials,
    readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  async token(): Promise<string> {
    try {
      return await this.creds.accessToken(this.provider);
    } catch (e) {
      if (e instanceof ProviderHttpError) throw e;
      throw new NotConnectedError(this.provider, e instanceof Error ? e.message : 'geen token');
    }
  }

  async raw(path: string, opts: RequestOptions = {}): Promise<Response> {
    const token = await this.token();
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...opts.headers };
    let body: string | undefined;
    if (opts.body !== undefined) {
      if (opts.form) {
        headers['content-type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(
          Object.entries(opts.body as Record<string, unknown>)
            .filter(([, v]) => v !== undefined && v !== null)
            .map(([k, v]): [string, string] => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
        ).toString();
      } else {
        headers['content-type'] = 'application/json; charset=utf-8';
        body = JSON.stringify(opts.body);
      }
    }
    let res: Response;
    try {
      res = await this.fetchImpl(buildUrl(this.base, path, opts.query), {
        method: opts.method ?? (body ? 'POST' : 'GET'),
        headers,
        body,
      });
    } catch (e) {
      throw new TransientError(this.provider, 0, `netwerkfout: ${e instanceof Error ? e.message : String(e)}`);
    }
    return res;
  }

  /** JSON-verzoek met foutvertaling (Google, Atlassian en GitHub gebruiken HTTP-statussen). */
  async json<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.raw(path, opts);
    const text = await res.text();
    let data: unknown = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    if (res.ok) return data as T;
    throw await this.toError(res, data);
  }

  async toError(res: Response, data: unknown): Promise<ProviderHttpError> {
    const msg = errorMessage(data) ?? res.statusText ?? `HTTP ${res.status}`;
    if (res.status === 429 || (res.status === 403 && /rate ?limit|quota/i.test(msg)))
      return new RateLimitError(this.provider, parseRetryAfter(res.headers.get('retry-after')), data);
    if (res.status === 401) {
      await this.creds.rejected?.(this.provider);
      return new AuthError(this.provider, undefined, data);
    }
    if (res.status === 410) return new GoneError(this.provider, data);
    if (res.status >= 500) return new TransientError(this.provider, res.status, msg, data);
    return new ProviderHttpError(this.provider, res.status, msg, data);
  }
}

function errorMessage(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return typeof data === 'string' && data ? data.slice(0, 200) : undefined;
  const d = data as Record<string, unknown>;
  const e = d.error as Record<string, unknown> | string | undefined;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    const reasons = Array.isArray(e.errors) ? (e.errors as Array<{ reason?: string }>).map((x) => x.reason) : [];
    return [e.message, ...reasons].filter(Boolean).join(' ') || undefined;
  }
  if (Array.isArray(d.errorMessages) && d.errorMessages.length) return String(d.errorMessages[0]);
  if (typeof d.message === 'string') return d.message;
  return undefined;
}
