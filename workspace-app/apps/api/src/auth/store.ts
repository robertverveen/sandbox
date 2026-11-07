/**
 * Opslag van stuk E1: gebruikers, Google-accounts, sessies, uitnodigingslijst, beheer, onboarding, OAuth-flows en
 * versleutelde koppel-tokens. Twee implementaties, net als de app-opslag:
 *  - MemoryAuthStore (ontwikkelen en tests), houdt de koppelstatus gelijk met de MemoryStore;
 *  - DbAuthStore (Postgres met RLS, packages/db/src/auth.ts), op de tabellen users/sessions/connections van het
 *    fundament plus allowlist, auth_accounts, connect_flows en onboarding (migratie 0005_e1_auth.sql).
 * Tokens zijn altijd envelope-versleuteld (ook in het geheugen) en komen nooit in een antwoord naar de browser.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Member, OnboardingState, ProviderName, User } from '@hz/shared';
import * as dbm from '@hz/db';
import type { AppStore } from '../store';

export interface StoredSession {
  id: string;
  userId: string;
  userAgent: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  user: User;
}

export interface OnboardingRecord {
  status: 'new' | 'busy' | 'later' | 'done';
  step: string;
  steps: Record<string, 'done' | 'skipped'>;
  weekritme: Record<string, unknown> | null;
  persRepo: string | null;
  completedAt: Date | null;
}

export interface ConnectionRecord {
  provider: string;
  status: 'connected' | 'disconnected' | 'error' | 'needs_reauth';
  scopes: string[];
  account: string | null;
  connectedAt: Date | null;
  error: string | null;
  hasToken: boolean;
}

export interface FlowRecord {
  provider: string;
  codeVerifier: string;
  returnTo: string;
}

export interface AuthStore {
  readonly kind: 'memory' | 'db';
  userById(id: string): Promise<User | null>;
  userByEmail(email: string): Promise<User | null>;
  createUser(email: string, name: string, role: User['role'], opts: { onboarding: boolean }): Promise<User>;
  setRole(userId: string, role: User['role']): Promise<void>;
  userByAccount(provider: string, sub: string): Promise<User | null>;
  linkAccount(userId: string, provider: string, sub: string): Promise<void>;
  allowlistLookup(email: string): Promise<{ role: User['role'] } | null>;

  createSession(userId: string, token: string, userAgent: string, expiresAt: Date, via: string): Promise<void>;
  sessionByToken(token: string): Promise<StoredSession | null>;
  touchSession(token: string, patch: { lastSeenAt: Date; expiresAt?: Date }): Promise<void>;
  revokeSessionByToken(token: string, reason: string): Promise<void>;
  activeSessions(userId: string, now: Date): Promise<StoredSession[]>;
  revokeSession(userId: string, sessionId: string): Promise<boolean>;
  revokeAllSessions(userId: string): Promise<number>;

  members(
    adminId: string,
    now: Date,
  ): Promise<{ members: Member[]; allowlist: Array<{ email: string; role: User['role']; addedAt: string }> }>;
  setBlocked(adminId: string, userId: string, blocked: boolean): Promise<User | null>;
  allowlistAdd(
    adminId: string,
    email: string,
    role: User['role'],
  ): Promise<{ email: string; role: User['role']; addedAt: string }>;
  allowlistRemove(adminId: string, email: string): Promise<boolean>;

  onboarding(userId: string): Promise<OnboardingRecord | null>;
  saveOnboarding(userId: string, patch: Partial<OnboardingRecord>): Promise<OnboardingRecord>;

  createFlow(userId: string, f: FlowRecord & { state: string }): Promise<void>;
  takeFlow(userId: string, provider: string, state: string): Promise<FlowRecord | null>;

  connectionRecords(userId: string): Promise<ConnectionRecord[]>;
  saveSecret(
    userId: string,
    provider: string,
    secret: string,
    meta: { scopes?: string[]; account?: string | null },
  ): Promise<void>;
  readSecret(userId: string, provider: string): Promise<string | null>;
  clearConnection(userId: string, provider: string): Promise<void>;
  deleteSecret(userId: string, provider: string): Promise<void>;
  setConnectionError(userId: string, provider: string, status: 'error' | 'needs_reauth', error: string): Promise<void>;
  audit(userId: string | null, action: string, target?: string): Promise<void>;
}

export class NotAdminError extends Error {
  constructor() {
    super('Alleen voor beheerders');
    this.name = 'NotAdminError';
  }
}

const hash = (t: string) => createHash('sha256').update(t).digest('hex');
const toUser = (u: dbm.UserRow): User => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  blocked: !!u.blockedAt,
});

/* ---------------------------------------------------------------- geheugen */

interface MemUser extends User {
  createdAt: Date;
}
interface MemSession {
  id: string;
  userId: string;
  tokenHash: string;
  userAgent: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}
interface MemSecret {
  sealed: dbm.SealedToken;
  scopes: string[];
  account: string | null;
  connectedAt: Date;
}

export class MemoryAuthStore implements AuthStore {
  readonly kind = 'memory' as const;
  private users = new Map<string, MemUser>();
  private accounts = new Map<string, string>();
  private sessions = new Map<string, MemSession>();
  private allow = new Map<string, { role: User['role']; addedAt: Date }>();
  private onb = new Map<string, OnboardingRecord>();
  private flows = new Map<string, FlowRecord & { userId: string; expires: number }>();
  private secrets = new Map<string, MemSecret>();
  private errors = new Map<string, { status: 'error' | 'needs_reauth'; error: string }>();
  readonly auditLog: Array<{ userId: string | null; action: string; target?: string; at: Date }> = [];

  constructor(
    private app: AppStore,
    private masterKey: Buffer,
  ) {}

  async userById(id: string) {
    const u = this.users.get(id);
    return u ? this.pub(u) : null;
  }
  private pub(u: MemUser): User {
    return { id: u.id, email: u.email, name: u.name, role: u.role, blocked: u.blocked };
  }
  async userByEmail(email: string) {
    const u = [...this.users.values()].find((x) => x.email === email.toLowerCase());
    return u ? this.pub(u) : null;
  }
  async createUser(email: string, name: string, role: User['role'], opts: { onboarding: boolean }) {
    const found = await this.userByEmail(email);
    if (found) return found;
    const u: MemUser = {
      id: randomUUID(),
      email: email.toLowerCase(),
      name,
      role,
      blocked: false,
      createdAt: new Date(),
    };
    this.users.set(u.id, u);
    if (opts.onboarding) this.onb.set(u.id, emptyOnboarding('new'));
    await this.audit(u.id, 'user.created');
    return this.pub(u);
  }
  async setRole(userId: string, role: User['role']) {
    const u = this.users.get(userId);
    if (u) u.role = role;
  }
  async userByAccount(provider: string, sub: string) {
    const id = this.accounts.get(`${provider}:${sub}`);
    return id ? this.userById(id) : null;
  }
  async linkAccount(userId: string, provider: string, sub: string) {
    this.accounts.set(`${provider}:${sub}`, userId);
  }
  /** Alleen voor tests en de omgeving: de uitnodigingslijst vullen zonder beheerder. */
  seedAllowlist(email: string, role: User['role'] = 'member') {
    this.allow.set(email.toLowerCase(), { role, addedAt: new Date() });
  }
  async allowlistLookup(email: string) {
    const a = this.allow.get(email.toLowerCase());
    return a ? { role: a.role } : null;
  }

  async createSession(userId: string, token: string, userAgent: string, expiresAt: Date, via: string) {
    const now = new Date();
    this.sessions.set(hash(token), {
      id: randomUUID(),
      userId,
      tokenHash: hash(token),
      userAgent,
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
      revokedAt: null,
    });
    await this.audit(userId, 'session.created', via);
  }
  private full(s: MemSession): StoredSession | null {
    const u = this.users.get(s.userId);
    return u ? { ...s, user: this.pub(u) } : null;
  }
  async sessionByToken(token: string) {
    const s = this.sessions.get(hash(token));
    return s ? this.full(s) : null;
  }
  async touchSession(token: string, patch: { lastSeenAt: Date; expiresAt?: Date }) {
    const s = this.sessions.get(hash(token));
    if (s && !s.revokedAt) Object.assign(s, patch);
  }
  async revokeSessionByToken(token: string, reason: string) {
    const s = this.sessions.get(hash(token));
    if (s && !s.revokedAt) {
      s.revokedAt = new Date();
      await this.audit(s.userId, 'session.revoked', reason);
    }
  }
  async activeSessions(userId: string, now: Date) {
    return [...this.sessions.values()]
      .filter((s) => s.userId === userId && !s.revokedAt && s.expiresAt > now)
      .sort((a, b) => +b.lastSeenAt - +a.lastSeenAt)
      .map((s) => this.full(s)!)
      .filter(Boolean);
  }
  async revokeSession(userId: string, sessionId: string) {
    const s = [...this.sessions.values()].find((x) => x.id === sessionId && x.userId === userId && !x.revokedAt);
    if (!s) return false;
    s.revokedAt = new Date();
    await this.audit(userId, 'session.revoked', 'apparaat');
    return true;
  }
  async revokeAllSessions(userId: string) {
    let n = 0;
    for (const s of this.sessions.values())
      if (s.userId === userId && !s.revokedAt) {
        s.revokedAt = new Date();
        n++;
      }
    await this.audit(userId, 'session.revoked-all');
    return n;
  }

  private assertAdmin(adminId: string) {
    const me = this.users.get(adminId);
    if (!me || me.role !== 'admin' || me.blocked) throw new NotAdminError();
  }
  async members(adminId: string, now: Date) {
    this.assertAdmin(adminId);
    const sess = [...this.sessions.values()];
    return {
      members: [...this.users.values()]
        .sort((a, b) => +a.createdAt - +b.createdAt)
        .map((u) => {
          const mine = sess.filter((s) => s.userId === u.id);
          const last = mine.reduce<Date | null>((m, s) => (!m || s.lastSeenAt > m ? s.lastSeenAt : m), null);
          return {
            ...this.pub(u),
            createdAt: u.createdAt.toISOString(),
            lastSeenAt: last?.toISOString() ?? null,
            activeSessions: mine.filter((s) => !s.revokedAt && s.expiresAt > now).length,
          };
        }),
      allowlist: [...this.allow.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([email, a]) => ({ email, role: a.role, addedAt: a.addedAt.toISOString() })),
    };
  }
  async setBlocked(adminId: string, userId: string, blocked: boolean) {
    this.assertAdmin(adminId);
    const u = this.users.get(userId);
    if (!u) return null;
    u.blocked = blocked;
    if (blocked)
      for (const s of this.sessions.values()) if (s.userId === userId && !s.revokedAt) s.revokedAt = new Date();
    await this.audit(adminId, blocked ? 'admin.blocked' : 'admin.unblocked', userId);
    return this.pub(u);
  }
  async allowlistAdd(adminId: string, email: string, role: User['role']) {
    this.assertAdmin(adminId);
    const addedAt = this.allow.get(email.toLowerCase())?.addedAt ?? new Date();
    this.allow.set(email.toLowerCase(), { role, addedAt });
    await this.audit(adminId, 'admin.allowlist.add', email.toLowerCase());
    return { email: email.toLowerCase(), role, addedAt: addedAt.toISOString() };
  }
  async allowlistRemove(adminId: string, email: string) {
    this.assertAdmin(adminId);
    await this.audit(adminId, 'admin.allowlist.remove', email.toLowerCase());
    return this.allow.delete(email.toLowerCase());
  }

  async onboarding(userId: string) {
    const o = this.onb.get(userId);
    return o ? structuredClone(o) : null;
  }
  async saveOnboarding(userId: string, patch: Partial<OnboardingRecord>) {
    const next = { ...(this.onb.get(userId) ?? emptyOnboarding('busy')), ...patch };
    this.onb.set(userId, next);
    return structuredClone(next);
  }

  async createFlow(userId: string, f: FlowRecord & { state: string }) {
    for (const [k, v] of this.flows) if (v.expires < Date.now()) this.flows.delete(k);
    this.flows.set(hash(f.state), {
      provider: f.provider,
      codeVerifier: f.codeVerifier,
      returnTo: f.returnTo,
      userId,
      expires: Date.now() + 10 * 60_000,
    });
  }
  async takeFlow(userId: string, provider: string, state: string) {
    const k = hash(state);
    const f = this.flows.get(k);
    if (!f || f.userId !== userId || f.provider !== provider) return null;
    this.flows.delete(k);
    if (f.expires < Date.now()) return null;
    return { provider: f.provider, codeVerifier: f.codeVerifier, returnTo: f.returnTo };
  }

  async connectionRecords(userId: string) {
    const saved = await this.app.connections(userId);
    const out: ConnectionRecord[] = [];
    const keys = new Set([
      ...Object.keys(saved),
      ...[...this.secrets.keys()].filter((k) => k.startsWith(userId + ':')).map((k) => k.slice(userId.length + 1)),
    ]);
    for (const provider of keys) {
      const sec = this.secrets.get(`${userId}:${provider}`);
      const st = saved[provider as ProviderName];
      const err = this.errors.get(`${userId}:${provider}`);
      out.push({
        provider,
        status: err?.status ?? st?.status ?? (sec ? 'connected' : 'disconnected'),
        scopes: sec?.scopes ?? [],
        account: sec?.account ?? null,
        connectedAt: sec?.connectedAt ?? (st?.connectedAt ? new Date(st.connectedAt) : null),
        error: err?.error ?? null,
        hasToken: !!sec,
      });
    }
    return out;
  }
  async saveSecret(
    userId: string,
    provider: string,
    secret: string,
    meta: { scopes?: string[]; account?: string | null },
  ) {
    const connectedAt = new Date();
    this.secrets.set(`${userId}:${provider}`, {
      sealed: dbm.sealToken(secret, this.masterKey, userId, provider),
      scopes: meta.scopes ?? [],
      account: meta.account ?? null,
      connectedAt,
    });
    this.errors.delete(`${userId}:${provider}`);
    if (!provider.includes(':'))
      await this.app.setConnection(userId, provider as ProviderName, {
        status: 'connected',
        connectedAt: connectedAt.toISOString(),
      });
    await this.audit(userId, 'connection.connected', provider);
  }
  async readSecret(userId: string, provider: string) {
    const s = this.secrets.get(`${userId}:${provider}`);
    return s ? dbm.openToken(s.sealed, this.masterKey, userId, provider) : null;
  }
  /** Alleen voor tests: het versleutelde token zoals het bewaard wordt. */
  sealedFor(userId: string, provider: string) {
    return this.secrets.get(`${userId}:${provider}`)?.sealed ?? null;
  }
  async clearConnection(userId: string, provider: string) {
    this.secrets.delete(`${userId}:${provider}`);
    this.errors.delete(`${userId}:${provider}`);
    await this.app.setConnection(userId, provider as ProviderName, { status: 'disconnected' });
    await this.audit(userId, 'connection.revoked', provider);
  }
  async deleteSecret(userId: string, provider: string) {
    this.secrets.delete(`${userId}:${provider}`);
  }
  async setConnectionError(userId: string, provider: string, status: 'error' | 'needs_reauth', error: string) {
    this.errors.set(`${userId}:${provider}`, { status, error });
    // Zelfde status in de app-opslag, zodat de schermen de bron niet meer lezen (zoals de tabel connections).
    const st = (await this.app.connections(userId))[provider as ProviderName];
    if (st) await this.app.setConnection(userId, provider as ProviderName, { ...st, status });
  }
  async audit(userId: string | null, action: string, target?: string) {
    this.auditLog.push({ userId, action, target, at: new Date() });
  }
}

export const emptyOnboarding = (status: OnboardingRecord['status']): OnboardingRecord => ({
  status,
  step: 'welkom',
  steps: {},
  weekritme: null,
  persRepo: null,
  completedAt: null,
});

/* ---------------------------------------------------------------- Postgres */

export class DbAuthStore implements AuthStore {
  readonly kind = 'db' as const;
  constructor(
    private db: dbm.Db,
    private masterKey: Buffer,
  ) {}

  async userById(id: string) {
    const u = await dbm.getUserById(this.db, id);
    return u ? toUser(u) : null;
  }
  async userByEmail(email: string) {
    const u = await dbm.getUserByEmail(this.db, email);
    return u ? toUser(u) : null;
  }
  async createUser(email: string, name: string, role: User['role'], opts: { onboarding: boolean }) {
    if (opts.onboarding) return toUser(await dbm.createUserWithOnboarding(this.db, email, name, role));
    return toUser(await dbm.upsertUser(this.db, email, name, role));
  }
  async setRole(userId: string, role: User['role']) {
    await dbm.setUserRoleOnLogin(this.db, userId, role);
  }
  async userByAccount(provider: string, sub: string) {
    const u = await dbm.getUserByAccount(this.db, provider, sub);
    return u ? toUser(u) : null;
  }
  async linkAccount(userId: string, provider: string, sub: string) {
    await dbm.linkAccount(this.db, userId, provider, sub);
  }
  async allowlistLookup(email: string) {
    const a = await dbm.allowlistLookup(this.db, email);
    return a ? { role: a.role } : null;
  }
  async createSession(userId: string, token: string, userAgent: string, expiresAt: Date, via: string) {
    await dbm.createSessionWithToken(this.db, userId, token, userAgent, expiresAt, via);
  }
  async sessionByToken(token: string) {
    const r = await dbm.sessionByToken(this.db, token);
    return r ? this.toSession(r.session, r.user) : null;
  }
  private toSession(s: dbm.SessionDbRow, u: dbm.UserRow): StoredSession {
    return {
      id: s.id,
      userId: s.userId,
      userAgent: s.userAgent,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
      revokedAt: s.revokedAt,
      user: toUser(u),
    };
  }
  async touchSession(token: string, patch: { lastSeenAt: Date; expiresAt?: Date }) {
    await dbm.touchSession(this.db, token, patch);
  }
  async revokeSessionByToken(token: string, reason: string) {
    await dbm.revokeSessionByToken(this.db, token, reason);
  }
  async activeSessions(userId: string, now: Date) {
    const user = await this.userById(userId);
    if (!user) return [];
    const rows = await dbm.listOwnSessions(this.db, userId, now);
    return rows.map((s) => ({
      id: s.id,
      userId: s.userId,
      userAgent: s.userAgent,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
      revokedAt: s.revokedAt,
      user,
    }));
  }
  async revokeSession(userId: string, sessionId: string) {
    return dbm.revokeOwnSession(this.db, userId, sessionId);
  }
  async revokeAllSessions(userId: string) {
    return dbm.revokeAllOwnSessions(this.db, userId);
  }
  private async admin<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof dbm.NotAdminError) throw new NotAdminError();
      throw e;
    }
  }
  async members(adminId: string, now: Date) {
    const r = await this.admin(() => dbm.listMembers(this.db, adminId, now));
    return {
      members: r.members.map((m) => ({
        ...toUser(m.user),
        createdAt: m.user.createdAt.toISOString(),
        lastSeenAt: m.lastSeenAt?.toISOString() ?? null,
        activeSessions: m.activeSessions,
      })),
      allowlist: r.allowlist.map((a) => ({ email: a.email, role: a.role, addedAt: a.createdAt.toISOString() })),
    };
  }
  async setBlocked(adminId: string, userId: string, blocked: boolean) {
    const u = await this.admin(() => dbm.setUserBlocked(this.db, adminId, userId, blocked));
    return u ? toUser(u) : null;
  }
  async allowlistAdd(adminId: string, email: string, role: User['role']) {
    const a = await this.admin(() => dbm.addToAllowlist(this.db, adminId, email, role));
    return { email: a.email, role: a.role, addedAt: a.createdAt.toISOString() };
  }
  async allowlistRemove(adminId: string, email: string) {
    return this.admin(() => dbm.removeFromAllowlist(this.db, adminId, email));
  }
  private toOnb(r: dbm.OnboardingRow): OnboardingRecord {
    return {
      status: r.status,
      step: r.step,
      steps: r.steps,
      weekritme: r.weekritme ?? null,
      persRepo: r.persRepo,
      completedAt: r.completedAt,
    };
  }
  async onboarding(userId: string) {
    const r = await dbm.getOnboarding(this.db, userId);
    return r ? this.toOnb(r) : null;
  }
  async saveOnboarding(userId: string, patch: Partial<OnboardingRecord>) {
    return this.toOnb(await dbm.saveOnboarding(this.db, userId, patch));
  }
  async createFlow(userId: string, f: FlowRecord & { state: string }) {
    await dbm.createConnectFlow(this.db, userId, {
      provider: f.provider,
      state: f.state,
      codeVerifier: f.codeVerifier,
      returnTo: f.returnTo,
    });
  }
  async takeFlow(userId: string, provider: string, state: string) {
    const f = await dbm.takeConnectFlow(this.db, userId, provider, state);
    return f ? { provider: f.provider, codeVerifier: f.codeVerifier, returnTo: f.returnTo } : null;
  }
  async connectionRecords(userId: string) {
    return (await dbm.listConnectionDetails(this.db, userId)).map((r) => ({ ...r, hasToken: !!r.hasToken }));
  }
  async saveSecret(
    userId: string,
    provider: string,
    secret: string,
    meta: { scopes?: string[]; account?: string | null },
  ) {
    await dbm.saveSealedConnection(this.db, this.masterKey, userId, provider, secret, meta);
  }
  async readSecret(userId: string, provider: string) {
    return dbm.readSealedConnection(this.db, this.masterKey, userId, provider);
  }
  async clearConnection(userId: string, provider: string) {
    await dbm.clearConnection(this.db, userId, provider);
  }
  async deleteSecret(userId: string, provider: string) {
    await dbm.deleteConnectionRow(this.db, userId, provider);
  }
  async setConnectionError(userId: string, provider: string, status: 'error' | 'needs_reauth', error: string) {
    await dbm.setConnectionError(this.db, userId, provider, status, error);
  }
  async audit(userId: string | null, action: string, target?: string) {
    if (userId) await dbm.auditAs(this.db, userId, action, target);
    else await dbm.auditAnonymous(this.db, action, target);
  }
}

export function onboardingState(r: OnboardingRecord | null): OnboardingState {
  if (!r) return { status: 'none', step: 'welkom', steps: {}, weekritme: null, persRepo: null, completedAt: null };
  return {
    status: r.status,
    step: r.step as OnboardingState['step'],
    steps: r.steps as OnboardingState['steps'],
    weekritme: (r.weekritme as OnboardingState['weekritme']) ?? null,
    persRepo: r.persRepo,
    completedAt: r.completedAt?.toISOString() ?? null,
  };
}
