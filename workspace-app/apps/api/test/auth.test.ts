/**
 * Stuk E1: inloggen (HZW-010), sessies (HZW-011), teamleden en rollen (HZW-012), onboarding (HZW-013) en
 * koppelingen (HZW-014). Alles tegen de nep-autorisatieserver (packages/fake-oauth), nooit echte Google/Slack.
 * Een deel draait ook tegen Postgres met RLS (database hz_e1_test_auth).
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routes, type ConnectionDetail } from '@hz/shared';
import { createProviders } from '@hz/providers';
import { startFakeOAuth, type FakeOAuth } from '@hz/fake-oauth';
import * as dbm from '@hz/db';
import { createApp, SESSION_COOKIE } from '../src/app';
import { loadConfig } from '../src/config';
import { checkGoogleClaims, deviceLabel, judgeSession, safeReturnTo, uaFamily } from '../src/auth/checks';
import type { MemoryAuthStore } from '../src/auth/store';
import { type AuthStore } from '../src/auth/store';
import { DbStore, MemoryStore, type AppStore } from '../src/store';

const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const CHROME_MAC_NEW = CHROME_MAC.replace('130.0.0.0', '131.0.6778.86');
const FIREFOX_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0';
const SAFARI_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';

let fake: FakeOAuth;
beforeAll(async () => {
  fake = await startFakeOAuth({ githubRepos: ['homezerotech/persoonlijk-robert'] });
});
afterAll(async () => {
  await fake.close();
});

/** Kleine cookie-jar per "browser" (user-agent), zodat we meerdere apparaten kunnen nadoen. */
class Browser {
  jar = new Map<string, string>();
  constructor(
    readonly app: ReturnType<typeof createApp>['app'],
    readonly ua = CHROME_MAC,
  ) {}
  cookieHeader() {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  absorb(res: Response) {
    for (const sc of res.headers.getSetCookie()) {
      const [kv] = sc.split(';');
      const i = kv!.indexOf('=');
      const k = kv!.slice(0, i);
      const v = kv!.slice(i + 1);
      if (!v || /expires=Thu, 01 Jan 1970/i.test(sc) || /max-age=0/i.test(sc)) this.jar.delete(k);
      else this.jar.set(k, v);
    }
    return res;
  }
  async req(method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
    const isForm = body instanceof URLSearchParams;
    const res = await this.app.request(path, {
      method,
      headers: {
        'user-agent': this.ua,
        ...(body !== undefined
          ? { 'content-type': isForm ? 'application/x-www-form-urlencoded' : 'application/json' }
          : {}),
        ...(this.jar.size ? { cookie: this.cookieHeader() } : {}),
        ...extra,
      },
      body: body === undefined ? undefined : isForm ? body.toString() : JSON.stringify(body),
    });
    return this.absorb(res);
  }
  get session() {
    return this.jar.get(SESSION_COOKIE);
  }
}

function setup(env: Record<string, string> = {}, opts: { store?: AppStore; secure?: boolean } = {}) {
  const config = loadConfig({
    NODE_ENV: 'test',
    HZ_GOOGLE_CLIENT_ID: 'workspace-test.apps.googleusercontent.com',
    HZ_GOOGLE_CLIENT_SECRET: 'test-geheim-google',
    HZ_GOOGLE_ISSUER: fake.issuer,
    HZ_AUTH_SECRET: 'x'.repeat(40),
    HZ_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'),
    HZ_OAUTH_ENDPOINTS: fake.url,
    HZ_SLACK_CLIENT_ID: 'slack-test',
    HZ_SLACK_CLIENT_SECRET: 'slack-geheim',
    HZ_ATLASSIAN_CLIENT_ID: 'atl-test',
    HZ_ATLASSIAN_CLIENT_SECRET: 'atl-geheim',
    HZ_GITHUB_CLIENT_ID: 'gh-test',
    HZ_GITHUB_CLIENT_SECRET: 'gh-geheim',
    HZ_ALLOWLIST: 'lisanne@homezero.nl',
    ...env,
  });
  if (opts.secure) config.secureCookies = true;
  const bundle = createProviders({});
  const store = opts.store ?? new MemoryStore(bundle.dataset);
  const { app, auth, connections } = createApp({ config, bundle, store, ssePingMs: 50 });
  return { app, auth, store, bundle, config, connections, browser: (ua?: string) => new Browser(app, ua) };
}

/** De volledige Google-inlogflow: CSRF, signin, accountkiezer bij de nep-uitgever, callback. */
async function googleLogin(b: Browser, account: string) {
  const csrf = (await (await b.req('GET', '/api/auth/csrf')).json()) as { csrfToken: string };
  const start = await b.req(
    'POST',
    '/api/auth/signin/google',
    new URLSearchParams({ csrfToken: csrf.csrfToken, callbackUrl: '/dagstart' }),
  );
  expect(start.status, await start.clone().text()).toBe(302);
  const authorize = new URL(start.headers.get('location')!);
  expect(authorize.origin + authorize.pathname).toBe(`${fake.url}/google/authorize`);
  // De gebruiker kiest een account op het scherm van de uitgever.
  const chosen = await fetch(authorize.origin + authorize.pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...Object.fromEntries(authorize.searchParams), account }).toString(),
    redirect: 'manual',
  });
  expect(chosen.status).toBe(302);
  const cb = new URL(chosen.headers.get('location')!);
  const done = await b.req('GET', cb.pathname + cb.search);
  const loc = done.headers.get('location') ?? '';
  // Auth.js maakt het adres absoluut; voor de vergelijking telt het pad met de query.
  const location = loc.startsWith('http') ? new URL(loc).pathname + new URL(loc).search : loc;
  return { authorize, done, location };
}

describe('HZW-010 inloggen met Google (nep-OIDC)', () => {
  it('pure servercontrole: domein, hd en email_verified', () => {
    const ok = { sub: '1', email: 'Robert@HomeZero.nl', email_verified: true, hd: 'homezero.nl' };
    expect(checkGoogleClaims(ok, 'homezero.nl')).toBeNull();
    expect(checkGoogleClaims({ ...ok, email: 'iemand@gmail.com', hd: undefined }, 'homezero.nl')).toBe('domein');
    expect(checkGoogleClaims({ ...ok, hd: undefined }, 'homezero.nl')).toBe('domein');
    expect(checkGoogleClaims({ ...ok, hd: 'anders.nl' }, 'homezero.nl')).toBe('domein');
    expect(checkGoogleClaims({ ...ok, email: 'x@homezero.nl.evil.com' }, 'homezero.nl')).toBe('domein');
    expect(checkGoogleClaims({ ...ok, email_verified: false }, 'homezero.nl')).toBe('ongeverifieerd');
    expect(checkGoogleClaims({ ...ok, email_verified: undefined }, 'homezero.nl')).toBe('ongeverifieerd');
    expect(checkGoogleClaims({ ...ok, email_verified: 'true' }, 'homezero.nl')).toBeNull();
  });

  it('@homezero.nl mag: sessie in de opslag, cookie HttpOnly en SameSite=Lax, alleen naam en e-mail gevraagd', async () => {
    const { browser, auth } = setup();
    const b = browser();
    const { authorize, done, location } = await googleLogin(b, 'robert');
    // Wat Google krijgt: alleen naam en e-mail, hd als hint, PKCE, state en nonce.
    expect(authorize.searchParams.get('scope')).toBe('openid email profile');
    expect(authorize.searchParams.get('hd')).toBe('homezero.nl');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('state')).toBeTruthy();
    expect(authorize.searchParams.get('nonce')).toBeTruthy();
    expect(done.status).toBe(302);
    // Eerste login: naar de onboarding.
    expect(location).toContain('/welkom');
    const sc = done.headers.getSetCookie().find((c) => c.startsWith(SESSION_COOKIE + '='))!;
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Lax/i);
    expect(sc).toMatch(/Path=\//);
    const s = routes.session.response.parse(await (await b.req('GET', '/api/session')).json());
    expect(s.user).toMatchObject({ email: 'robert@homezero.nl', name: 'Robert Verveen', role: 'admin' });
    const stored = await auth.sessionByToken(b.session!);
    expect(stored?.userAgent).toBe(CHROME_MAC);
    expect((auth as MemoryAuthStore).auditLog.map((a) => a.action)).toEqual(
      expect.arrayContaining(['user.created', 'session.created', 'session.google-login']),
    );
  });

  it('in productie is de sessiecookie ook Secure', async () => {
    const { browser } = setup({}, { secure: true });
    const b = browser();
    const { done } = await googleLogin(b, 'robert');
    const sc = done.headers.getSetCookie().find((c) => c.startsWith(SESSION_COOKIE + '='))!;
    expect(sc).toMatch(/Secure/);
    expect(sc).toMatch(/HttpOnly/i);
  });

  for (const [account, reason] of [
    ['prive', 'domein'],
    ['onbevestigd', 'ongeverifieerd'],
    ['valshd', 'domein'],
    ['gast', 'niet-uitgenodigd'],
  ] as const) {
    it(`${account} wordt geweigerd met een nette weigerpagina (${reason}) en krijgt geen sessie`, async () => {
      const { browser, auth } = setup();
      const b = browser();
      const { done, location } = await googleLogin(b, account);
      expect(done.status).toBe(302);
      expect(location).toBe(`/login?fout=${reason}`);
      expect(b.session).toBeUndefined();
      expect((await b.req('GET', '/api/session')).status).toBe(401);
      expect(
        await auth.userByEmail(account === 'prive' ? 'robert.prive@example.com' : `${account}@homezero.nl`),
      ).toBeNull();
      expect((auth as MemoryAuthStore).auditLog.find((a) => a.action === 'login.refused')?.target).toBe(reason);
    });
  }

  it('teamlid van de uitnodigingslijst (omgeving) mag; tweede login gaat niet meer naar de onboarding', async () => {
    const { browser } = setup();
    const first = await googleLogin(browser(), 'lisanne');
    expect(first.location).toContain('/welkom');
    const b = browser();
    const again = await googleLogin(b, 'lisanne');
    expect(again.location).toMatch(/\/dagstart$/);
    const s = routes.session.response.parse(await (await b.req('GET', '/api/session')).json());
    expect(s.user).toMatchObject({ email: 'lisanne@homezero.nl', role: 'member' });
  });

  it('authConfig vertelt de web-app welke inlogmanieren er zijn; zonder Google geen Auth.js-routes', async () => {
    const on = setup();
    expect(await (await on.browser().req('GET', '/api/auth/config')).json()).toEqual({
      google: true,
      devLogin: true,
      domain: 'homezero.nl',
    });
    const off = setup({ HZ_GOOGLE_CLIENT_ID: '', HZ_GOOGLE_CLIENT_SECRET: '', HZ_DEV_LOGIN: '0' });
    expect(await (await off.browser().req('GET', '/api/auth/config')).json()).toMatchObject({
      google: false,
      devLogin: false,
    });
    expect((await off.browser().req('GET', '/api/auth/csrf')).status).toBe(404);
  });

  it('verzoeken van een andere site worden geweigerd (Origin-controle naast SameSite=Lax)', async () => {
    const { browser } = setup();
    const b = browser();
    await b.req('POST', '/api/auth/dev-login', {});
    const evil = await b.req('POST', '/api/auth/logout-all', undefined, { origin: 'https://kwaadwillend.example' });
    expect(evil.status).toBe(403);
    expect((await b.req('GET', '/api/session')).status).toBe(200);
    const own = await b.req('POST', '/api/auth/logout', undefined, { origin: 'http://localhost', host: 'localhost' });
    expect(own.status).toBe(200);
  });

  it('dev-login is uit in productie en weigert een geblokkeerd account', async () => {
    const prod = loadConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://x',
      HZ_STORE: 'db',
      HZ_AUTH_DATABASE_URL: 'postgres://y',
      HZ_TOKEN_KEY: Buffer.alloc(32, 1).toString('base64'),
      HZ_GOOGLE_CLIENT_ID: 'x.apps.googleusercontent.com',
      HZ_GOOGLE_CLIENT_SECRET: 'g',
      HZ_AUTH_SECRET: 'a'.repeat(32),
      HZ_PUBLIC_URL: 'https://homezero.verveen.me',
    });
    expect(prod.devLogin).toBe(false);
    expect(() =>
      loadConfig({ ...prod, NODE_ENV: 'production', HZ_OAUTH_ENDPOINTS: 'http://127.0.0.1:1' } as never),
    ).toThrow(/HZ_OAUTH_ENDPOINTS/);
    // In development: een geblokkeerde collega komt ook via de dev-login niet binnen (403, geen sessie).
    const { browser } = setup();
    const robert = browser();
    await robert.req('POST', '/api/auth/dev-login', {});
    const lisanne = browser(SAFARI_IOS);
    await lisanne.req('POST', '/api/auth/dev-login', { email: 'lisanne@homezero.nl' });
    const lid = routes.session.response.parse(await (await lisanne.req('GET', '/api/session')).json()).user.id;
    expect((await robert.req('POST', `/api/admin/members/${lid}/block`, { blocked: true })).status).toBe(200);
    const again = browser(SAFARI_IOS);
    const refused = await again.req('POST', '/api/auth/dev-login', { email: 'lisanne@homezero.nl' });
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('Geblokkeerd');
    expect(again.session).toBeUndefined();
    expect((await again.req('GET', '/api/session')).status).toBe(401);
  });
});

describe('HZW-011 sessies: verlopen, ingetrokken, gestolen, verlengen, uitloggen overal', () => {
  const login = async (b: Browser) => expect((await b.req('POST', '/api/auth/dev-login', {})).status).toBe(200);

  it('pure regels: browserupdate houdt je ingelogd, ander apparaat niet', () => {
    expect(uaFamily(CHROME_MAC)).toBe('chrome|macos');
    expect(uaFamily(CHROME_MAC_NEW)).toBe(uaFamily(CHROME_MAC));
    expect(uaFamily(FIREFOX_WIN)).toBe('firefox|windows');
    expect(uaFamily(SAFARI_IOS)).toBe('safari|ios');
    expect(deviceLabel(SAFARI_IOS)).toBe('Safari op iOS');
    const now = new Date('2026-11-07T10:00:00Z');
    const base = { revokedAt: null, lastSeenAt: now, userAgent: CHROME_MAC, blocked: false };
    expect(judgeSession({ ...base, expiresAt: new Date(+now - 1) }, CHROME_MAC, now)).toEqual({
      ok: false,
      reason: 'verlopen',
    });
    expect(judgeSession({ ...base, expiresAt: new Date(+now + 864e5), revokedAt: now }, CHROME_MAC, now)).toMatchObject(
      {
        reason: 'ingetrokken',
      },
    );
    expect(judgeSession({ ...base, expiresAt: new Date(+now + 864e5) }, FIREFOX_WIN, now)).toMatchObject({
      reason: 'ander-apparaat',
    });
    const renew = judgeSession({ ...base, expiresAt: new Date(+now + 20 * 864e5) }, CHROME_MAC_NEW, now);
    expect(renew).toMatchObject({ ok: true });
    expect(renew.ok && renew.renewTo?.toISOString()).toBe(new Date(+now + 30 * 864e5).toISOString());
    expect(safeReturnTo('//evil.example/x')).toBe('/');
    expect(safeReturnTo('/welkom?stap=slack')).toBe('/welkom?stap=slack');
  });

  it('verlopen sessie: 401 en de cookie wordt gewist', async () => {
    const { browser, auth } = setup();
    const b = browser();
    await login(b);
    await auth.touchSession(b.session!, { lastSeenAt: new Date(), expiresAt: new Date(Date.now() - 1000) });
    const r = await b.req('GET', '/api/session');
    expect(r.status).toBe(401);
    expect(b.session).toBeUndefined();
  });

  it('ingetrokken sessie: uitloggen, of één apparaat uitloggen vanaf een ander', async () => {
    const { browser } = setup();
    const laptop = browser(CHROME_MAC);
    const phone = browser(SAFARI_IOS);
    await login(laptop);
    await login(phone);
    const list = routes.sessions.response.parse(await (await laptop.req('GET', '/api/auth/sessions')).json());
    expect(list.sessions).toHaveLength(2);
    expect(list.sessions.find((s) => s.current)?.device).toBe('Chrome op macOS');
    const phoneRow = list.sessions.find((s) => s.device === 'Safari op iOS')!;
    expect((await laptop.req('DELETE', `/api/auth/sessions/${phoneRow.id}`)).status).toBe(200);
    expect((await phone.req('GET', '/api/session')).status).toBe(401);
    expect((await laptop.req('GET', '/api/session')).status).toBe(200);
    expect((await laptop.req('POST', '/api/auth/logout')).status).toBe(200);
    expect((await laptop.req('GET', '/api/session')).status).toBe(401);
  });

  it('gestolen sessie (andere user-agent): 401, sessie ingetrokken, ook de echte eigenaar moet opnieuw inloggen', async () => {
    const { browser, auth } = setup();
    const owner = browser(CHROME_MAC);
    await login(owner);
    const thief = browser(FIREFOX_WIN);
    thief.jar.set(SESSION_COOKIE, owner.session!);
    const r = await thief.req('GET', '/api/session');
    expect(r.status).toBe(401);
    expect(((await r.json()) as { message: string }).message).toContain('ander apparaat');
    expect((await owner.req('GET', '/api/session')).status).toBe(401);
    expect((auth as MemoryAuthStore).auditLog.map((a) => a.action)).toContain('session.stolen');
  });

  it('browserupdate (zelfde browser en systeem) houdt de sessie geldig', async () => {
    const { browser, app } = setup();
    const b = browser(CHROME_MAC);
    await login(b);
    const updated = new Browser(app, CHROME_MAC_NEW);
    updated.jar = b.jar;
    expect((await updated.req('GET', '/api/session')).status).toBe(200);
  });

  it('30 dagen met verlenging: na een dag krijgt de cookie een nieuwe vervaldatum', async () => {
    const { browser, auth } = setup();
    const b = browser();
    await login(b);
    const in20 = new Date(Date.now() + 20 * 864e5);
    await auth.touchSession(b.session!, { lastSeenAt: new Date(Date.now() - 10 * 864e5), expiresAt: in20 });
    const r = await b.req('GET', '/api/session');
    expect(r.status).toBe(200);
    const sc = r.headers.getSetCookie().find((c) => c.startsWith(SESSION_COOKIE + '='))!;
    const exp = new Date(/Expires=([^;]+)/i.exec(sc)![1]!);
    expect(+exp - Date.now()).toBeGreaterThan(29.9 * 864e5);
    const s = await auth.sessionByToken(b.session!);
    expect(+s!.expiresAt - Date.now()).toBeGreaterThan(29.9 * 864e5);
    // Binnen een dag niet nog eens.
    const again = await b.req('GET', '/api/session');
    expect(again.headers.getSetCookie().some((c) => c.startsWith(SESSION_COOKIE + '='))).toBe(false);
  });

  it('uitloggen overal trekt alle sessies van die collega in, niet die van anderen', async () => {
    const { browser } = setup();
    const a1 = browser(CHROME_MAC);
    const a2 = browser(SAFARI_IOS);
    const other = browser(CHROME_MAC);
    await login(a1);
    await login(a2);
    expect((await other.req('POST', '/api/auth/dev-login', { email: 'lisanne@homezero.nl' })).status).toBe(200);
    const r = routes.logoutAll.response.parse(await (await a1.req('POST', '/api/auth/logout-all')).json());
    expect(r.revoked).toBe(2);
    expect((await a1.req('GET', '/api/session')).status).toBe(401);
    expect((await a2.req('GET', '/api/session')).status).toBe(401);
    expect((await other.req('GET', '/api/session')).status).toBe(200);
  });
});

describe('HZW-012 teamleden en rollen', () => {
  it('eerste login maakt het profiel; Robert is admin, een collega member; member kan niet bij adminroutes', async () => {
    const { browser } = setup();
    const robert = browser();
    await googleLogin(robert, 'robert');
    const lisanne = browser(SAFARI_IOS);
    await googleLogin(lisanne, 'lisanne');
    const me = routes.session.response.parse(await (await lisanne.req('GET', '/api/session')).json());
    expect(me.user.role).toBe('member');
    for (const [m, p, body] of [
      ['GET', '/api/admin/members', undefined],
      ['POST', `/api/admin/members/${me.user.id}/block`, { blocked: true }],
      ['POST', '/api/admin/allowlist', { email: 'nieuw@homezero.nl' }],
      ['DELETE', '/api/admin/allowlist/lisanne@homezero.nl', undefined],
    ] as const) {
      const r = await lisanne.req(m, p, body);
      expect(r.status, `${m} ${p}`).toBe(403);
    }
    const list = routes.members.response.parse(await (await robert.req('GET', '/api/admin/members')).json());
    expect(list.members.map((x) => [x.email, x.role, x.activeSessions])).toEqual([
      ['robert@homezero.nl', 'admin', 1],
      ['lisanne@homezero.nl', 'member', 1],
    ]);
    expect(list.members[1]!.lastSeenAt).toBeTruthy();
  });

  it('admin blokkeert iemand: sessies meteen weg en opnieuw inloggen wordt geweigerd; weer toelaten kan', async () => {
    const { browser } = setup();
    const robert = browser();
    await googleLogin(robert, 'robert');
    const lisanne = browser(SAFARI_IOS);
    await googleLogin(lisanne, 'lisanne');
    const id = routes.session.response.parse(await (await lisanne.req('GET', '/api/session')).json()).user.id;
    const blocked = routes.blockMember.response.parse(
      await (await robert.req('POST', `/api/admin/members/${id}/block`, { blocked: true })).json(),
    );
    expect(blocked).toMatchObject({ blocked: true, activeSessions: 0 });
    expect((await lisanne.req('GET', '/api/session')).status).toBe(401);
    const retry = await googleLogin(browser(SAFARI_IOS), 'lisanne');
    expect(retry.location).toBe('/login?fout=geblokkeerd');
    await robert.req('POST', `/api/admin/members/${id}/block`, { blocked: false });
    const ok = browser(SAFARI_IOS);
    await googleLogin(ok, 'lisanne');
    expect((await ok.req('GET', '/api/session')).status).toBe(200);
    const self = routes.session.response.parse(await (await robert.req('GET', '/api/session')).json()).user.id;
    expect((await robert.req('POST', `/api/admin/members/${self}/block`, { blocked: true })).status).toBe(400);
  });

  it('uitnodigingslijst: admin voegt een collega toe, alleen @homezero.nl; daarna mag die inloggen', async () => {
    const { browser } = setup();
    const robert = browser();
    await googleLogin(robert, 'robert');
    expect((await robert.req('POST', '/api/admin/allowlist', { email: 'iemand@gmail.com' })).status).toBe(422);
    const before = await googleLogin(browser(), 'gast');
    expect(before.location).toBe('/login?fout=niet-uitgenodigd');
    const added = await robert.req('POST', '/api/admin/allowlist', { email: 'Gast@HomeZero.nl' });
    expect(routes.addAllowlist.response.parse(await added.json())).toMatchObject({
      email: 'gast@homezero.nl',
      role: 'member',
    });
    const g = browser();
    const after = await googleLogin(g, 'gast');
    expect(after.location).toContain('/welkom');
    expect((await robert.req('DELETE', '/api/admin/allowlist/gast@homezero.nl')).status).toBe(200);
    const removed = await googleLogin(browser(), 'gast');
    expect(removed.location).toBe('/login?fout=niet-uitgenodigd');
  });
});

describe('HZW-013 onboarding (API)', () => {
  it('stand bewaren: stap, overslaan, later afmaken en hervatten, weekritme met standaarden, klaar', async () => {
    const { browser } = setup();
    const b = browser();
    await googleLogin(b, 'lisanne');
    let s = routes.onboarding.response.parse(await (await b.req('GET', '/api/onboarding')).json());
    expect(s).toMatchObject({ status: 'new', step: 'welkom' });
    s = routes.updateOnboarding.response.parse(
      await (await b.req('PATCH', '/api/onboarding', { mark: { step: 'welkom', as: 'done' }, step: 'google' })).json(),
    );
    expect(s).toMatchObject({ status: 'busy', step: 'google', steps: { welkom: 'done' } });
    s = routes.updateOnboarding.response.parse(
      await (
        await b.req('PATCH', '/api/onboarding', {
          mark: { step: 'google', as: 'skipped' },
          step: 'slack',
          status: 'later',
        })
      ).json(),
    );
    expect(s).toMatchObject({ status: 'later', step: 'slack', steps: { google: 'skipped' } });
    // Hervatten: dezelfde stap terug.
    s = routes.onboarding.response.parse(await (await b.req('GET', '/api/onboarding')).json());
    expect(s.step).toBe('slack');
    s = routes.updateOnboarding.response.parse(
      await (await b.req('PATCH', '/api/onboarding', { weekritme: { plansessieDag: 'di' } })).json(),
    );
    expect(s.weekritme).toEqual({
      plansessieDag: 'di',
      plansessieTijd: '08:30',
      weekprep: true,
      dagafsluiting: '17:00',
      weekdoelen: 3,
    });
    expect((await b.req('PATCH', '/api/onboarding', { persRepo: 'geen repo' })).status).toBe(400);
    s = routes.updateOnboarding.response.parse(
      await (await b.req('PATCH', '/api/onboarding', { status: 'done' })).json(),
    );
    expect(s.status).toBe('done');
    expect(s.completedAt).toBeTruthy();
  });

  it('dev-login heeft geen onboarding (status none), zodat andere schermen niet omleiden', async () => {
    const { browser } = setup();
    const b = browser();
    await b.req('POST', '/api/auth/dev-login', {});
    expect(routes.onboarding.response.parse(await (await b.req('GET', '/api/onboarding')).json()).status).toBe('none');
  });
});

/** Koppelen via de nep-autorisatieserver: connect, toestemming, callback. */
async function connect(
  b: Browser,
  provider: string,
  decision: 'allow' | 'deny' = 'allow',
  returnTo = '/welkom?stap=slack',
) {
  const r = await b.req('POST', `/api/connections/${provider}/connect`, { returnTo });
  expect(r.status, await r.clone().text()).toBe(200);
  const { redirect } = routes.connect.response.parse(await r.json());
  const authorize = new URL(redirect!);
  const consent = await fetch(authorize.origin + authorize.pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      ...Object.fromEntries(authorize.searchParams),
      account: 'robert',
      decision,
    }).toString(),
    redirect: 'manual',
  });
  const cb = new URL(consent.headers.get('location')!);
  const done = await b.req('GET', cb.pathname + cb.search);
  return { authorize, done, location: done.headers.get('location') ?? '' };
}

const details = async (b: Browser) =>
  routes.connectionDetails.response.parse(await (await b.req('GET', '/api/connections/details')).json()).connections;
const detail = async (b: Browser, p: string) => (await details(b)).find((c) => c.provider === p) as ConnectionDetail;

describe('HZW-014 koppelingen: verbinden, intrekken (token weg, data weg), opnieuw verbinden', () => {
  it('Slack: user-scopes, token versleuteld opgeslagen en nooit naar de browser; intrekken in Slack en data weg; opnieuw verbinden', async () => {
    const { browser, auth, store } = setup();
    const b = browser();
    await googleLogin(b, 'robert');
    const uid = routes.session.response.parse(await (await b.req('GET', '/api/session')).json()).user.id;
    expect((await detail(b, 'slack')).status).toBe('disconnected');

    const { authorize, location } = await connect(b, 'slack');
    expect(authorize.pathname).toBe('/slack/authorize');
    expect(authorize.searchParams.get('user_scope')).toContain('channels:write');
    expect(authorize.searchParams.get('user_scope')).toContain('search:read');
    expect(location).toBe('/welkom?stap=slack&gekoppeld=slack');
    const slack = await detail(b, 'slack');
    expect(slack).toMatchObject({ status: 'connected', account: 'HomeZero (test)', oauth: true });
    const issued = fake.tokens.filter((t) => t.family === 'slack' && t.kind === 'access' && !t.revoked).at(-1)!;
    // Versleuteld: het bewaarde token bevat het access token niet; ontsleutelen kan alleen de server.
    const sealed = (auth as MemoryAuthStore).sealedFor(uid, 'slack')!;
    expect(JSON.stringify(sealed)).not.toContain(issued.token);
    expect(JSON.parse((await auth.readSecret(uid, 'slack'))!).access_token).toBe(issued.token);
    // Nergens in een antwoord naar de browser.
    for (const path of ['/api/connections', '/api/connections/details', '/api/dagstart'])
      expect(await (await b.req('GET', path)).text()).not.toContain(issued.token);

    // Eigen data van Slack: leesstatus van een Slack-item en een gesprek.
    await b.req('PUT', '/api/itemstate/s1', { read: true });
    await b.req('PUT', '/api/itemstate/sl:CDEMOFEEN', { read: true });
    await b.req('PUT', '/api/itemstate/e5', { read: true });
    const before = routes.dagstart.response.parse(await (await b.req('GET', '/api/dagstart')).json());
    expect(before.items.some((i) => i.type === 'slack')).toBe(true);

    const off = routes.disconnect.response.parse(await (await b.req('DELETE', '/api/connections/slack')).json());
    expect(off).toMatchObject({ ok: true, revokedAtProvider: true });
    expect(off.wiped).toBeGreaterThanOrEqual(2);
    expect(fake.tokens.find((t) => t.token === issued.token)!.revoked).toBe(true);
    expect(await auth.readSecret(uid, 'slack')).toBeNull();
    expect((await detail(b, 'slack')).status).toBe('disconnected');
    const states = await store.itemStates(uid);
    expect(states['s1']).toBeUndefined();
    expect(states['sl:CDEMOFEEN']).toBeUndefined();
    expect(states['e5']?.read).toBe(true); // andere bronnen (mail) blijven
    const after = routes.dagstart.response.parse(await (await b.req('GET', '/api/dagstart')).json());
    expect(after.items.some((i) => i.type === 'slack')).toBe(false);

    // Opnieuw verbinden: nieuw token, items terug.
    await connect(b, 'slack', 'allow', '/instellingen/koppelingen');
    expect((await detail(b, 'slack')).status).toBe('connected');
    const again = fake.tokens.filter((t) => t.family === 'slack' && t.kind === 'access' && !t.revoked).at(-1)!;
    expect(again.token).not.toBe(issued.token);
    expect(JSON.parse((await auth.readSecret(uid, 'slack'))!).access_token).toBe(again.token);
    const back = routes.dagstart.response.parse(await (await b.req('GET', '/api/dagstart')).json());
    expect(back.items.some((i) => i.type === 'slack')).toBe(true);
  });

  it('Google Taken: PKCE, eigen toestemming per bron, verversen, en "opnieuw verbinden" als Google het token intrekt', async () => {
    const { browser, auth, connections } = setup();
    const b = browser();
    await googleLogin(b, 'robert');
    const uid = routes.session.response.parse(await (await b.req('GET', '/api/session')).json()).user.id;
    const { authorize } = await connect(b, 'google_tasks');
    expect(authorize.pathname).toBe('/google/authorize');
    expect(authorize.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/tasks');
    expect(authorize.searchParams.get('access_type')).toBe('offline');
    expect(authorize.searchParams.get('login_hint')).toBe('robert@homezero.nl');
    expect(authorize.searchParams.get('include_granted_scopes')).toBeNull();
    expect(authorize.searchParams.get('code_challenge')).toBeTruthy();
    const t = JSON.parse((await auth.readSecret(uid, 'google_tasks'))!) as {
      access_token: string;
      refresh_token: string;
      expires_at: number;
    };
    expect(t.refresh_token).toBeTruthy();
    // Nog geldig: hetzelfde token.
    expect(await connections.accessToken(uid, 'google_tasks')).toBe(t.access_token);
    // Bijna verlopen: verversen.
    const fresh = await connections.accessToken(uid, 'google_tasks', t.expires_at);
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(t.access_token);
    // Google trekt de toestemming in (bv. via myaccount): verversen faalt -> opnieuw verbinden.
    await fetch(`${fake.url}/google/revoke`, { method: 'POST', body: new URLSearchParams({ token: t.refresh_token }) });
    const t2 = JSON.parse((await auth.readSecret(uid, 'google_tasks'))!) as { expires_at: number };
    expect(await connections.accessToken(uid, 'google_tasks', t2.expires_at)).toBeNull();
    expect(await detail(b, 'google_tasks')).toMatchObject({ status: 'needs_reauth' });
  });

  it('nieuwe collega zonder koppelingen ziet geen items van bronnen met een OAuth-flow; na koppelen wel', async () => {
    const { browser } = setup();
    const b = browser();
    await googleLogin(b, 'lisanne');
    const all = await details(b);
    for (const p of ['google_tasks', 'calendar', 'gmail', 'slack', 'jira', 'github'] as const)
      expect(all.find((c) => c.provider === p)).toMatchObject({ status: 'disconnected', oauth: true });
    const dag = routes.dagstart.response.parse(await (await b.req('GET', '/api/dagstart')).json());
    const types = new Set(dag.items.map((i) => i.type));
    for (const t of ['task', 'mail', 'meeting', 'slack', 'jira']) expect(types.has(t as never), t).toBe(false);
    expect(dag.sprint.issues).toEqual([]);
    expect(dag.context.pers).toBeNull();
    const agenda = routes.agenda.response.parse(await (await b.req('GET', '/api/agenda')).json());
    expect(agenda.events).toEqual([]);
    expect(agenda.calendars).toEqual([]);
    const tasks = routes.tasks.response.parse(await (await b.req('GET', '/api/tasks')).json());
    expect(tasks.tasks).toEqual([]);
    const tracker = routes.tracker.response.parse(await (await b.req('GET', '/api/tracker')).json());
    expect(tracker).toMatchObject({ hasPersRepo: false, taken: [] });
    const convs = routes.conversations.response.parse(await (await b.req('GET', '/api/conversations')).json());
    expect(convs.conversations).toEqual([]);
    expect((await b.req('GET', '/api/conversations/sl:CDEMOFEEN')).status).toBe(409);
    expect((await b.req('POST', '/api/tasks', { title: 'Nieuwe taak' })).status).toBe(409);
    // Alleen Google Taken koppelen: taken verschijnen, de rest blijft leeg.
    await connect(b, 'google_tasks', 'allow', '/welkom?stap=google');
    const after = routes.dagstart.response.parse(await (await b.req('GET', '/api/dagstart')).json());
    expect(after.items.some((i) => i.type === 'task')).toBe(true);
    expect(after.items.some((i) => i.type === 'mail' || i.type === 'slack' || i.type === 'jira')).toBe(false);
  });

  it('Google deelt één client: Gmail intrekken laat Taken werken; de laatste Google-bron trekt de app echt in', async () => {
    const { browser, auth, connections } = setup();
    const b = browser();
    await googleLogin(b, 'robert');
    const uid = routes.session.response.parse(await (await b.req('GET', '/api/session')).json()).user.id;
    await connect(b, 'google_tasks');
    await connect(b, 'gmail');
    const tasksTok = JSON.parse((await auth.readSecret(uid, 'google_tasks'))!) as {
      refresh_token: string;
      expires_at: number;
    };
    const gmailTok = JSON.parse((await auth.readSecret(uid, 'gmail'))!) as { refresh_token: string };
    const off = routes.disconnect.response.parse(await (await b.req('DELETE', '/api/connections/gmail')).json());
    // Niet bij Google ingetrokken (dat zou Taken ook raken), wel gewist, met uitleg.
    expect(off).toMatchObject({ ok: true, revokedAtProvider: false, keptFor: ['google_tasks'] });
    expect(off.note).toContain('Taken blijft werken');
    expect(await auth.readSecret(uid, 'gmail')).toBeNull();
    expect((await detail(b, 'gmail')).status).toBe('disconnected');
    // Taken werkt nog: status gekoppeld en verversen bij Google lukt.
    expect((await detail(b, 'google_tasks')).status).toBe('connected');
    expect(fake.tokens.find((t) => t.token === tasksTok.refresh_token)!.revoked).toBe(false);
    expect(await connections.accessToken(uid, 'google_tasks', tasksTok.expires_at)).toBeTruthy();
    const dag = routes.dagstart.response.parse(await (await b.req('GET', '/api/dagstart')).json());
    expect(dag.items.some((i) => i.type === 'task')).toBe(true);
    expect(dag.items.some((i) => i.type === 'mail')).toBe(false);
    // Laatste Google-bron: nu wel intrekken, en Google haalt alle tokens van de app weg (ook het oude Gmail-token).
    const last = routes.disconnect.response.parse(
      await (await b.req('DELETE', '/api/connections/google_tasks')).json(),
    );
    expect(last.revokedAtProvider).toBe(true);
    expect(last.keptFor).toBeUndefined();
    const robertGoogle = fake.tokens.filter(
      (t) =>
        t.family === 'google' &&
        t.email === 'robert@homezero.nl' &&
        t.clientId === 'workspace-test.apps.googleusercontent.com' &&
        !t.scope.includes('openid'),
    );
    expect(robertGoogle.find((t) => t.token === gmailTok.refresh_token)!.revoked).toBe(true);
    expect(robertGoogle.every((t) => t.revoked)).toBe(true);
  });

  it('Google intrekken met een Google-bron die al niet meer werkte: die vraagt meteen "Opnieuw verbinden"', async () => {
    const { browser, auth } = setup();
    const b = browser();
    await googleLogin(b, 'robert');
    const uid = routes.session.response.parse(await (await b.req('GET', '/api/session')).json()).user.id;
    await connect(b, 'google_tasks');
    await connect(b, 'calendar');
    await auth.setConnectionError(uid, 'google_tasks', 'error', 'tijdelijke fout');
    const off = routes.disconnect.response.parse(await (await b.req('DELETE', '/api/connections/calendar')).json());
    expect(off).toMatchObject({ revokedAtProvider: true, needsReauth: ['google_tasks'] });
    expect((await detail(b, 'google_tasks')).status).toBe('needs_reauth');
    const dag = routes.dagstart.response.parse(await (await b.req('GET', '/api/dagstart')).json());
    expect(dag.items.some((i) => i.type === 'task')).toBe(false);
  });

  it('Google Taken via een eigen Google-project: client-ID en geheim versleuteld, de flow gebruikt die client', async () => {
    const { browser } = setup();
    const b = browser();
    await googleLogin(b, 'robert');
    expect(
      (await b.req('PUT', '/api/connections/google_tasks/client', { clientId: 'fout', clientSecret: 'kortgeheim12' }))
        .status,
    ).toBe(400);
    const put = await b.req('PUT', '/api/connections/google_tasks/client', {
      clientId: '1234-eigen.apps.googleusercontent.com',
      clientSecret: 'eigen-geheim-van-robert',
    });
    expect(put.status).toBe(200);
    expect((await detail(b, 'google_tasks')).ownClient).toBe(true);
    const { authorize } = await connect(b, 'google_tasks');
    expect(authorize.searchParams.get('client_id')).toBe('1234-eigen.apps.googleusercontent.com');
    expect((await detail(b, 'google_tasks')).status).toBe('connected');
    expect(await (await b.req('GET', '/api/connections/details')).text()).not.toContain('eigen-geheim-van-robert');
    await b.req('DELETE', '/api/connections/google_tasks/client');
    expect((await detail(b, 'google_tasks')).ownClient).toBe(false);
  });

  it('Agenda: intrekken wist ook kleur en "overal/alleen in Agenda" per agenda', async () => {
    const { browser, store } = setup();
    const b = browser();
    await googleLogin(b, 'robert');
    const uid = routes.session.response.parse(await (await b.req('GET', '/api/session')).json()).user.id;
    await connect(b, 'calendar');
    await b.req('PATCH', '/api/preferences', {
      calendars: { 'lou@group.calendar.google.com': { color: '#ff0000', scope: 'agenda' } },
    });
    await b.req('PUT', '/api/itemstate/m1', { skipPrep: true });
    expect(Object.keys((await store.preferences(uid)).calendars)).toHaveLength(1);
    const off = routes.disconnect.response.parse(await (await b.req('DELETE', '/api/connections/calendar')).json());
    expect(off.revokedAtProvider).toBe(true);
    expect((await store.preferences(uid)).calendars).toEqual({});
    expect((await store.itemStates(uid))['m1']).toBeUndefined();
    const agenda = routes.agenda.response.parse(await (await b.req('GET', '/api/agenda')).json());
    expect(agenda.events).toHaveLength(0);
  });

  it('Jira (Atlassian 3LO, alleen lezen): geen intrek-API, dus token gewist met uitleg', async () => {
    const { browser } = setup();
    const b = browser();
    await googleLogin(b, 'robert');
    const { authorize } = await connect(b, 'jira');
    expect(authorize.searchParams.get('scope')).toBe('read:jira-work read:jira-user offline_access');
    expect(authorize.searchParams.get('audience')).toBe('api.atlassian.com');
    const off = routes.disconnect.response.parse(await (await b.req('DELETE', '/api/connections/jira')).json());
    expect(off.revokedAtProvider).toBe(false);
    expect(off.note).toContain('Connected apps');
    expect((await detail(b, 'jira')).status).toBe('disconnected');
  });

  it('GitHub: account, Persoonlijk-repo wel/niet gevonden met opdracht voor Claude, intrekken verwijdert de grant en de Persoonlijk-data', async () => {
    const { browser, store } = setup();
    const b = browser();
    await googleLogin(b, 'robert');
    const uid = routes.session.response.parse(await (await b.req('GET', '/api/session')).json()).user.id;
    let pr = routes.persRepo.response.parse(await (await b.req('GET', '/api/github/persoonlijk')).json());
    expect(pr.prompt).toContain('robert@homezero.nl');
    // Nog niet gekoppeld: geen Persoonlijk-data.
    expect(routes.dagstart.response.parse(await (await b.req('GET', '/api/dagstart')).json()).context.pers).toBeNull();
    await connect(b, 'github');
    expect((await detail(b, 'github')).account).toBe('robert');
    await b.req('PATCH', '/api/onboarding', { persRepo: 'HomeZeroTech/persoonlijk-robert' });
    pr = routes.persRepo.response.parse(await (await b.req('GET', '/api/github/persoonlijk')).json());
    expect(pr.status).toBe('exists');
    await b.req('PATCH', '/api/onboarding', { persRepo: 'HomeZeroTech/bestaat-niet' });
    pr = routes.persRepo.response.parse(await (await b.req('GET', '/api/github/persoonlijk')).json());
    expect(pr.status).toBe('missing');
    expect(pr.prompt).toContain('HomeZeroTech/bestaat-niet');
    // Gekoppeld: taken en wachten op uit de Persoonlijk-repo staan in Dagstart en Tracker.
    const dag = async () => routes.dagstart.response.parse(await (await b.req('GET', '/api/dagstart')).json());
    const tracker = async () => routes.tracker.response.parse(await (await b.req('GET', '/api/tracker')).json());
    expect((await dag()).context.pers).toBeTruthy();
    expect((await tracker()).hasPersRepo).toBe(true);
    expect((await tracker()).takenMd).toBeTruthy();
    // Eigen data van die regels (leesstatus, planning) en van een andere bron.
    await b.req('PUT', '/api/itemstate/tm:offerte-nakijken', { read: true });
    await b.req('PUT', '/api/itemstate/wo:reactie-lisanne', { read: true });
    await b.req('PUT', '/api/itemstate/e5', { read: true });
    const tok = fake.tokens.filter((t) => t.family === 'github' && t.kind === 'access' && !t.revoked).at(-1)!;
    const off = routes.disconnect.response.parse(await (await b.req('DELETE', '/api/connections/github')).json());
    expect(off.revokedAtProvider).toBe(true);
    expect(off.wiped).toBe(2);
    expect(fake.tokens.find((t) => t.token === tok.token)!.revoked).toBe(true);
    // Na ontkoppelen: geen Persoonlijk-data meer in Dagstart en Tracker, en de bijbehorende itemstate is weg.
    expect((await dag()).context.pers).toBeNull();
    const tr = await tracker();
    expect(tr.hasPersRepo).toBe(false);
    expect(tr.takenMd).toBeNull();
    const states = await store.itemStates(uid);
    expect(states['tm:offerte-nakijken']).toBeUndefined();
    expect(states['wo:reactie-lisanne']).toBeUndefined();
    expect(states['e5']?.read).toBe(true);
    expect((await detail(b, 'github')).status).toBe('disconnected');
  });

  it('weigeren bij de bron, verlopen of andermans state: niets gekoppeld', async () => {
    const { browser } = setup();
    const a = browser();
    await googleLogin(a, 'robert');
    const denied = await connect(a, 'slack', 'deny');
    expect(denied.location).toBe('/welkom?stap=slack&fout=geweigerd');
    expect((await detail(a, 'slack')).status).toBe('disconnected');
    // State van Robert gebruikt door Lisanne: niet van haar, dus verlopen.
    const r = await a.req('POST', '/api/connections/slack/connect', {});
    const state = new URL(routes.connect.response.parse(await r.json()).redirect!).searchParams.get('state')!;
    const l = browser(SAFARI_IOS);
    await googleLogin(l, 'lisanne');
    const hijack = await l.req('GET', `/api/connections/slack/callback?code=x&state=${state}`);
    expect(hijack.headers.get('location')).toBe('/instellingen/koppelingen?fout=verlopen');
    expect((await detail(l, 'slack')).status).toBe('disconnected');
    // Terugkeer van de bron zonder sessie: naar het inlogscherm, niet een JSON-fout.
    const anon = browser();
    const noSession = await anon.req('GET', `/api/connections/slack/callback?code=x&state=${state}`);
    expect(noSession.status).toBe(302);
    expect(noSession.headers.get('location')).toBe('/login');
    expect((await a.req('PATCH', '/api/onboarding', { persRepo: 'HomeZeroTech/..' })).status).toBe(400);
    // Open redirect via returnTo kan niet.
    const evil = await a.req('POST', '/api/connections/slack/connect', { returnTo: 'https://evil.example' });
    expect(evil.status).toBe(200);
  });

  it('eigen gegevens van een bron wissen zonder te ontkoppelen', async () => {
    const { browser, store } = setup();
    const b = browser();
    await b.req('POST', '/api/auth/dev-login', {});
    const uid = routes.session.response.parse(await (await b.req('GET', '/api/session')).json()).user.id;
    await b.req('PUT', '/api/itemstate/e5', { read: true });
    const r = routes.wipeConnectionData.response.parse(
      await (await b.req('DELETE', '/api/connections/gmail/data')).json(),
    );
    expect(r.wiped).toBe(1);
    expect((await store.itemStates(uid))['e5']).toBeUndefined();
  });

  it('fixture-modus zonder OAuth-client: direct gekoppeld met een versleutelde markering; live zonder client: duidelijke fout', async () => {
    const { browser } = setup({
      HZ_SLACK_CLIENT_ID: '',
      HZ_SLACK_CLIENT_SECRET: '',
    });
    const b = browser();
    await b.req('POST', '/api/auth/dev-login', {});
    expect(await detail(b, 'slack')).toMatchObject({ status: 'connected', oauth: false });
    await b.req('DELETE', '/api/connections/slack');
    expect((await detail(b, 'slack')).status).toBe('disconnected');
    const c = routes.connect.response.parse(await (await b.req('POST', '/api/connections/slack/connect', {})).json());
    expect(c.redirect).toBeNull();
    expect(c.connection.status).toBe('connected');
    expect((await b.req('POST', '/api/connections/wispr/connect', {})).status).toBe(400);
  });
});

/* ---------- Dezelfde regels tegen Postgres met rij-beveiliging ---------- */

const DB_URL = process.env.HZ_TEST_DATABASE_URL_E1 ?? 'postgres://hz_dev:hz_dev@localhost:5432/hz_e1_test_auth';
/** Zelfde database met een andere login (testwachtwoord = loginnaam, zie packages/db/sql/*-login.sql en de CI). */
const asLogin = (login: string) => {
  const u = new URL(DB_URL);
  u.username = login;
  u.password = login;
  return u.toString();
};

describe('Postgres (RLS): sessies, rollen en koppelingen', () => {
  let store: DbStore;
  let ctx: ReturnType<typeof setup>;
  beforeAll(async () => {
    await dbm.ensureDatabase(DB_URL, { recreate: true });
    await dbm.runMigrations(DB_URL);
    // Zoals in productie: de api als hz_app_login (alleen hz_app), inloggen en sessies als hz_auth_login (stuk E2, 0011).
    store = new DbStore(asLogin('hz_app_login'), asLogin('hz_auth_login'));
    ctx = setup({}, { store });
  });
  afterAll(async () => {
    await store?.close();
  });

  it('inloggen, profiel, onboarding-rij en sessie (alleen de hash in de database)', async () => {
    const b = ctx.browser();
    const { location } = await googleLogin(b, 'robert');
    expect(location).toContain('/welkom');
    const owner = dbm.createOwnerDb(DB_URL);
    try {
      // De eigenaar (migratierol) ziet alles via de regels voor de SECURITY DEFINER-functies.
      const rows = await owner.pool.query('select token_hash, user_agent from sessions');
      expect(rows.rows.some((r: { token_hash: string }) => r.token_hash === dbm.hashToken(b.session!))).toBe(true);
      expect(JSON.stringify(rows.rows)).not.toContain(b.session!);
      const acc = await owner.pool.query('select provider, provider_account_id from auth_accounts');
      expect(acc.rows).toEqual([{ provider: 'google', provider_account_id: '100000000000000000001' }]);
    } finally {
      await owner.close();
    }
    expect(routes.onboarding.response.parse(await (await b.req('GET', '/api/onboarding')).json()).status).toBe('new');
  });

  it('gestolen, verlopen en uitloggen overal ook met Postgres', async () => {
    const b = ctx.browser(CHROME_MAC);
    await googleLogin(b, 'robert');
    const thief = ctx.browser(FIREFOX_WIN);
    thief.jar.set(SESSION_COOKIE, b.session!);
    expect((await thief.req('GET', '/api/session')).status).toBe(401);
    expect((await b.req('GET', '/api/session')).status).toBe(401);
    const c = ctx.browser(CHROME_MAC);
    await googleLogin(c, 'robert');
    // Verlopen: de database weigert een vervaldatum in het verleden via auth_touch_session (E2), dus als eigenaar.
    const own = dbm.createOwnerDb(DB_URL);
    try {
      await own.pool.query("update sessions set expires_at = now() - interval '1 second' where token_hash = $1", [
        dbm.hashToken(c.session!),
      ]);
    } finally {
      await own.close();
    }
    expect((await c.req('GET', '/api/session')).status).toBe(401);
    const d1 = ctx.browser(CHROME_MAC);
    const d2 = ctx.browser(SAFARI_IOS);
    await googleLogin(d1, 'robert');
    await googleLogin(d2, 'robert');
    expect(
      routes.logoutAll.response.parse(await (await d1.req('POST', '/api/auth/logout-all')).json()).revoked,
    ).toBeGreaterThanOrEqual(2);
    expect((await d2.req('GET', '/api/session')).status).toBe(401);
  });

  it('rollen: member krijgt 403 en kan ook via de database niet bij teamleden; admin blokkeert', async () => {
    const r = ctx.browser();
    await googleLogin(r, 'robert');
    const l = ctx.browser(SAFARI_IOS);
    await googleLogin(l, 'lisanne');
    const lid = routes.session.response.parse(await (await l.req('GET', '/api/session')).json()).user.id;
    const rid = routes.session.response.parse(await (await r.req('GET', '/api/session')).json()).user.id;
    expect((await l.req('GET', '/api/admin/members')).status).toBe(403);
    // De beheerfuncties controleren zelf de rol van app.user_id (niet een GUC of de aanroeper).
    await expect(dbm.listMembers(store.db, lid)).rejects.toBeInstanceOf(dbm.NotAdminError);
    await expect(dbm.setUserBlocked(store.db, lid, rid, true)).rejects.toBeInstanceOf(dbm.NotAdminError);
    await expect(dbm.addToAllowlist(store.db, lid, 'lisanne@homezero.nl', 'admin')).rejects.toBeInstanceOf(
      dbm.NotAdminError,
    );
    // De rol overnemen van de uitnodigingslijst maakt niemand beheerder die daar niet als beheerder staat.
    expect(await dbm.applyAllowlistRole(store.authDb, lid)).toBe('member');
    // ... en de api-login kan die inlogfunctie niet eens aanroepen (alleen hz_auth, 0015).
    await expect(dbm.applyAllowlistRole(store.db, lid)).rejects.toThrow();
    // Een collega ziet alleen zijn eigen rij in users, ook als de transactie zelf app.purpose 'admin' zet (binnen zijn
    // eigen sessie, zoals een request; zonder sessie ziet de api-login niemand).
    for (const purpose of ['', 'admin'])
      expect(
        await dbm.runWithSession(dbm.hashToken(l.session!), () =>
          dbm.withUser(store.db, lid, async (tx) => {
            await tx.execute(sql`select set_config('app.purpose', ${purpose}, true)`);
            return (await tx.select().from(dbm.users)).map((u) => u.email);
          }),
        ),
      ).toEqual(['lisanne@homezero.nl']);
    // Het gat uit ronde 1: met app.purpose 'admin' (zonder eigen gebruiker) users of sessies zien of wijzigen kan niet.
    const owner = dbm.createOwnerDb(DB_URL);
    try {
      const c = await owner.pool.connect();
      try {
        await c.query('begin');
        await c.query('set local role hz_app');
        await c.query("select set_config('app.purpose', 'admin', true)");
        expect((await c.query('select id from users')).rowCount).toBe(0);
        expect((await c.query('select id from sessions')).rowCount).toBe(0);
        await c.query('savepoint a');
        // 0 rijen (RLS), of na stuk E2 (0008) al geweigerd op kolomrecht: in beide gevallen geen admin.
        const upd = await c.query("update users set role = 'admin' where email = 'lisanne@homezero.nl'").then(
          (x) => x.rowCount,
          (e: Error) => (/permission denied/.test(e.message) ? 0 : Promise.reject(e)),
        );
        expect(upd).toBe(0);
        await c.query('rollback to savepoint a');
        await expect(c.query('select email from allowlist')).rejects.toThrow(/permission denied/);
        await c.query('rollback to savepoint a');
        await c.query("select set_config('app.purpose', 'auth', true)");
        await expect(c.query('select email from allowlist')).rejects.toThrow(/permission denied/);
        await c.query('rollback to savepoint a');
        expect((await c.query('select user_id from auth_accounts')).rowCount).toBe(0);
        await expect(c.query("insert into auth_accounts values ('google', 'x', $1)", [lid])).rejects.toThrow(
          /permission denied/,
        );
        await c.query('rollback');
      } finally {
        c.release();
      }
      const role = await owner.pool.query('select role from users where id = $1', [lid]);
      expect(role.rows[0].role).toBe('member');
    } finally {
      await owner.close();
    }
    const list = routes.members.response.parse(await (await r.req('GET', '/api/admin/members')).json());
    expect(list.members.map((m) => m.email)).toEqual(['robert@homezero.nl', 'lisanne@homezero.nl']);
    expect(list.members[0]).toMatchObject({ role: 'admin', blocked: false });
    expect(list.members[0]!.activeSessions).toBeGreaterThanOrEqual(1);
    expect(list.allowlist.map((a) => a.email)).toContain('robert@homezero.nl');
    expect((await r.req('POST', `/api/admin/members/${rid}/block`, { blocked: true })).status).toBe(400);
    await r.req('POST', `/api/admin/members/${lid}/block`, { blocked: true });
    expect((await l.req('GET', '/api/session')).status).toBe(401);
    const relog = ctx.browser(SAFARI_IOS);
    expect((await googleLogin(relog, 'lisanne')).location).toBe('/login?fout=geblokkeerd');
    await r.req('POST', `/api/admin/members/${lid}/block`, { blocked: false });
    // Uitnodigingslijst via de functies: toevoegen als beheerder, alleen het eigen domein, weghalen.
    expect((await r.req('POST', '/api/admin/allowlist', { email: 'nieuw.lid@homezero.nl' })).status).toBe(200);
    await expect(dbm.addToAllowlist(store.db, rid, 'iemand@example.com', 'member')).rejects.toThrow();
    expect((await r.req('DELETE', '/api/admin/allowlist/nieuw.lid@homezero.nl')).status).toBe(200);
  });

  it('koppelen en intrekken met Postgres: token versleuteld in connections, na intrekken leeg; A ziet de flow van B niet', async () => {
    const b = ctx.browser();
    await googleLogin(b, 'robert');
    const uid = routes.session.response.parse(await (await b.req('GET', '/api/session')).json()).user.id;
    await connect(b, 'slack');
    const tok = fake.tokens.filter((t) => t.family === 'slack' && t.kind === 'access' && !t.revoked).at(-1)!;
    const owner = dbm.createOwnerDb(DB_URL);
    try {
      await owner.pool.query("select set_config('app.user_id', $1, false)", [uid]);
      const row = (
        await owner.pool.query(
          'select token_ciphertext, dek_wrapped, status from connections where user_id = $1 and provider = $2',
          [uid, 'slack'],
        )
      ).rows[0] as { token_ciphertext: string; status: string };
      expect(row.status).toBe('connected');
      expect(row.token_ciphertext).toBeTruthy();
      expect(row.token_ciphertext).not.toContain(tok.token);
      await b.req('PUT', '/api/itemstate/s1', { read: true });
      await b.req('DELETE', '/api/connections/slack');
      const after = (
        await owner.pool.query(
          'select token_ciphertext, status from connections where user_id = $1 and provider = $2',
          [uid, 'slack'],
        )
      ).rows[0] as { token_ciphertext: string | null; status: string };
      expect(after).toEqual({ token_ciphertext: null, status: 'disconnected' });
      const st = await owner.pool.query(
        "select count(*)::int as n from item_state where user_id = $1 and item_key = 's1'",
        [uid],
      );
      expect(st.rows[0].n).toBe(0);
    } finally {
      await owner.close();
    }
    expect(tok.revoked || fake.tokens.find((t) => t.token === tok.token)!.revoked).toBe(true);
    // Flow van Robert is onzichtbaar voor Lisanne (RLS op connect_flows).
    await b.req('POST', '/api/connections/github/connect', {});
    const l = ctx.browser(SAFARI_IOS);
    await googleLogin(l, 'lisanne');
    const lid = routes.session.response.parse(await (await l.req('GET', '/api/session')).json()).user.id;
    const flows = await dbm.runWithSession(dbm.hashToken(l.session!), () =>
      dbm.withUser(store.db, lid, (tx) => tx.select().from(dbm.connectFlows)),
    );
    expect(flows).toEqual([]);
    // De uitnodigingslijst is voor de app helemaal dicht (alleen de functies).
    await expect(dbm.withUser(store.db, lid, (tx) => tx.select().from(dbm.allowlist))).rejects.toThrow();
  });
});

export type { AuthStore };
