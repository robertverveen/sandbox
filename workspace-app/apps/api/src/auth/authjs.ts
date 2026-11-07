/**
 * Inloggen met Google (OpenID Connect) via Auth.js (@auth/core), HZW-010.
 *
 * Waarom Auth.js en niet Better Auth (open vraag S3): de adapter-interface van Auth.js is klein en expliciet, zodat
 * de sessies op de bestaande tabellen van het fundament blijven (users, sessions met alleen een sha256 van het
 * token) blijven. De adapter roept via AuthStore de SECURITY DEFINER-functies van stuk E2 aan (auth_session_by_token
 * en verder; packages/db/src/auth.ts), geen open SELECT op users of sessions.
 * Auth.js doet het protocol: discovery, state, PKCE en nonce, ID-token-validatie (issuer, audience, verloop) en
 * CSRF op het inlogformulier. De server beslist daarna zelf (signIn-callback): e-mail in het domein, hd-claim,
 * email_verified en de uitnodigingslijst; anders een nette weigerpagina (/login?fout=…).
 */
import { randomBytes } from 'node:crypto';
import { Auth, type AuthConfig } from '@auth/core';
import type { Adapter, AdapterUser } from '@auth/core/adapters';
import type { OIDCConfig } from '@auth/core/providers';
import type { LoginRefusal, User } from '@hz/shared';
import type { Config } from '../config';
import { checkGoogleClaims, SESSION_DAYS, type GoogleClaims } from './checks';
import type { AuthStore } from './store';

export const AUTH_BASE = '/api/auth';
/** Acties die Auth.js zelf afhandelt onder /api/auth (de rest van /api/auth zijn contractroutes). */
export const AUTHJS_ACTIONS = new Set(['signin', 'callback', 'signout', 'session', 'csrf', 'providers', 'error']);

export const isAuthjsPath = (path: string) =>
  path.startsWith(AUTH_BASE + '/') && AUTHJS_ACTIONS.has(path.slice(AUTH_BASE.length + 1).split('/')[0] ?? '');

const toAdapterUser = (u: User): AdapterUser => ({ id: u.id, email: u.email, name: u.name, emailVerified: null });

export interface LoginPolicy {
  config: Config;
  auth: AuthStore;
}

/** Mag dit Google-account inloggen? Claims eerst, dan uitnodigingslijst en blokkade. */
export async function decideLogin(p: LoginPolicy, claims: GoogleClaims): Promise<LoginRefusal | null> {
  const bad = checkGoogleClaims(claims, p.config.HZ_ALLOWED_DOMAIN);
  if (bad) return bad;
  const email = String(claims.email).toLowerCase();
  const existing = (await p.auth.userByAccount('google', String(claims.sub))) ?? (await p.auth.userByEmail(email));
  if (existing?.blocked) return 'geblokkeerd';
  const invited =
    p.config.adminEmails.includes(email) ||
    p.config.allowlist.includes(email) ||
    !!(await p.auth.allowlistLookup(email));
  return invited ? null : 'niet-uitgenodigd';
}

export async function roleFor(p: LoginPolicy, email: string): Promise<User['role']> {
  if (p.config.adminEmails.includes(email.toLowerCase())) return 'admin';
  return (await p.auth.allowlistLookup(email))?.role ?? 'member';
}

/** Per request (de adapter kent zo de user-agent voor de sessie). */
export function authjsConfig(p: LoginPolicy & { secret: string; userAgent: string }): AuthConfig {
  const { config, auth } = p;
  const google: OIDCConfig<GoogleClaims & { sub: string; email: string; name?: string }> = {
    id: 'google',
    name: 'Google',
    type: 'oidc',
    issuer: config.HZ_GOOGLE_ISSUER ?? 'https://accounts.google.com',
    clientId: config.HZ_GOOGLE_CLIENT_ID!,
    clientSecret: config.HZ_GOOGLE_CLIENT_SECRET!,
    // Alleen naam en e-mail (openid email profile); hd is een hint voor Google, de server controleert zelf.
    authorization: {
      params: { scope: 'openid email profile', hd: config.HZ_ALLOWED_DOMAIN, prompt: 'select_account' },
    },
    checks: ['pkce', 'state', 'nonce'],
    // Koppelen op e-mail is veilig: de signIn-callback eist email_verified en hd voordat er iets gekoppeld wordt.
    allowDangerousEmailAccountLinking: true,
    profile: (c) => ({
      id: c.sub,
      email: String(c.email).toLowerCase(),
      name: typeof c.name === 'string' ? c.name : String(c.email),
    }),
  };

  const adapter: Adapter = {
    async createUser(u) {
      const role = await roleFor(p, u.email);
      return toAdapterUser(await auth.createUser(u.email, u.name ?? u.email, role, { onboarding: true }));
    },
    async getUser(id) {
      const u = await auth.userById(id);
      return u ? toAdapterUser(u) : null;
    },
    async getUserByEmail(email) {
      const u = await auth.userByEmail(email);
      return u ? toAdapterUser(u) : null;
    },
    async getUserByAccount({ provider, providerAccountId }) {
      const u = await auth.userByAccount(provider, providerAccountId);
      return u ? toAdapterUser(u) : null;
    },
    async updateUser(u) {
      const cur = await auth.userById(u.id);
      if (!cur) throw new Error('Onbekende gebruiker');
      return toAdapterUser(cur);
    },
    async linkAccount(a) {
      // Geen tokens bewaren: inloggen geeft alleen identiteit. Bron-tokens komen uit de koppelingen.
      await auth.linkAccount(a.userId, a.provider, a.providerAccountId);
    },
    async createSession({ sessionToken, userId, expires }) {
      await auth.createSession(userId, sessionToken, p.userAgent, expires, 'google');
      return { sessionToken, userId, expires };
    },
    async getSessionAndUser(sessionToken) {
      const s = await auth.sessionByToken(sessionToken);
      if (!s || s.revokedAt || s.expiresAt <= new Date() || s.user.blocked) return null;
      return { session: { sessionToken, userId: s.userId, expires: s.expiresAt }, user: toAdapterUser(s.user) };
    },
    async updateSession({ sessionToken, expires }) {
      if (expires) await auth.touchSession(sessionToken, { lastSeenAt: new Date(), expiresAt: expires });
      return null;
    },
    async deleteSession(sessionToken) {
      await auth.revokeSessionByToken(sessionToken, 'signout');
    },
  };

  return {
    basePath: AUTH_BASE,
    secret: p.secret,
    trustHost: true,
    useSecureCookies: config.secureCookies,
    providers: [google],
    adapter,
    session: { strategy: 'database', maxAge: SESSION_DAYS * 86400, updateAge: 86400 },
    cookies: {
      sessionToken: {
        name: 'hz_session',
        options: { httpOnly: true, sameSite: 'lax', path: '/', secure: config.secureCookies },
      },
    },
    pages: { signIn: '/login', error: '/login', newUser: '/welkom' },
    callbacks: {
      async signIn({ profile }) {
        const refusal = await decideLogin(p, (profile ?? {}) as GoogleClaims);
        if (!refusal) return true;
        await auth.audit(null, 'login.refused', refusal);
        return `/login?fout=${refusal}`;
      },
      // Alleen terug naar een pad binnen de app.
      redirect({ url, baseUrl }) {
        if (url.startsWith('/') && !url.startsWith('//')) return `${baseUrl}${url}`;
        try {
          if (new URL(url).origin === baseUrl) return url;
        } catch {
          /* ongeldige URL: naar de start */
        }
        return baseUrl;
      },
    },
    events: {
      async signIn({ user }) {
        if (!user.id || !user.email) return;
        // Vaste beheerders (HZ_ADMIN_EMAILS) zijn altijd admin, ook als het account al bestond.
        if (config.adminEmails.includes(user.email.toLowerCase())) await auth.setRole(user.id, 'admin');
        await auth.audit(user.id, 'session.google-login');
      },
    },
    logger: {
      error: (e) => console.error(`[auth] ${e.name}: ${e.message}`),
      warn: () => {},
      debug: () => {},
    },
  };
}

/** Geheim voor Auth.js: uit de omgeving, of buiten productie een willekeurig geheim per proces. */
export const authSecret = (config: Config) => config.HZ_AUTH_SECRET ?? randomBytes(32).toString('base64url');

/** Request naar Auth.js, met de publieke basis-URL als die gezet is (redirect-URI moet bij Google kloppen). */
export async function handleAuthjs(req: Request, cfg: AuthConfig, publicUrl?: string): Promise<Response> {
  let r = req;
  if (publicUrl) {
    const u = new URL(req.url);
    const target = new URL(u.pathname + u.search, publicUrl);
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    r = new Request(target, {
      method: req.method,
      headers: req.headers,
      body: hasBody ? await req.arrayBuffer() : undefined,
    });
  }
  return Auth(r, cfg);
}
