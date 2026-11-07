/**
 * Tokens per collega: opslag (versleuteld in Postgres, zie @hz/db readConnectionToken) en verversen.
 *
 * Wat in `connections` staat is de platte tekst vóór versleuteling. Twee vormen:
 *  - een kaal access token (Slack user token `xoxp-…`, GitHub-token), of
 *  - JSON {access_token, refresh_token?, expires_at? (ms), scope?, cloud_id?} (Google, Atlassian).
 * De server ververst een verlopen token met de refresh token en slaat het nieuwe versleuteld op. De browser
 * ziet nooit een token; tokens komen nooit in logs.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { AuthError, ProviderHttpError, TransientError, type LiveCredentials } from './http';
import { NotConnectedError } from '../types';

export interface StoredToken {
  access_token: string;
  refresh_token?: string;
  /** Verloopmoment in ms sinds epoch. */
  expires_at?: number;
  scope?: string;
  /** Atlassian: site-id voor api.atlassian.com/ex/jira/{cloud_id}. */
  cloud_id?: string;
  [k: string]: unknown;
}

export function parseStoredToken(s: string): StoredToken {
  const t = s.trim();
  if (t.startsWith('{')) {
    const j = JSON.parse(t) as StoredToken;
    if (!j.access_token) throw new Error('token zonder access_token');
    return j;
  }
  return { access_token: t };
}

export interface TokenStore {
  load(userId: string, provider: string): Promise<string | null>;
  save(userId: string, provider: string, token: string): Promise<void>;
  /** 401 of mislukte refresh: koppeling op needs_reauth. */
  markReauth?(userId: string, provider: string, reason: string): Promise<void>;
}

export interface OAuthClient {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Google en GitHub: form; Atlassian: JSON. */
  format: 'form' | 'json';
}

/** Welke OAuth-client ververst welk token (Google-bronnen delen één client, K1). */
export const OAUTH_FAMILY: Record<string, 'google' | 'atlassian' | 'github' | 'slack' | 'wispr'> = {
  calendar: 'google',
  google_tasks: 'google',
  gmail: 'google',
  jira: 'atlassian',
  github: 'github',
  slack: 'slack',
  wispr: 'wispr',
};

export function oauthClientsFromEnv(env: Record<string, string | undefined>): Partial<Record<string, OAuthClient>> {
  const out: Partial<Record<string, OAuthClient>> = {};
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
    out.google = {
      tokenUrl: env.GOOGLE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      format: 'form',
    };
  if (env.ATLASSIAN_CLIENT_ID && env.ATLASSIAN_CLIENT_SECRET)
    out.atlassian = {
      tokenUrl: env.ATLASSIAN_TOKEN_URL ?? 'https://auth.atlassian.com/oauth/token',
      clientId: env.ATLASSIAN_CLIENT_ID,
      clientSecret: env.ATLASSIAN_CLIENT_SECRET,
      format: 'json',
    };
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET)
    out.github = {
      tokenUrl: env.GITHUB_TOKEN_URL ?? 'https://github.com/login/oauth/access_token',
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      format: 'form',
    };
  return out;
}

/** Per request (API) of per job (worker): voor welke collega werken we. */
const scope = new AsyncLocalStorage<{ userId: string; name?: string }>();
/** `name`: voornaam van de collega (owner in de contextlaag: eigen meetings, eigen nachtrun, eigen acties). */
export const withUserScope = <T>(userId: string, fn: () => T, meta: { name?: string | null } = {}): T =>
  scope.run({ userId, name: meta.name ?? undefined }, fn);
export const currentUserId = (): string | undefined => scope.getStore()?.userId;
export const currentUserName = (): string | undefined => scope.getStore()?.name;

export interface UserCredentialsOptions {
  store: TokenStore;
  clients?: Partial<Record<string, OAuthClient>>;
  /** Vaste collega (worker) of uit de scope (API). */
  userId?: string | (() => string | undefined);
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Zoveel ms vóór verlopen al verversen. */
  skewMs?: number;
}

/**
 * LiveCredentials op een TokenStore: laadt het token van de collega, ververst het als het (bijna) verlopen
 * is en slaat het nieuwe token op. Gelijktijdige verversingen voor dezelfde collega en bron delen één call.
 */
export function createUserCredentials(o: UserCredentialsOptions): LiveCredentials & {
  stored(provider: string): Promise<StoredToken>;
} {
  const now = o.now ?? Date.now;
  const skew = o.skewMs ?? 60_000;
  const doFetch = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const inflight = new Map<string, Promise<StoredToken>>();
  const who = () => {
    const u = typeof o.userId === 'function' ? o.userId() : (o.userId ?? currentUserId());
    if (!u) throw new NotConnectedError('auth', 'geen ingelogde collega in deze context');
    return u;
  };

  async function refresh(userId: string, provider: string, t: StoredToken): Promise<StoredToken> {
    const fam = OAUTH_FAMILY[provider] ?? provider;
    const client = o.clients?.[fam];
    if (!client || !t.refresh_token) return t;
    const params = {
      grant_type: 'refresh_token',
      refresh_token: t.refresh_token,
      client_id: client.clientId,
      client_secret: client.clientSecret,
    };
    let res: Response;
    try {
      res = await doFetch(client.tokenUrl, {
        method: 'POST',
        headers:
          client.format === 'json'
            ? { 'content-type': 'application/json', accept: 'application/json' }
            : { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: client.format === 'json' ? JSON.stringify(params) : new URLSearchParams(params).toString(),
      });
    } catch (e) {
      throw new TransientError(provider, 0, `verversen mislukt: ${e instanceof Error ? e.message : e}`);
    }
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof j.access_token !== 'string') {
      if (res.status >= 500) throw new TransientError(provider, res.status, 'verversen mislukt');
      await o.store.markReauth?.(userId, provider, String(j.error ?? res.status));
      throw new AuthError(provider, 'verversen geweigerd, opnieuw koppelen');
    }
    const next: StoredToken = {
      ...t,
      access_token: j.access_token,
      // Atlassian roteert de refresh token; Google geeft meestal geen nieuwe.
      refresh_token: typeof j.refresh_token === 'string' ? j.refresh_token : t.refresh_token,
      expires_at: typeof j.expires_in === 'number' ? now() + j.expires_in * 1000 : undefined,
      scope: typeof j.scope === 'string' ? j.scope : t.scope,
    };
    await o.store.save(userId, provider, JSON.stringify(next));
    return next;
  }

  async function stored(provider: string): Promise<StoredToken> {
    const userId = who();
    let raw = await o.store.load(userId, provider);
    // Google-bronnen mogen één gedeelde koppeling 'google' gebruiken (incrementele toestemming).
    let key = provider;
    if (!raw && OAUTH_FAMILY[provider] === 'google') {
      raw = await o.store.load(userId, 'google');
      key = 'google';
    }
    if (!raw) throw new NotConnectedError(provider, 'niet gekoppeld');
    const t = parseStoredToken(raw);
    if (t.expires_at === undefined || t.expires_at - skew > now()) return t;
    const k = `${userId}|${key}`;
    let p = inflight.get(k);
    if (!p) {
      p = refresh(userId, key, t).finally(() => inflight.delete(k));
      inflight.set(k, p);
    }
    return p;
  }

  return {
    stored,
    accessToken: async (provider) => (await stored(provider)).access_token,
    rejected: async (provider) => {
      const userId = typeof o.userId === 'function' ? o.userId() : (o.userId ?? currentUserId());
      if (!userId) return;
      // Afkeuren raakt de rij die het token echt draagt: zonder eigen rij is dat de gedeelde Google-koppeling.
      let key = provider;
      if (OAUTH_FAMILY[provider] === 'google' && !(await o.store.load(userId, provider)))
        if (await o.store.load(userId, 'google')) key = 'google';
      await o.store.markReauth?.(userId, key, '401');
    },
  };
}

/** Voor tests en lokaal: tokens in het geheugen. */
export class MemoryTokenStore implements TokenStore {
  readonly tokens = new Map<string, string>();
  readonly reauth: Array<{ userId: string; provider: string; reason: string }> = [];
  set(userId: string, provider: string, token: string | StoredToken) {
    this.tokens.set(`${userId}|${provider}`, typeof token === 'string' ? token : JSON.stringify(token));
    return this;
  }
  async load(userId: string, provider: string) {
    return this.tokens.get(`${userId}|${provider}`) ?? null;
  }
  async save(userId: string, provider: string, token: string) {
    this.tokens.set(`${userId}|${provider}`, token);
  }
  async markReauth(userId: string, provider: string, reason: string) {
    this.reauth.push({ userId, provider, reason });
  }
}

export { ProviderHttpError };

/**
 * Een mens drukt op de knop. Schrijfacties die anderen zien (bericht, reactie, uitnodiging, reactie op een
 * afspraak) mogen alleen binnen een request van een ingelogde collega die zelf klikte (de API zet dit voor
 * POST/PUT/PATCH/DELETE). De worker, skills en Claude zetten het nooit: zij maken alleen concepten.
 */
const human = new AsyncLocalStorage<{ userId: string }>();
export const withHumanAction = <T>(userId: string, fn: () => T): T => human.run({ userId }, fn);
export class NotHumanError extends Error {
  constructor(provider: string, what: string) {
    super(`${provider}: ${what} mag alleen na een klik van een mens (de app verstuurt nooit zelf iets)`);
    this.name = 'NotHumanError';
  }
}
export function assertHumanAction(provider: string, what: string) {
  const h = human.getStore();
  if (!h || (currentUserId() && h.userId !== currentUserId())) throw new NotHumanError(provider, what);
}
