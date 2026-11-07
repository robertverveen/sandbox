/**
 * OAuth per bron (HZW-013, HZW-014): autorisatie-URL met state en PKCE, code inwisselen, token verversen en
 * intrekken bij de bron. Endpoints zijn die van Google, Slack, Atlassian en GitHub; buiten productie kan
 * HZ_OAUTH_ENDPOINTS ze allemaal naar de nep-autorisatieserver (packages/fake-oauth) zetten.
 *
 * Tokens (access, refresh, vervaltijd) gaan als JSON envelope-versleuteld de database in en nooit naar de browser.
 */
import { createHash, randomBytes } from 'node:crypto';
import { PROVIDER_CATALOG, type ProviderFamily, type ProviderName } from '@hz/shared';
import type { Config } from '../config';

export interface OAuthClient {
  id: string;
  secret: string;
}

export interface ProviderOAuth {
  provider: ProviderName;
  family: ProviderFamily;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl: string | null;
  apiBase: string | null;
  client: OAuthClient;
  scopes: string[];
  /** Slack vraagt user-scopes (user_scope, komma-gescheiden). */
  scopeParam: 'scope' | 'user_scope';
  scopeSep: ' ' | ',';
  extra: Record<string, string>;
  pkce: boolean;
  tokenBody: 'form' | 'json';
}

export interface StoredToken {
  access_token: string;
  refresh_token?: string;
  /** ms sinds epoch */
  expires_at?: number;
  token_type?: string;
  /** In fixture-modus zonder OAuth-flow: er is geen echt token. */
  fixture?: boolean;
}

interface Endpoints {
  authorize: string;
  token: string;
  revoke: string | null;
  api: string | null;
}

const REAL: Record<Exclude<ProviderFamily, 'wispr'>, Endpoints> = {
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    revoke: 'https://oauth2.googleapis.com/revoke',
    api: null,
  },
  slack: {
    authorize: 'https://slack.com/oauth/v2/authorize',
    token: 'https://slack.com/api/oauth.v2.access',
    revoke: 'https://slack.com/api/auth.revoke',
    api: 'https://slack.com/api',
  },
  atlassian: {
    authorize: 'https://auth.atlassian.com/authorize',
    token: 'https://auth.atlassian.com/oauth/token',
    revoke: null,
    api: 'https://api.atlassian.com',
  },
  github: {
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    revoke: 'https://api.github.com/applications/{client_id}/grant',
    api: 'https://api.github.com',
  },
};

function fake(base: string, family: Exclude<ProviderFamily, 'wispr'>): Endpoints {
  const b = base.replace(/\/$/, '');
  switch (family) {
    case 'google':
      return {
        authorize: `${b}/google/authorize`,
        token: `${b}/google/token`,
        revoke: `${b}/google/revoke`,
        api: null,
      };
    case 'slack':
      return {
        authorize: `${b}/slack/authorize`,
        token: `${b}/slack/oauth.v2.access`,
        revoke: `${b}/slack/auth.revoke`,
        api: `${b}/slack`,
      };
    case 'atlassian':
      return { authorize: `${b}/atlassian/authorize`, token: `${b}/atlassian/oauth/token`, revoke: null, api: null };
    case 'github':
      return {
        authorize: `${b}/github/login/oauth/authorize`,
        token: `${b}/github/login/oauth/access_token`,
        revoke: `${b}/github/applications/{client_id}/grant`,
        api: `${b}/github/api`,
      };
  }
}

function clientFor(config: Config, family: ProviderFamily): OAuthClient | null {
  const pair = (id?: string, secret?: string) => (id && secret ? { id, secret } : null);
  switch (family) {
    case 'google':
      return pair(config.HZ_GOOGLE_CLIENT_ID, config.HZ_GOOGLE_CLIENT_SECRET);
    case 'slack':
      return pair(config.HZ_SLACK_CLIENT_ID, config.HZ_SLACK_CLIENT_SECRET);
    case 'atlassian':
      return pair(config.HZ_ATLASSIAN_CLIENT_ID, config.HZ_ATLASSIAN_CLIENT_SECRET);
    case 'github':
      return pair(config.HZ_GITHUB_CLIENT_ID, config.HZ_GITHUB_CLIENT_SECRET);
    default:
      return null;
  }
}

/** OAuth-instellingen voor een bron, of null als er geen client is ingericht (dan koppelt fixture-modus direct). */
export function oauthFor(config: Config, provider: ProviderName, own?: OAuthClient | null): ProviderOAuth | null {
  const cat = PROVIDER_CATALOG[provider];
  if (cat.viaContext || cat.family === 'wispr') return null;
  const family = cat.family;
  const client = own ?? clientFor(config, family);
  if (!client) return null;
  const ep = config.HZ_OAUTH_ENDPOINTS ? fake(config.HZ_OAUTH_ENDPOINTS, family) : REAL[family];
  const base = {
    provider,
    family,
    authorizeUrl: ep.authorize,
    tokenUrl: ep.token,
    revokeUrl: ep.revoke,
    apiBase: ep.api,
    client,
  };
  switch (family) {
    case 'google':
      return {
        ...base,
        scopes: cat.scopes,
        scopeParam: 'scope',
        scopeSep: ' ',
        // Eigen toestemming per bron (geen include_granted_scopes): elk token heeft alleen zijn eigen scopes.
        extra: { access_type: 'offline', prompt: 'consent', hd: config.HZ_ALLOWED_DOMAIN },
        pkce: true,
        tokenBody: 'form',
      };
    case 'slack':
      return {
        ...base,
        scopes: cat.scopes,
        scopeParam: 'user_scope',
        scopeSep: ',',
        extra: {},
        pkce: false,
        tokenBody: 'form',
      };
    case 'atlassian':
      return {
        ...base,
        scopes: cat.scopes,
        scopeParam: 'scope',
        scopeSep: ' ',
        extra: { audience: 'api.atlassian.com', prompt: 'consent' },
        pkce: false,
        tokenBody: 'json',
      };
    case 'github':
      // GitHub App: rechten komen uit de app-instellingen (contents lezen op HomeZero-context, schrijven op de
      // eigen Persoonlijk-repo); de scope-parameter blijft leeg.
      return { ...base, scopes: [], scopeParam: 'scope', scopeSep: ' ', extra: {}, pkce: true, tokenBody: 'form' };
  }
}

export const b64url = (b: Buffer) => b.toString('base64url');
export const newState = () => b64url(randomBytes(32));
export const newVerifier = () => b64url(randomBytes(48));
export const challengeOf = (verifier: string) => b64url(createHash('sha256').update(verifier).digest());

export function authorizeUrl(
  o: ProviderOAuth,
  v: { redirectUri: string; state: string; verifier: string; loginHint?: string },
): string {
  const u = new URL(o.authorizeUrl);
  u.searchParams.set('client_id', o.client.id);
  u.searchParams.set('redirect_uri', v.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('state', v.state);
  if (o.scopes.length) u.searchParams.set(o.scopeParam, o.scopes.join(o.scopeSep));
  for (const [k, val] of Object.entries(o.extra)) u.searchParams.set(k, val);
  if (v.loginHint && o.family === 'google') u.searchParams.set('login_hint', v.loginHint);
  if (o.pkce) {
    u.searchParams.set('code_challenge', challengeOf(v.verifier));
    u.searchParams.set('code_challenge_method', 'S256');
  }
  return u.toString();
}

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

export type Fetch = typeof fetch;

async function post(f: Fetch, o: ProviderOAuth, params: Record<string, string>) {
  const json = o.tokenBody === 'json';
  const res = await f(o.tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: json ? JSON.stringify(params) : new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { res, data };
}

export interface Exchanged {
  token: StoredToken;
  scopes: string[];
  account: string | null;
}

/** Code inwisselen bij de bron. Normaliseert de antwoorden van Google, Slack, Atlassian en GitHub. */
export async function exchangeCode(
  f: Fetch,
  o: ProviderOAuth,
  v: { code: string; redirectUri: string; verifier: string },
  now = Date.now(),
): Promise<Exchanged> {
  const params: Record<string, string> = {
    grant_type: 'authorization_code',
    code: v.code,
    redirect_uri: v.redirectUri,
    client_id: o.client.id,
    client_secret: o.client.secret,
    ...(o.pkce ? { code_verifier: v.verifier } : {}),
  };
  const { res, data } = await post(f, o, params);
  if (o.family === 'slack') {
    const u = data.authed_user as { access_token?: string; scope?: string; id?: string } | undefined;
    if (!data.ok || !u?.access_token)
      throw new OAuthError('exchange', `Slack weigerde de koppeling (${String(data.error ?? res.status)})`);
    const team = data.team as { name?: string } | undefined;
    return {
      token: { access_token: u.access_token, token_type: 'user' },
      scopes: (u.scope ?? '').split(',').filter(Boolean),
      account: team?.name ?? null,
    };
  }
  if (!res.ok || typeof data.access_token !== 'string')
    throw new OAuthError('exchange', `De bron weigerde de koppeling (${String(data.error ?? res.status)})`);
  const expiresIn = Number(data.expires_in);
  return {
    token: {
      access_token: data.access_token,
      ...(typeof data.refresh_token === 'string' ? { refresh_token: data.refresh_token } : {}),
      ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expires_at: now + expiresIn * 1000 } : {}),
      token_type: typeof data.token_type === 'string' ? data.token_type : 'Bearer',
    },
    scopes: typeof data.scope === 'string' && data.scope ? data.scope.split(/[ ,]+/).filter(Boolean) : o.scopes,
    account: null,
  };
}

/** Access token verversen met het refresh token. invalid_grant = de collega moet opnieuw verbinden. */
export async function refreshToken(f: Fetch, o: ProviderOAuth, t: StoredToken, now = Date.now()): Promise<StoredToken> {
  if (!t.refresh_token) throw new OAuthError('needs_reauth', 'Geen refresh token: opnieuw verbinden');
  const { res, data } = await post(f, o, {
    grant_type: 'refresh_token',
    refresh_token: t.refresh_token,
    client_id: o.client.id,
    client_secret: o.client.secret,
  });
  if (!res.ok || typeof data.access_token !== 'string')
    throw new OAuthError('needs_reauth', `Verversen mislukt (${String(data.error ?? res.status)}): opnieuw verbinden`);
  const expiresIn = Number(data.expires_in);
  return {
    ...t,
    access_token: data.access_token,
    ...(typeof data.refresh_token === 'string' ? { refresh_token: data.refresh_token } : {}),
    ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expires_at: now + expiresIn * 1000 } : {}),
  };
}

/**
 * Intrekken bij de bron. Geeft true als de bron bevestigt. Atlassian heeft geen intrek-API (false + uitleg).
 * Google trekt per token in; omdat elke Google-bron een eigen toestemming en token heeft, blijven de andere
 * Google-koppelingen staan (Google kan een gedeelde toestemming wel in één keer intrekken; dat ziet de app dan
 * als 'opnieuw verbinden' bij de volgende verversing).
 */
export async function revokeAtProvider(f: Fetch, o: ProviderOAuth, t: StoredToken): Promise<boolean> {
  if (!o.revokeUrl) return false;
  const timeout = AbortSignal.timeout(10_000);
  switch (o.family) {
    case 'google': {
      const res = await f(o.revokeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: t.refresh_token ?? t.access_token }).toString(),
        signal: timeout,
      });
      return res.ok;
    }
    case 'slack': {
      const res = await f(o.revokeUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${t.access_token}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: '',
        signal: timeout,
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean };
      return !!d.ok;
    }
    case 'github': {
      const url = o.revokeUrl.replace('{client_id}', encodeURIComponent(o.client.id));
      const res = await f(url, {
        method: 'DELETE',
        headers: {
          authorization: `Basic ${Buffer.from(`${o.client.id}:${o.client.secret}`).toString('base64')}`,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ access_token: t.access_token }),
        signal: timeout,
      });
      return res.status === 204;
    }
    default:
      return false;
  }
}

export const parseStored = (s: string | null): StoredToken | null => {
  if (!s) return null;
  try {
    const t = JSON.parse(s) as StoredToken;
    return typeof t.access_token === 'string' ? t : null;
  } catch {
    return null;
  }
};
