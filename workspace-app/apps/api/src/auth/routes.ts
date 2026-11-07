/**
 * Routes van stuk E1: sessies (HZW-011), teamleden en rollen (HZW-012), onboarding (HZW-013) en koppelingen
 * (HZW-014). Inloggen zelf loopt via Auth.js (authjs.ts) onder /api/auth/{signin,callback,signout,…}.
 */
import type { Context } from 'hono';
import { deleteCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import {
  OnboardingPatch,
  PROVIDER_CATALOG,
  PROVIDER_ORDER,
  Weekritme,
  type ConnectionDetail,
  type Item,
  type ProviderName,
  type User,
} from '@hz/shared';
import type { ProviderBundle } from '@hz/providers';
import type { Config } from '../config';
import type { EventBus } from '../events';
import { collect, firstName, stateKey, type Ctx } from '../services';
import type { AppStore } from '../store';
import { deviceLabel, judgeSession, safeReturnTo } from './checks';
import {
  authorizeUrl,
  exchangeCode,
  newState,
  newVerifier,
  oauthFor,
  OAuthError,
  parseStored,
  refreshToken,
  revokeAtProvider,
  type Fetch,
  type OAuthClient,
  type StoredToken,
} from './oauth';
import { emptyOnboarding, NotAdminError, onboardingState, type AuthStore } from './store';

export interface E1Deps {
  config: Config;
  bundle: ProviderBundle;
  store: AppStore;
  auth: AuthStore;
  bus: EventBus;
  fetch: Fetch;
  sessionCookie: string;
}

const PROVIDER_OF: Record<ProviderName, keyof ProviderBundle['providers']> = {
  google_tasks: 'tasks',
  calendar: 'calendar',
  gmail: 'gmail',
  slack: 'slack',
  jira: 'jira',
  github: 'context',
  wispr: 'wispr',
};

/** Welke items en itemstate-sleutels bij een bron horen (ontkoppelen wist ze). */
const ITEM_TYPE: Partial<Record<ProviderName, Item['type']>> = {
  google_tasks: 'task',
  calendar: 'meeting',
  gmail: 'mail',
  slack: 'slack',
  jira: 'jira',
  wispr: 'rec',
};
const KEY_PREFIXES: Partial<Record<ProviderName, string[]>> = {
  google_tasks: ['tk:'],
  gmail: ['ml:'],
  slack: ['sl:'],
  jira: ['jr:'],
  wispr: ['wm:'],
};

export const OWN_CLIENT = 'google_tasks:client';

/* ---------- Sessie bij een cookie (gebruikt door de middleware in app.ts) ---------- */

export async function resolveSession(auth: AuthStore, token: string, userAgent: string, now = new Date()) {
  const s = await auth.sessionByToken(token);
  const v = judgeSession(s && { ...s, blocked: s.user.blocked }, userAgent, now);
  if (!v.ok) {
    if (v.reason === 'ander-apparaat' && s) {
      // Cookie op een ander apparaat of in een andere browser: waarschijnlijk gestolen. Sessie meteen intrekken.
      await auth.revokeSessionByToken(token, 'ander-apparaat');
      await auth.audit(s.userId, 'session.stolen', deviceLabel(userAgent));
    }
    return { user: null, reason: v.reason } as const;
  }
  if (v.touch) await auth.touchSession(token, { lastSeenAt: now, ...(v.renewTo ? { expiresAt: v.renewTo } : {}) });
  return { user: s!.user, renewTo: v.renewTo, sessionId: s!.id } as const;
}

/* ---------- Koppelingen ---------- */

export function connectionsService(d: E1Deps) {
  const { config, bundle, store, auth } = d;

  async function ownClient(userId: string): Promise<OAuthClient | null> {
    const raw = await auth.readSecret(userId, OWN_CLIENT).catch(() => null);
    if (!raw) return null;
    try {
      const j = JSON.parse(raw) as { clientId: string; clientSecret: string };
      return { id: j.clientId, secret: j.clientSecret };
    } catch {
      return null;
    }
  }
  async function oauth(userId: string, p: ProviderName) {
    return oauthFor(config, p, p === 'google_tasks' ? await ownClient(userId) : null);
  }

  async function details(userId: string): Promise<ConnectionDetail[]> {
    const recs = new Map((await auth.connectionRecords(userId)).map((r) => [r.provider, r]));
    const hasOwn = recs.get(OWN_CLIENT)?.hasToken ?? false;
    const out: ConnectionDetail[] = [];
    for (const p of PROVIDER_ORDER) {
      const cat = PROVIDER_CATALOG[p];
      const mode = bundle.providers[PROVIDER_OF[p]].mode;
      const o = cat.viaContext ? null : await oauth(userId, p);
      const r = recs.get(p);
      // Zonder OAuth-flow in fixture-modus is er niets te autoriseren: de bron staat aan tot je hem intrekt.
      const fallback = mode === 'fixture' && !o ? 'connected' : 'disconnected';
      out.push({
        provider: p,
        status: r?.status ?? fallback,
        scopes: r?.scopes.length
          ? r.scopes
          : r?.status === 'connected' || (!r && fallback === 'connected')
            ? cat.scopes
            : [],
        account: r?.account ?? null,
        connectedAt: r?.connectedAt?.toISOString() ?? null,
        mode,
        oauth: !!o,
        ...(p === 'google_tasks' ? { ownClient: hasOwn } : {}),
        error: r?.error ?? null,
      });
    }
    return out;
  }

  /** Eigen data van een bron wissen: itemstate (leesstatus, planning) en bij Agenda de agenda-instellingen. */
  async function wipe(ctx: Ctx, p: ProviderName) {
    const type = ITEM_TYPE[p];
    let keys: string[] = [];
    if (type) {
      const r = await collect(ctx);
      const pool = type === 'meeting' ? r.agenda : r.items;
      keys = pool.filter((i) => i.type === type).map(stateKey);
    }
    let n = await store.deleteItemStates(ctx.user.id, keys, KEY_PREFIXES[p] ?? []);
    if (p === 'calendar') n += await store.resetCalendarPreferences(ctx.user.id);
    return n;
  }

  /**
   * Geldig access token voor een bron (voor de live providers): ververst als het bijna verlopen is en zet de
   * koppeling op 'opnieuw verbinden' als de bron het refresh token weigert.
   */
  async function accessToken(userId: string, p: ProviderName, now = Date.now()): Promise<string | null> {
    const t = parseStored(await auth.readSecret(userId, p));
    if (!t || t.fixture) return null;
    if (!t.expires_at || t.expires_at - 60_000 > now) return t.access_token;
    const o = await oauth(userId, p);
    if (!o) return null;
    try {
      const next = await refreshToken(d.fetch, o, t, now);
      const rec = (await auth.connectionRecords(userId)).find((r) => r.provider === p);
      await auth.saveSecret(userId, p, JSON.stringify(next), {
        scopes: rec?.scopes ?? [],
        account: rec?.account ?? null,
      });
      return next.access_token;
    } catch (e) {
      if (e instanceof OAuthError) {
        await auth.setConnectionError(userId, p, 'needs_reauth', e.message);
        d.bus.invalidate(userId, 'connections');
        return null;
      }
      throw e;
    }
  }

  return { details, wipe, oauth, ownClient, accessToken };
}

export function persRepoPrompt(user: User, repo: string | null) {
  const naam = firstName(user);
  const r = repo ?? `HomeZeroTech/persoonlijk-${naam.toLowerCase().replace(/[^a-z0-9-]/g, '')}`;
  return [
    `Zet mijn Persoonlijk-repo op voor de HomeZero Workspace.`,
    `- Ik ben ${user.name || naam} (${user.email}).`,
    `- Maak de privé-repo ${r} op GitHub, met alleen mij als lid.`,
    `- Zet erin: ik.md (wie ik ben en waar ik aan werk), taken.md, wachten-op.md (met de koppen Open en Bespreken bij eerstvolgend contactmoment) en aangehouden.md, volgens AGENTS.md en _systeem/schema.md van HomeZero-context.`,
    `- Gebruik daarvoor de skill persoonlijke-nachtdienst in modus OPZETTEN als die er is.`,
    `- Schrijf niets in HomeZero-context zelf.`,
  ].join('\n');
}

/* ---------- Registratie ---------- */

type Json = Record<string, unknown>;
type Handler = (input: { params: Json; query: Json; body: Json }, c: Context, ctx: Ctx) => unknown;

export function registerE1(onAny: (name: string, h: Handler) => void, d: E1Deps) {
  const { config, bundle, auth, bus } = d;
  const svc = connectionsService(d);

  const requireAdmin = (u: User) => {
    if (u.role !== 'admin') throw new HTTPException(403, { message: 'Alleen voor beheerders' });
  };
  const adminCall = async <T>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof NotAdminError) throw new HTTPException(403, { message: 'Alleen voor beheerders' });
      throw e;
    }
  };
  const redirectUri = (c: Context, p: ProviderName) =>
    `${(config.HZ_PUBLIC_URL ?? new URL(c.req.url).origin).replace(/\/$/, '')}/api/connections/${p}/callback`;

  /* ----- Inloggen: wat kan er ----- */
  onAny('authConfig', () => ({
    google: config.googleLogin,
    devLogin: config.devLogin,
    domain: config.HZ_ALLOWED_DOMAIN,
  }));

  /* ----- Sessies (HZW-011) ----- */
  onAny('sessions', async (_i, c, ctx) => {
    const current = (await auth.sessionByToken(c.get('token') as string))?.id;
    const list = await auth.activeSessions(ctx.user.id, new Date());
    return {
      sessions: list.map((s) => ({
        id: s.id,
        device: deviceLabel(s.userAgent),
        createdAt: s.createdAt.toISOString(),
        lastSeenAt: s.lastSeenAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        current: s.id === current,
      })),
    };
  });
  onAny('revokeSession', async ({ params }, c, ctx) => {
    const current = (await auth.sessionByToken(c.get('token') as string))?.id;
    if (!(await auth.revokeSession(ctx.user.id, String(params.id))))
      throw new HTTPException(404, { message: 'Onbekende sessie' });
    if (params.id === current) deleteCookie(c, d.sessionCookie, { path: '/' });
    bus.invalidate(ctx.user.id, 'sessions');
    return { ok: true as const };
  });
  onAny('logoutAll', async (_i, c, ctx) => {
    const revoked = await auth.revokeAllSessions(ctx.user.id);
    deleteCookie(c, d.sessionCookie, { path: '/' });
    return { ok: true as const, revoked };
  });

  /* ----- Teamleden en rollen (HZW-012) ----- */
  onAny('members', async (_i, _c, ctx) => {
    requireAdmin(ctx.user);
    return adminCall(() => auth.members(ctx.user.id, new Date()));
  });
  onAny('blockMember', async ({ params, body }, _c, ctx) => {
    requireAdmin(ctx.user);
    const id = String(params.id);
    if (id === ctx.user.id) throw new HTTPException(400, { message: 'Je kunt jezelf niet blokkeren' });
    const u = await adminCall(() => auth.setBlocked(ctx.user.id, id, !!body.blocked));
    if (!u) throw new HTTPException(404, { message: 'Onbekend teamlid' });
    const m = (await adminCall(() => auth.members(ctx.user.id, new Date()))).members.find((x) => x.id === id)!;
    bus.invalidate(ctx.user.id, 'members');
    return m;
  });
  onAny('addAllowlist', async ({ body }, _c, ctx) => {
    requireAdmin(ctx.user);
    const email = String(body.email).toLowerCase();
    if (email.split('@')[1] !== config.HZ_ALLOWED_DOMAIN)
      throw new HTTPException(422, { message: `Alleen @${config.HZ_ALLOWED_DOMAIN}-adressen` });
    const r = await adminCall(() => auth.allowlistAdd(ctx.user.id, email, body.role === 'admin' ? 'admin' : 'member'));
    bus.invalidate(ctx.user.id, 'members');
    return r;
  });
  onAny('removeAllowlist', async ({ params }, _c, ctx) => {
    requireAdmin(ctx.user);
    if (!(await adminCall(() => auth.allowlistRemove(ctx.user.id, String(params.email)))))
      throw new HTTPException(404, { message: 'Niet op de lijst' });
    bus.invalidate(ctx.user.id, 'members');
    return { ok: true as const };
  });

  /* ----- Onboarding (HZW-013) ----- */
  onAny('onboarding', async (_i, _c, ctx) => onboardingState(await auth.onboarding(ctx.user.id)));
  onAny('updateOnboarding', async ({ body }, _c, ctx) => {
    const patch = OnboardingPatch.parse(body);
    const cur = (await auth.onboarding(ctx.user.id)) ?? emptyOnboarding('busy');
    const steps = { ...cur.steps };
    if (patch.mark) steps[patch.mark.step] = patch.mark.as;
    const status = patch.status ?? (cur.status === 'new' ? 'busy' : cur.status);
    const next = await auth.saveOnboarding(ctx.user.id, {
      status,
      step: patch.step ?? cur.step,
      steps,
      ...(patch.weekritme ? { weekritme: Weekritme.parse(patch.weekritme) } : {}),
      ...(patch.persRepo !== undefined ? { persRepo: patch.persRepo } : {}),
      ...(patch.status === 'done' ? { completedAt: new Date() } : {}),
    });
    bus.invalidate(ctx.user.id, 'onboarding');
    return onboardingState(next);
  });

  /* ----- Koppelingen (HZW-013, HZW-014) ----- */
  onAny('connections', async (_i, _c, ctx) => ({
    connections: (await svc.details(ctx.user.id)).map((x) => ({
      provider: x.provider,
      status: x.status,
      scopes: x.scopes,
      ...(x.account ? { account: x.account } : {}),
      ...(x.connectedAt ? { connectedAt: x.connectedAt } : {}),
      ...(x.error ? { error: x.error } : {}),
      mode: x.mode,
    })),
  }));
  onAny('connectionDetails', async (_i, c, ctx) => ({
    connections: await svc.details(ctx.user.id),
    redirectUri: redirectUri(c, 'google_tasks'),
  }));

  onAny('connect', async ({ params, body }, c, ctx) => {
    const p = params.provider as ProviderName;
    const cat = PROVIDER_CATALOG[p];
    if (cat.viaContext) throw new HTTPException(400, { message: `${cat.label} komt uit de contextlaag` });
    const returnTo = safeReturnTo(body?.returnTo, '/instellingen/koppelingen');
    const o = await svc.oauth(ctx.user.id, p);
    const current = async () => (await svc.details(ctx.user.id)).find((x) => x.provider === p)!;
    const asConnection = (x: ConnectionDetail) => ({
      provider: x.provider,
      status: x.status,
      scopes: x.scopes,
      ...(x.account ? { account: x.account } : {}),
      ...(x.connectedAt ? { connectedAt: x.connectedAt } : {}),
      mode: x.mode,
    });
    if (!o) {
      if (bundle.providers[PROVIDER_OF[p]].mode !== 'fixture')
        throw new HTTPException(422, {
          message: `${cat.label} is nog niet ingericht (client-ID en geheim ontbreken; zie HUMAN_INPUT.md)`,
        });
      // Fixture-modus zonder OAuth-flow: niets te autoriseren; een versleutelde markering in plaats van een token.
      const marker: StoredToken = { access_token: 'fixture', fixture: true };
      await auth.saveSecret(ctx.user.id, p, JSON.stringify(marker), {
        scopes: cat.scopes,
        account: cat.family === 'google' ? ctx.user.email : null,
      });
      bus.invalidate(ctx.user.id, 'connections', 'items', 'dagstart');
      return { redirect: null, connection: asConnection(await current()) };
    }
    const state = newState();
    const verifier = newVerifier();
    await auth.createFlow(ctx.user.id, { provider: p, state, codeVerifier: verifier, returnTo });
    await auth.audit(ctx.user.id, 'connection.started', p);
    return {
      redirect: authorizeUrl(o, { redirectUri: redirectUri(c, p), state, verifier, loginHint: ctx.user.email }),
      connection: asConnection(await current()),
    };
  });

  onAny('connectCallback', async ({ params, query }, c, ctx) => {
    const p = params.provider as ProviderName;
    const back = (to: string, k: string, v: string) => c.redirect(`${to}${to.includes('?') ? '&' : '?'}${k}=${v}`, 302);
    const flow = query.state ? await auth.takeFlow(ctx.user.id, p, String(query.state)) : null;
    if (!flow) return back('/instellingen/koppelingen', 'fout', 'verlopen');
    if (query.error || !query.code) {
      await auth.audit(ctx.user.id, 'connection.denied', p);
      return back(flow.returnTo, 'fout', 'geweigerd');
    }
    const o = await svc.oauth(ctx.user.id, p);
    if (!o) return back(flow.returnTo, 'fout', 'niet-ingericht');
    try {
      const x = await exchangeCode(d.fetch, o, {
        code: String(query.code),
        redirectUri: redirectUri(c, p),
        verifier: flow.codeVerifier,
      });
      let account = x.account ?? (o.family === 'google' ? ctx.user.email : null);
      if (o.family === 'github' && o.apiBase) {
        const r = await d.fetch(`${o.apiBase}/user`, {
          headers: { authorization: `Bearer ${x.token.access_token}`, accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(10_000),
        });
        if (r.ok) account = ((await r.json()) as { login?: string }).login ?? account;
      }
      await auth.saveSecret(ctx.user.id, p, JSON.stringify(x.token), { scopes: x.scopes, account });
      bus.invalidate(ctx.user.id, 'connections', 'items', 'dagstart');
      return back(flow.returnTo, 'gekoppeld', p);
    } catch (e) {
      console.error(`[koppelingen] ${p}: ${e instanceof Error ? e.message : String(e)}`);
      await auth.audit(ctx.user.id, 'connection.failed', p);
      return back(flow.returnTo, 'fout', 'bron');
    }
  });

  onAny('disconnect', async ({ params }, _c, ctx) => {
    const p = params.provider as ProviderName;
    const cat = PROVIDER_CATALOG[p];
    const token = parseStored(await auth.readSecret(ctx.user.id, p).catch(() => null));
    const wiped = await svc.wipe(ctx, p);
    let revokedAtProvider = false;
    let note = cat.revoke;
    const o = token && !token.fixture ? await svc.oauth(ctx.user.id, p) : null;
    if (o && token) {
      try {
        revokedAtProvider = await revokeAtProvider(d.fetch, o, token);
      } catch {
        revokedAtProvider = false;
      }
      if (!revokedAtProvider && o.revokeUrl)
        note = `Intrekken bij ${cat.label} lukte niet; het token is wel gewist. Trek de toegang ook in bij ${cat.label} zelf.`;
    }
    await auth.clearConnection(ctx.user.id, p);
    bus.invalidate(ctx.user.id, 'connections', 'items', 'dagstart', 'agenda', 'conversations', 'tasks');
    return { ok: true as const, revokedAtProvider, wiped, note };
  });

  onAny('wipeConnectionData', async ({ params }, _c, ctx) => {
    const p = params.provider as ProviderName;
    const wiped = await svc.wipe(ctx, p);
    await auth.audit(ctx.user.id, 'connection.data-wiped', p);
    bus.invalidate(ctx.user.id, 'items', 'dagstart', 'agenda', 'preferences');
    return { ok: true as const, wiped };
  });

  onAny('ownGoogleClient', async ({ body }, _c, ctx) => {
    await auth.saveSecret(
      ctx.user.id,
      OWN_CLIENT,
      JSON.stringify({ clientId: String(body.clientId), clientSecret: String(body.clientSecret) }),
      { account: String(body.clientId) },
    );
    bus.invalidate(ctx.user.id, 'connections');
    return { ok: true as const };
  });
  onAny('deleteOwnGoogleClient', async (_i, _c, ctx) => {
    await auth.deleteSecret(ctx.user.id, OWN_CLIENT);
    await auth.audit(ctx.user.id, 'connection.own-client.removed', 'google_tasks');
    bus.invalidate(ctx.user.id, 'connections');
    return { ok: true as const };
  });

  onAny('persRepo', async (_i, _c, ctx) => {
    const repo = (await auth.onboarding(ctx.user.id))?.persRepo ?? null;
    const prompt = persRepoPrompt(ctx.user, repo);
    const token = parseStored(await auth.readSecret(ctx.user.id, 'github').catch(() => null));
    const o = await svc.oauth(ctx.user.id, 'github');
    if (token && !token.fixture && o?.apiBase) {
      if (!repo) return { repo, status: 'unknown' as const, prompt };
      const access = await svc.accessToken(ctx.user.id, 'github');
      if (!access) return { repo, status: 'unknown' as const, prompt };
      const r = await d.fetch(`${o.apiBase}/repos/${repo}`, {
        headers: { authorization: `Bearer ${access}`, accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(10_000),
      });
      return {
        repo,
        status: r.ok ? ('exists' as const) : r.status === 404 ? ('missing' as const) : ('unknown' as const),
        prompt,
      };
    }
    if (bundle.providers.context.mode === 'fixture' || !o) {
      const snap = await bundle.providers.context.snapshot().catch(() => null);
      return { repo, status: snap?.pers ? ('exists' as const) : ('missing' as const), prompt };
    }
    return { repo, status: 'unknown' as const, prompt };
  });

  return svc;
}
