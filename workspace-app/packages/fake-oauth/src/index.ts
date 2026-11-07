/**
 * Nep-autorisatieserver voor tests en lokale e2e (nooit echte Google, Slack, Atlassian of GitHub).
 *
 * - Google OIDC-uitgever op `/google` (discovery, authorize met accountkiezer, token met PKCE, userinfo, JWKS,
 *   revoke). De testaccounts dekken de weigergevallen: privé-adres, ongeverifieerd, verkeerde hd.
 * - Dezelfde Google-endpoints voor de bronkoppelingen (Taken, Agenda, Gmail): toestemmingsscherm per scope.
 * - Slack (`/slack/authorize`, `oauth.v2.access`, `auth.revoke`), Atlassian 3LO (`/atlassian/...`, geen revoke,
 *   net als echt) en GitHub (`/github/login/oauth/...`, grant intrekken, `GET /github/api/repos/:o/:r`).
 * - `GET /_state` geeft uitgegeven en ingetrokken tokens terug (alleen voor tests); `POST /_reset` wist alles.
 *
 * Alle accounts en data zijn synthetisch.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';

export interface FakeAccount {
  id: string;
  sub: string;
  email: string;
  name: string;
  email_verified: boolean;
  hd?: string;
  /** Uitleg op de kiezer, bv. "privé-account". */
  note?: string;
}

export const DEFAULT_ACCOUNTS: FakeAccount[] = [
  {
    id: 'robert',
    sub: '100000000000000000001',
    email: 'robert@homezero.nl',
    name: 'Robert Verveen',
    email_verified: true,
    hd: 'homezero.nl',
  },
  {
    id: 'lisanne',
    sub: '100000000000000000002',
    email: 'lisanne@homezero.nl',
    name: 'Lisanne de Vries',
    email_verified: true,
    hd: 'homezero.nl',
  },
  {
    id: 'prive',
    sub: '100000000000000000003',
    email: 'robert.prive@gmail.com',
    name: 'Robert Privé',
    email_verified: true,
    note: 'privé-account',
  },
  {
    id: 'onbevestigd',
    sub: '100000000000000000004',
    email: 'nieuw@homezero.nl',
    name: 'Nieuw Account',
    email_verified: false,
    hd: 'homezero.nl',
    note: 'e-mail niet geverifieerd',
  },
  {
    id: 'gast',
    sub: '100000000000000000005',
    email: 'gast@homezero.nl',
    name: 'Gast Zonder Uitnodiging',
    email_verified: true,
    hd: 'homezero.nl',
    note: 'niet op de teamlijst',
  },
  {
    id: 'valshd',
    sub: '100000000000000000006',
    email: 'mike@homezero.nl',
    name: 'Mike (verkeerde hd)',
    email_verified: true,
    hd: 'anders.nl',
    note: 'hd-claim klopt niet',
  },
];

export interface FakeClient {
  id: string;
  secret: string;
}

export interface FakeOAuthOptions {
  port?: number;
  host?: string;
  accounts?: FakeAccount[];
  /** Toegestane clients per familie (google, slack, atlassian, github). Leeg = elke client met een geheim. */
  clients?: Partial<Record<Family, FakeClient[]>>;
  /** Repo's die bestaan voor GET /github/api/repos/:owner/:repo. */
  githubRepos?: string[];
}

type Family = 'google' | 'slack' | 'atlassian' | 'github';

interface CodeGrant {
  family: Family;
  clientId: string;
  redirectUri: string;
  scope: string;
  account: FakeAccount;
  nonce?: string;
  challenge?: string;
  method?: string;
  offline: boolean;
  expires: number;
}

export interface IssuedToken {
  family: Family;
  kind: 'access' | 'refresh';
  token: string;
  grantId: string;
  email: string;
  scope: string;
  clientId: string;
  revoked: boolean;
}

export interface FakeOAuth {
  url: string;
  issuer: string;
  server: Server;
  tokens: IssuedToken[];
  /** Laatste autorisatieverzoek per familie (parameters zoals ontvangen). */
  lastAuthorize: Partial<Record<Family, Record<string, string>>>;
  close(): Promise<void>;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const b64url = (b: Buffer) => b.toString('base64url');
const tok = (prefix: string) => prefix + b64url(randomBytes(24));

async function body(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  if ((req.headers['content-type'] ?? '').includes('application/json')) {
    try {
      const j = JSON.parse(raw) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, String(v)]));
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function send(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}) {
  const isStr = typeof data === 'string';
  res.writeHead(status, {
    'content-type': isStr ? 'text/html; charset=utf-8' : 'application/json',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(isStr ? data : JSON.stringify(data));
}

const page = (title: string, inner: string) => `<!doctype html>
<html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
body{font-family:system-ui,sans-serif;background:#f4f5f8;color:#1b1d24;margin:0;display:grid;place-items:center;min-height:100vh}
main{background:#fff;border-radius:14px;box-shadow:0 2px 12px rgba(0,0,0,.08);padding:28px;max-width:420px;width:calc(100% - 32px)}
h1{font-size:20px;margin:0 0 4px}p{color:#555;margin:0 0 16px;font-size:14px}
.acc{display:flex;width:100%;text-align:left;gap:10px;align-items:center;border:1px solid #dde;border-radius:10px;padding:10px 12px;margin:0 0 8px;background:#fff;font:inherit;cursor:pointer}
.acc:hover{background:#f0f3ff}.acc small{display:block;color:#666}.tag{margin-left:auto;font-size:11px;color:#a33}
ul{font-size:13px;color:#333;padding-left:18px}button.primary{background:#0022c4;color:#fff;border:0;border-radius:8px;padding:9px 16px;font:inherit;cursor:pointer}
button.ghost{background:none;border:1px solid #ccd;border-radius:8px;padding:9px 16px;font:inherit;cursor:pointer;margin-left:8px}
.badge{display:inline-block;font-size:11px;background:#fff3cd;border-radius:6px;padding:2px 6px;margin-bottom:12px}
</style></head><body><main><span class="badge">Nep-autorisatieserver (test)</span>${inner}</main></body></html>`;

const FAMILY_LABEL: Record<Family, string> = {
  google: 'Google',
  slack: 'Slack',
  atlassian: 'Atlassian',
  github: 'GitHub',
};

export async function startFakeOAuth(opts: FakeOAuthOptions = {}): Promise<FakeOAuth> {
  const accounts = opts.accounts ?? DEFAULT_ACCOUNTS;
  const repos = new Set((opts.githubRepos ?? []).map((r) => r.toLowerCase()));
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'fake-1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, CodeGrant>();
  const tokens: IssuedToken[] = [];
  const lastAuthorize: FakeOAuth['lastAuthorize'] = {};
  let base = '';

  const clientOk = (family: Family, id: string | undefined, secret: string | undefined) => {
    if (!id || !secret) return false;
    const list = opts.clients?.[family];
    return list ? list.some((c) => c.id === id && c.secret === secret) : true;
  };
  const basic = (req: IncomingMessage) => {
    const h = req.headers.authorization ?? '';
    if (!h.startsWith('Basic ')) return null;
    const [id, secret] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
    return { id: decodeURIComponent(id ?? ''), secret: decodeURIComponent(secret ?? '') };
  };
  const bearer = (req: IncomingMessage) => {
    const h = req.headers.authorization ?? '';
    return h.startsWith('Bearer ') ? h.slice(7) : null;
  };
  const live = (t: string | null, family: Family, kind: IssuedToken['kind'] = 'access') =>
    t ? tokens.find((x) => x.token === t && x.family === family && x.kind === kind && !x.revoked) : undefined;

  async function idToken(g: CodeGrant) {
    const a = g.account;
    const claims: Record<string, unknown> = {
      email: a.email,
      email_verified: a.email_verified,
      name: a.name,
      ...(a.hd ? { hd: a.hd } : {}),
      ...(g.nonce ? { nonce: g.nonce } : {}),
    };
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'fake-1' })
      .setIssuer(`${base}/google`)
      .setAudience(g.clientId)
      .setSubject(a.sub)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey as CryptoKey);
  }

  function authorizePage(family: Family, q: URLSearchParams, path: string) {
    lastAuthorize[family] = Object.fromEntries(q);
    const redirect = q.get('redirect_uri');
    const clientId = q.get('client_id');
    if (!redirect || !clientId)
      return page('Fout', '<h1>Ongeldig verzoek</h1><p>redirect_uri of client_id ontbreekt.</p>');
    const scopes = (q.get('scope') ?? q.get('user_scope') ?? '').split(/[ ,]+/).filter(Boolean);
    const login = family === 'google' && scopes.includes('openid');
    const hidden = [...q.entries()]
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
      .join('');
    if (login) {
      const list = accounts
        .map(
          (a) =>
            `<button class="acc" name="account" value="${esc(a.id)}" type="submit"><span><b>${esc(a.name)}</b><small>${esc(a.email)}</small></span>${a.note ? `<span class="tag">${esc(a.note)}</span>` : ''}</button>`,
        )
        .join('');
      return page(
        'Kies een account',
        `<h1>Kies een account</h1><p>om verder te gaan naar HomeZero Workspace</p><form method="post" action="${esc(path)}">${hidden}${list}</form>`,
      );
    }
    const hint = q.get('login_hint');
    const acc = accounts.find((a) => a.email === hint) ?? accounts[0]!;
    return page(
      `${FAMILY_LABEL[family]}: toestemming`,
      `<h1>HomeZero Workspace wil toegang tot ${esc(FAMILY_LABEL[family])}</h1><p>Account: ${esc(acc.email)}</p>
<ul>${scopes.map((s) => `<li>${esc(s)}</li>`).join('') || '<li>(rechten van de app)</li>'}</ul>
<form method="post" action="${esc(path)}">${hidden}<input type="hidden" name="account" value="${esc(acc.id)}">
<button class="primary" name="decision" value="allow" type="submit">Toestaan</button><button class="ghost" name="decision" value="deny" type="submit">Weigeren</button></form>`,
    );
  }

  function approve(family: Family, p: Record<string, string>, res: ServerResponse) {
    const redirect = p.redirect_uri;
    if (!redirect) return send(res, 400, page('Fout', '<h1>redirect_uri ontbreekt</h1>'));
    const back = new URL(redirect);
    if (p.state) back.searchParams.set('state', p.state);
    if (p.decision === 'deny') {
      back.searchParams.set('error', 'access_denied');
      return send(res, 302, '', { location: back.toString() });
    }
    const account = accounts.find((a) => a.id === p.account);
    if (!account) return send(res, 400, page('Fout', '<h1>Onbekend account</h1>'));
    const code = tok('code_');
    codes.set(code, {
      family,
      clientId: p.client_id ?? '',
      redirectUri: redirect,
      scope: p.scope ?? p.user_scope ?? '',
      account,
      nonce: p.nonce,
      challenge: p.code_challenge,
      method: p.code_challenge_method,
      offline: family === 'google' ? p.access_type === 'offline' : family !== 'slack',
      expires: Date.now() + 60_000,
    });
    back.searchParams.set('code', code);
    return send(res, 302, '', { location: back.toString() });
  }

  function redeem(family: Family, p: Record<string, string>, req: IncomingMessage) {
    const b = basic(req);
    const clientId = b?.id ?? p.client_id;
    const secret = b?.secret ?? p.client_secret;
    if (!clientOk(family, clientId, secret)) return { status: 401, data: { error: 'invalid_client' } };
    const g = p.code ? codes.get(p.code) : undefined;
    if (p.code) codes.delete(p.code); // eenmalig
    if (!g || g.family !== family || g.expires < Date.now()) return { status: 400, data: { error: 'invalid_grant' } };
    if (g.clientId !== clientId) return { status: 400, data: { error: 'invalid_grant', detail: 'client' } };
    if (p.redirect_uri !== g.redirectUri)
      return { status: 400, data: { error: 'invalid_grant', detail: 'redirect_uri' } };
    if (g.challenge) {
      const v = p.code_verifier ?? '';
      const calc = g.method === 'S256' ? b64url(createHash('sha256').update(v).digest()) : v;
      if (calc !== g.challenge) return { status: 400, data: { error: 'invalid_grant', detail: 'pkce' } };
    }
    const grantId = b64url(randomBytes(8));
    const access = tok(family === 'slack' ? 'xoxp-' : family === 'github' ? 'ghu_' : 'ya29.');
    tokens.push({
      family,
      kind: 'access',
      token: access,
      grantId,
      email: g.account.email,
      scope: g.scope,
      clientId: clientId!,
      revoked: false,
    });
    let refresh: string | undefined;
    if (g.offline) {
      refresh = tok(family === 'github' ? 'ghr_' : '1//');
      tokens.push({
        family,
        kind: 'refresh',
        token: refresh,
        grantId,
        email: g.account.email,
        scope: g.scope,
        clientId: clientId!,
        revoked: false,
      });
    }
    return { status: 200, g, access, refresh };
  }

  function refreshGrant(family: Family, p: Record<string, string>, req: IncomingMessage) {
    const b = basic(req);
    const clientId = b?.id ?? p.client_id;
    if (!clientOk(family, clientId, b?.secret ?? p.client_secret)) return null;
    const r = live(p.refresh_token ?? null, family, 'refresh');
    if (!r) return null;
    const access = tok(family === 'github' ? 'ghu_' : 'ya29.');
    tokens.push({ ...r, kind: 'access', token: access, revoked: false });
    return { access, scope: r.scope };
  }

  const revokeGrant = (t: IssuedToken) => {
    for (const x of tokens) if (x.grantId === t.grantId) x.revoked = true;
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      const path = url.pathname;
      const m = req.method ?? 'GET';

      if (path === '/_state') return send(res, 200, { tokens, lastAuthorize });
      if (path === '/_reset' && m === 'POST') {
        tokens.length = 0;
        codes.clear();
        return send(res, 200, { ok: true });
      }

      /* Google: OIDC en bron-scopes */
      if (path === '/google/.well-known/openid-configuration')
        return send(res, 200, {
          issuer: `${base}/google`,
          authorization_endpoint: `${base}/google/authorize`,
          token_endpoint: `${base}/google/token`,
          userinfo_endpoint: `${base}/google/userinfo`,
          revocation_endpoint: `${base}/google/revoke`,
          jwks_uri: `${base}/google/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          scopes_supported: ['openid', 'email', 'profile'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
          claims_supported: ['sub', 'email', 'email_verified', 'name', 'hd', 'iss', 'aud', 'nonce'],
        });
      if (path === '/google/jwks') return send(res, 200, { keys: [jwk] });
      if (path === '/google/authorize') {
        if (m === 'POST') return approve('google', await body(req), res);
        return send(res, 200, authorizePage('google', url.searchParams, path));
      }
      if (path === '/google/token' && m === 'POST') {
        const p = await body(req);
        if (p.grant_type === 'refresh_token') {
          const r = refreshGrant('google', p, req);
          if (!r) return send(res, 400, { error: 'invalid_grant' });
          return send(res, 200, { access_token: r.access, expires_in: 3599, scope: r.scope, token_type: 'Bearer' });
        }
        const r = redeem('google', p, req);
        if (r.status !== 200 || !('g' in r)) return send(res, r.status, r.data);
        const openid = r.g!.scope.split(' ').includes('openid');
        return send(res, 200, {
          access_token: r.access,
          expires_in: 3599,
          token_type: 'Bearer',
          scope: r.g!.scope,
          ...(r.refresh ? { refresh_token: r.refresh } : {}),
          ...(openid ? { id_token: await idToken(r.g!) } : {}),
        });
      }
      if (path === '/google/userinfo') {
        const t = live(bearer(req), 'google');
        const a = t && accounts.find((x) => x.email === t.email);
        if (!a) return send(res, 401, { error: 'invalid_token' });
        return send(res, 200, {
          sub: a.sub,
          email: a.email,
          email_verified: a.email_verified,
          name: a.name,
          ...(a.hd ? { hd: a.hd } : {}),
        });
      }
      if (path === '/google/revoke' && m === 'POST') {
        const p = await body(req);
        const t = tokens.find((x) => x.family === 'google' && x.token === (p.token ?? url.searchParams.get('token')));
        if (!t) return send(res, 400, { error: 'invalid_token' });
        revokeGrant(t);
        return send(res, 200, {});
      }

      /* Slack */
      if (path === '/slack/authorize') {
        if (m === 'POST') return approve('slack', await body(req), res);
        return send(res, 200, authorizePage('slack', url.searchParams, path));
      }
      if (path === '/slack/oauth.v2.access' && m === 'POST') {
        const r = redeem('slack', await body(req), req);
        if (r.status !== 200 || !('g' in r)) return send(res, 200, { ok: false, error: 'invalid_code' });
        return send(res, 200, {
          ok: true,
          app_id: 'A0FAKE',
          authed_user: { id: 'U04L22BRJQ7', scope: r.g!.scope, access_token: r.access, token_type: 'user' },
          team: { id: 'T0FAKE', name: 'HomeZero (test)' },
        });
      }
      if (path === '/slack/auth.revoke') {
        const t = live(bearer(req), 'slack');
        if (!t) return send(res, 200, { ok: false, error: 'invalid_auth' });
        revokeGrant(t);
        return send(res, 200, { ok: true, revoked: true });
      }

      /* Atlassian 3LO (geen revoke-endpoint, net als echt) */
      if (path === '/atlassian/authorize') {
        if (m === 'POST') return approve('atlassian', await body(req), res);
        return send(res, 200, authorizePage('atlassian', url.searchParams, path));
      }
      if (path === '/atlassian/oauth/token' && m === 'POST') {
        const p = await body(req);
        if (p.grant_type === 'refresh_token') {
          const r = refreshGrant('atlassian', p, req);
          if (!r) return send(res, 403, { error: 'unauthorized_client' });
          return send(res, 200, { access_token: r.access, expires_in: 3600, scope: r.scope, token_type: 'Bearer' });
        }
        const r = redeem('atlassian', p, req);
        if (r.status !== 200 || !('g' in r)) return send(res, r.status, r.data);
        return send(res, 200, {
          access_token: r.access,
          refresh_token: r.refresh,
          expires_in: 3600,
          scope: r.g!.scope,
          token_type: 'Bearer',
        });
      }

      /* GitHub */
      if (path === '/github/login/oauth/authorize') {
        if (m === 'POST') return approve('github', await body(req), res);
        return send(res, 200, authorizePage('github', url.searchParams, path));
      }
      if (path === '/github/login/oauth/access_token' && m === 'POST') {
        const p = await body(req);
        if (p.grant_type === 'refresh_token') {
          const r = refreshGrant('github', p, req);
          if (!r) return send(res, 200, { error: 'bad_refresh_token' });
          return send(res, 200, { access_token: r.access, expires_in: 28800, token_type: 'bearer', scope: '' });
        }
        const r = redeem('github', p, req);
        if (r.status !== 200 || !('g' in r)) return send(res, 200, { error: 'bad_verification_code' });
        return send(res, 200, {
          access_token: r.access,
          refresh_token: r.refresh,
          expires_in: 28800,
          refresh_token_expires_in: 15811200,
          token_type: 'bearer',
          scope: '',
        });
      }
      const grant = /^\/github\/applications\/([^/]+)\/grant$/.exec(path);
      if (grant && m === 'DELETE') {
        const b = basic(req);
        if (!b || b.id !== decodeURIComponent(grant[1]!) || !clientOk('github', b.id, b.secret))
          return send(res, 401, { message: 'Bad credentials' });
        const p = await body(req);
        const t = live(p.access_token ?? null, 'github');
        if (!t) return send(res, 404, { message: 'Not Found' });
        revokeGrant(t);
        res.writeHead(204).end();
        return;
      }
      if (path === '/github/api/user') {
        const t = live(bearer(req), 'github');
        if (!t) return send(res, 401, { message: 'Bad credentials' });
        return send(res, 200, { login: t.email.split('@')[0] });
      }
      const repo = /^\/github\/api\/repos\/([^/]+)\/([^/]+)$/.exec(path);
      if (repo) {
        if (!live(bearer(req), 'github')) return send(res, 401, { message: 'Bad credentials' });
        const full = `${repo[1]}/${repo[2]}`.toLowerCase();
        return repos.has(full)
          ? send(res, 200, { full_name: full, private: true })
          : send(res, 404, { message: 'Not Found' });
      }

      return send(res, 404, { error: 'not_found', path });
    } catch (e) {
      send(res, 500, { error: 'server', message: e instanceof Error ? e.message : String(e) });
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  base = `http://${opts.host ?? '127.0.0.1'}:${addr.port}`;
  return {
    url: base,
    issuer: `${base}/google`,
    server,
    tokens,
    lastAuthorize,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
