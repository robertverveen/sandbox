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
  /** Login voor inloggen en sessies (alleen hz_auth, sql/auth-login.sql). Lokaal standaard DATABASE_URL. */
  HZ_AUTH_DATABASE_URL: z.string().optional(),
  /** 32 bytes base64: hoofdsleutel voor de envelope-versleuteling van koppel-tokens. */
  HZ_TOKEN_KEY: z.string().optional(),
  /** Inloggen als vaste testgebruiker (tot het auth-stuk er is). Nooit in productie. */
  HZ_DEV_LOGIN: z.enum(['0', '1']).optional(),
  HZ_DEV_EMAIL: z.string().email().default('robert@homezero.nl'),
  HZ_ALLOWED_DOMAIN: z.string().default('homezero.nl'),
});

export type Config = z.infer<typeof Env> & { devLogin: boolean; secureCookies: boolean };

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
    if (!c.HZ_AUTH_DATABASE_URL) missing.push('HZ_AUTH_DATABASE_URL');
    if (!c.HZ_TOKEN_KEY || Buffer.from(c.HZ_TOKEN_KEY, 'base64').length !== 32) missing.push('HZ_TOKEN_KEY');
    if (c.HZ_STORE !== 'db') missing.push('HZ_STORE=db');
    if (c.HZ_DEV_LOGIN === '1') missing.push('HZ_DEV_LOGIN mag niet aan in productie');
    if (missing.length) throw new ConfigError(missing);
  }
  if (c.HZ_STORE === 'db' && !c.DATABASE_URL) throw new ConfigError(['DATABASE_URL (HZ_STORE=db)']);
  if (!c.HZ_DEV_EMAIL.toLowerCase().endsWith('@' + c.HZ_ALLOWED_DOMAIN))
    throw new ConfigError(['HZ_DEV_EMAIL buiten het domein']);
  return { ...c, devLogin: !prod && c.HZ_DEV_LOGIN !== '0', secureCookies: prod };
}
