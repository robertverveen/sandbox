/**
 * Configuratie uit omgevingsvariabelen (HZW-006). In productie weigert de app te starten zonder
 * verplichte secrets; lokaal zijn er veilige standaardwaarden en draait alles op fixtures.
 */
import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HZ_API_PORT: z.coerce.number().int().positive().default(8700),
  HZ_WEB_ORIGIN: z.string().default('http://localhost:5700'),
  /** memory (standaard) of db (Postgres met RLS). */
  HZ_STORE: z.enum(['memory', 'db']).default('memory'),
  DATABASE_URL: z.string().optional(),
  /** 32 bytes base64: hoofdsleutel voor de envelope-versleuteling van koppel-tokens. */
  HZ_TOKEN_KEY: z.string().optional(),
  /** Inloggen als vaste testgebruiker (tot het auth-stuk er is). Nooit in productie. */
  HZ_DEV_LOGIN: z.enum(['0', '1']).optional(),
  HZ_DEV_EMAIL: z.string().email().default('robert@homezero.nl'),
  HZ_ALLOWED_DOMAIN: z.string().default('homezero.nl'),
  /* ---------- Stuk E1: inloggen en koppelingen ---------- */
  /** Publieke basis-URL (redirect-URI's voor Google, Slack, Atlassian, GitHub), bv. https://homezero.verveen.me. */
  HZ_PUBLIC_URL: z.string().url().optional(),
  /** Geheim voor Auth.js (state-, PKCE- en CSRF-cookies), minimaal 32 tekens. */
  HZ_AUTH_SECRET: z.string().min(32).optional(),
  /** Eén Google OAuth-client op Intern: inloggen (OIDC) en de bronnen Taken, Agenda en Gmail. */
  HZ_GOOGLE_CLIENT_ID: z.string().optional(),
  HZ_GOOGLE_CLIENT_SECRET: z.string().optional(),
  /** Alleen buiten productie: andere OIDC-uitgever (de nep-uitgever in tests). */
  HZ_GOOGLE_ISSUER: z.string().url().optional(),
  HZ_SLACK_CLIENT_ID: z.string().optional(),
  HZ_SLACK_CLIENT_SECRET: z.string().optional(),
  HZ_ATLASSIAN_CLIENT_ID: z.string().optional(),
  HZ_ATLASSIAN_CLIENT_SECRET: z.string().optional(),
  HZ_GITHUB_CLIENT_ID: z.string().optional(),
  HZ_GITHUB_CLIENT_SECRET: z.string().optional(),
  /** Alleen buiten productie: basis-URL van de nep-autorisatieserver voor alle bronnen (packages/fake-oauth). */
  HZ_OAUTH_ENDPOINTS: z.string().url().optional(),
  /** Uitnodigingslijst uit de omgeving (komma-gescheiden), naast de tabel allowlist. */
  HZ_ALLOWLIST: z.string().default(''),
  /** Vaste beheerders (komma-gescheiden). */
  HZ_ADMIN_EMAILS: z.string().default('robert@homezero.nl'),
  /** Organisatie en naam van de contextlaag op GitHub. */
  HZ_CONTEXT_GITHUB: z.string().default('HomeZeroTech/HomeZero-context'),
});

export type Config = z.infer<typeof Env> & {
  devLogin: boolean;
  secureCookies: boolean;
  /** Google-inloggen ingericht. */
  googleLogin: boolean;
  allowlist: string[];
  adminEmails: string[];
};

export class ConfigError extends Error {
  constructor(public missing: string[]) {
    super(`Ontbrekende of ongeldige configuratie: ${missing.join(', ')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) throw new ConfigError(parsed.error.issues.map((i) => i.path.join('.')));
  const c = parsed.data;
  const prod = c.NODE_ENV === 'production';
  if (prod) {
    const missing: string[] = [];
    if (!c.DATABASE_URL) missing.push('DATABASE_URL');
    if (!c.HZ_TOKEN_KEY || Buffer.from(c.HZ_TOKEN_KEY, 'base64').length !== 32) missing.push('HZ_TOKEN_KEY');
    if (c.HZ_STORE !== 'db') missing.push('HZ_STORE=db');
    if (c.HZ_DEV_LOGIN === '1') missing.push('HZ_DEV_LOGIN mag niet aan in productie');
    if (!c.HZ_GOOGLE_CLIENT_ID || !c.HZ_GOOGLE_CLIENT_SECRET)
      missing.push('HZ_GOOGLE_CLIENT_ID/HZ_GOOGLE_CLIENT_SECRET');
    if (!c.HZ_AUTH_SECRET) missing.push('HZ_AUTH_SECRET');
    if (!c.HZ_PUBLIC_URL?.startsWith('https://')) missing.push('HZ_PUBLIC_URL (https)');
    if (c.HZ_OAUTH_ENDPOINTS) missing.push('HZ_OAUTH_ENDPOINTS mag niet in productie');
    if (c.HZ_GOOGLE_ISSUER && c.HZ_GOOGLE_ISSUER !== 'https://accounts.google.com')
      missing.push('HZ_GOOGLE_ISSUER mag in productie alleen Google zijn');
    if (missing.length) throw new ConfigError(missing);
  }
  if (c.HZ_STORE === 'db' && !c.DATABASE_URL) throw new ConfigError(['DATABASE_URL (HZ_STORE=db)']);
  if (!c.HZ_DEV_EMAIL.toLowerCase().endsWith('@' + c.HZ_ALLOWED_DOMAIN))
    throw new ConfigError(['HZ_DEV_EMAIL buiten het domein']);
  const list = (v: string) =>
    v
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
  return {
    ...c,
    devLogin: !prod && c.HZ_DEV_LOGIN !== '0',
    secureCookies: prod,
    googleLogin: !!(c.HZ_GOOGLE_CLIENT_ID && c.HZ_GOOGLE_CLIENT_SECRET),
    allowlist: list(c.HZ_ALLOWLIST),
    adminEmails: list(c.HZ_ADMIN_EMAILS),
  };
}
