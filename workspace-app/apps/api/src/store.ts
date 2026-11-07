/** Wat in de wachtrij naar de repo gaat (uitkomst van planRepoWrite plus het soort). */
export type QueueInput = Pick<RepoQueueEntry, 'repo' | 'path' | 'op' | 'line' | 'slug'> & { kind: RepoWriteKind };

export const DEFAULT_PREFERENCES: Preferences = { theme: 'system', calendars: {} };

/**
 * App-opslag: alleen wat de app zelf bewaart (sessies, leesstatus en planning, weekdoelen, briefings, koppelingen,
 * vastgezette zoekopdrachten, voorkeuren, de wachtrij naar de repo's).
 * MemoryStore: voor ontwikkelen en tests, per gebruiker gevuld uit de fixture-dataset.
 * DbStore: Postgres met rij-beveiliging (packages/db), aan met HZ_STORE=db.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type {
  Briefing,
  CommitItem,
  ItemState,
  NewPin,
  Pin,
  Preferences,
  ProviderName,
  RepoQueueEntry,
  RepoQueueStatus,
  RepoWriteKind,
  User,
  Weekdoel,
} from '@hz/shared';
import type { FixtureDataset } from '@hz/providers';
import * as dbm from '@hz/db';

export interface ConnectionState {
  status: 'connected' | 'disconnected' | 'error' | 'needs_reauth';
  connectedAt?: string;
}

export interface AppStore {
  readonly kind: 'memory' | 'db';
  ensureUser(email: string, name: string, role?: User['role']): Promise<User>;
  createSession(userId: string, userAgent: string): Promise<{ token: string; expiresAt: Date }>;
  userForSession(token: string): Promise<User | null>;
  revokeSession(token: string): Promise<void>;
  itemStates(userId: string): Promise<Record<string, ItemState>>;
  setItemState(userId: string, key: string, patch: Omit<ItemState, 'key'>): Promise<ItemState>;
  weekdoelen(userId: string): Promise<Weekdoel[]>;
  addWeekdoel(userId: string, v: { wat: string; week: string; deadline?: string | null }): Promise<Weekdoel>;
  updateWeekdoel(
    userId: string,
    id: string,
    patch: Partial<Weekdoel> & { note?: string },
    today: string,
  ): Promise<Weekdoel | null>;
  latestBriefing(userId: string): Promise<Briefing | null>;
  /** Tracker-items uit de artifact-opslag (import HZW-021). */
  legacyCommits(userId: string): Promise<CommitItem[]>;
  connections(userId: string): Promise<Partial<Record<ProviderName, ConnectionState>>>;
  setConnection(userId: string, provider: ProviderName, state: ConnectionState | null): Promise<void>;
  audit(userId: string, action: string, target?: string): Promise<void>;
  pins(userId: string): Promise<Pin[]>;
  addPin(userId: string, p: NewPin): Promise<Pin>;
  deletePin(userId: string, id: string): Promise<boolean>;
  preferences(userId: string): Promise<Preferences>;
  savePreferences(userId: string, patch: Partial<Preferences>): Promise<Preferences>;
  enqueueRepo(userId: string, q: QueueInput): Promise<RepoQueueEntry>;
  repoQueue(userId: string, status?: RepoQueueStatus): Promise<RepoQueueEntry[]>;
  repoQueueEntry(userId: string, id: string): Promise<RepoQueueEntry | null>;
  /** Aantal regels in de rij met `[id:: <slug>-<dag>-n]`, voor het volgende volgnummer. */
  queuedIdCount(userId: string, slug: string, yyyymmdd: string): Promise<number>;
  close(): Promise<void>;
}

const clone = <T>(x: T): T => structuredClone(x);

export class MemoryStore implements AppStore {
  readonly kind = 'memory' as const;
  private users = new Map<string, User>();
  private sessions = new Map<string, { userId: string; expiresAt: Date; revoked: boolean }>();
  private state = new Map<string, Map<string, ItemState>>();
  private goals = new Map<string, Weekdoel[]>();
  private conns = new Map<string, Partial<Record<ProviderName, ConnectionState>>>();
  private pinMap = new Map<string, Pin[]>();
  private prefs = new Map<string, Preferences>();
  private queue = new Map<string, RepoQueueEntry[]>();
  readonly auditLog: Array<{ userId: string; action: string; target?: string; at: Date }> = [];

  constructor(private ds: FixtureDataset) {}

  async ensureUser(email: string, name: string, role: User['role'] = 'member') {
    const found = [...this.users.values()].find((u) => u.email.toLowerCase() === email.toLowerCase());
    if (found) return found;
    const u: User = { id: randomUUID(), email: email.toLowerCase(), name, role, blocked: false };
    this.users.set(u.id, u);
    return u;
  }
  async createSession(userId: string, _ua: string) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 30 * 864e5);
    this.sessions.set(token, { userId, expiresAt, revoked: false });
    return { token, expiresAt };
  }
  async userForSession(token: string) {
    const s = this.sessions.get(token);
    if (!s || s.revoked || s.expiresAt < new Date()) return null;
    const u = this.users.get(s.userId);
    return u && !u.blocked ? u : null;
  }
  async revokeSession(token: string) {
    const s = this.sessions.get(token);
    if (s) s.revoked = true;
  }
  async itemStates(userId: string) {
    return Object.fromEntries(this.state.get(userId) ?? new Map());
  }
  async setItemState(userId: string, key: string, patch: Omit<ItemState, 'key'>) {
    const m = this.state.get(userId) ?? new Map<string, ItemState>();
    const next: ItemState = { ...(m.get(key) ?? { key }), ...patch, key };
    m.set(key, next);
    this.state.set(userId, m);
    return next;
  }
  private goalsOf(userId: string) {
    let g = this.goals.get(userId);
    if (!g) {
      g = clone(this.ds.weekdoelen);
      this.goals.set(userId, g);
    }
    return g;
  }
  async weekdoelen(userId: string) {
    return this.goalsOf(userId);
  }
  async addWeekdoel(userId: string, v: { wat: string; week: string; deadline?: string | null }) {
    const w: Weekdoel = {
      id: randomUUID(),
      wat: v.wat,
      soort: 'weekdoel',
      week: v.week,
      deadline: v.deadline ?? null,
      status: 'open',
      checks: [],
    };
    this.goalsOf(userId).push(w);
    return w;
  }
  async updateWeekdoel(userId: string, id: string, patch: Partial<Weekdoel> & { note?: string }, today: string) {
    const w = this.goalsOf(userId).find((x) => x.id === id);
    if (!w) return null;
    const { note, ...rest } = patch;
    Object.assign(w, rest);
    if (patch.health) {
      w.lastCheck = today;
      w.checks = [...w.checks, { d: today, h: patch.health, ...(note ? { note } : {}) }];
    }
    if (patch.status && patch.status !== 'open') w.closedAt = today;
    return w;
  }
  async latestBriefing(_userId: string) {
    return this.ds.briefing ? clone(this.ds.briefing) : null;
  }
  async legacyCommits(_userId: string) {
    return clone(this.ds.legacyCommits);
  }
  async connections(userId: string) {
    return this.conns.get(userId) ?? {};
  }
  async setConnection(userId: string, provider: ProviderName, state: ConnectionState | null) {
    const c = { ...(this.conns.get(userId) ?? {}) };
    if (state) c[provider] = state;
    else delete c[provider];
    this.conns.set(userId, c);
  }
  async audit(userId: string, action: string, target?: string) {
    this.auditLog.push({ userId, action, target, at: new Date() });
  }
  async pins(userId: string) {
    return clone(this.pinMap.get(userId) ?? []);
  }
  async addPin(userId: string, p: NewPin) {
    const list = this.pinMap.get(userId) ?? [];
    const pin: Pin = {
      id: randomUUID(),
      kind: p.kind,
      label: p.label,
      q: p.q ?? null,
      view: p.view ?? null,
      position: list.length,
      createdAt: new Date().toISOString(),
    };
    this.pinMap.set(userId, [...list, pin]);
    return pin;
  }
  async deletePin(userId: string, id: string) {
    const list = this.pinMap.get(userId) ?? [];
    this.pinMap.set(
      userId,
      list.filter((p) => p.id !== id),
    );
    return list.some((p) => p.id === id);
  }
  async preferences(userId: string) {
    return clone(this.prefs.get(userId) ?? DEFAULT_PREFERENCES);
  }
  async savePreferences(userId: string, patch: Partial<Preferences>) {
    const cur = this.prefs.get(userId) ?? DEFAULT_PREFERENCES;
    const next: Preferences = {
      theme: patch.theme ?? cur.theme,
      calendars: { ...cur.calendars, ...(patch.calendars ?? {}) },
    };
    this.prefs.set(userId, next);
    return clone(next);
  }
  async enqueueRepo(userId: string, q: QueueInput) {
    const e: RepoQueueEntry = {
      id: randomUUID(),
      ...q,
      status: 'queued',
      commitSha: null,
      checkExit: null,
      error: null,
      createdAt: new Date().toISOString(),
      processedAt: null,
    };
    this.queue.set(userId, [e, ...(this.queue.get(userId) ?? [])]);
    this.auditLog.push({ userId, action: 'repo.queued', target: `${q.repo}:${q.path}`, at: new Date() });
    return clone(e);
  }
  async repoQueue(userId: string, status?: RepoQueueStatus) {
    return clone((this.queue.get(userId) ?? []).filter((e) => !status || e.status === status));
  }
  async repoQueueEntry(userId: string, id: string) {
    const e = (this.queue.get(userId) ?? []).find((x) => x.id === id);
    return e ? clone(e) : null;
  }
  async queuedIdCount(userId: string, slug: string, yyyymmdd: string) {
    return (this.queue.get(userId) ?? []).filter((e) => e.line.includes(`[id:: ${slug}-${yyyymmdd}-`)).length;
  }
  async close() {}
}

/** Postgres-opslag met RLS. Briefings en tracker-items komen uit de database (routines schrijven via MCP). */
export class DbStore implements AppStore {
  readonly kind = 'db' as const;
  private conn: ReturnType<typeof dbm.createDb>;
  constructor(url: string) {
    this.conn = dbm.createDb(url);
  }
  get db() {
    return this.conn.db;
  }
  async ensureUser(email: string, name: string, role: User['role'] = 'member') {
    const u = await dbm.upsertUser(this.db, email, name, role);
    return { id: u.id, email: u.email, name: u.name, role: u.role, blocked: !!u.blockedAt };
  }
  async createSession(userId: string, ua: string) {
    return dbm.createSession(this.db, userId, ua);
  }
  async userForSession(token: string) {
    const r = await dbm.findSession(this.db, token);
    return r ? { id: r.user.id, email: r.user.email, name: r.user.name, role: r.user.role, blocked: false } : null;
  }
  async revokeSession(token: string) {
    await dbm.revokeSession(this.db, token);
  }
  async itemStates(userId: string) {
    const rows = await dbm.listItemState(this.db, userId);
    return Object.fromEntries(rows.map((r) => [r.itemKey, this.toItemState(r)]));
  }
  private toItemState(r: typeof dbm.itemState.$inferSelect): ItemState {
    return {
      key: r.itemKey,
      read: r.read,
      processed: r.processed,
      skipPrep: r.skipPrep,
      plan: r.planDate,
      backlog: r.backlog,
      moved: r.moved,
      answeredBy: r.answeredBy ?? undefined,
      extra: r.extra,
    };
  }
  async setItemState(userId: string, key: string, patch: Omit<ItemState, 'key'>) {
    const { read, processed, skipPrep, answeredBy, extra, plan, backlog, moved } = patch;
    const r = await dbm.setItemState(this.db, userId, key, {
      read,
      processed,
      skipPrep,
      answeredBy,
      extra,
      planDate: plan,
      backlog,
      moved,
    });
    return this.toItemState(r);
  }
  private toWeekdoel(r: typeof dbm.weekdoelen.$inferSelect): Weekdoel {
    return {
      id: r.id,
      wat: r.wat,
      soort: r.soort,
      week: r.week ?? undefined,
      deadline: r.deadline,
      status: r.status as Weekdoel['status'],
      health: (r.health ?? undefined) as Weekdoel['health'],
      outcome: (r.outcome ?? undefined) as Weekdoel['outcome'],
      checks: r.checks as Weekdoel['checks'],
      closedAt: r.closedAt ?? undefined,
      bron: r.bron ?? undefined,
      lastCheck: r.checks.length ? r.checks[r.checks.length - 1]!.d : undefined,
      created: r.createdAt.getTime() > 0 ? r.createdAt.toISOString().slice(0, 10) : undefined,
    };
  }
  async weekdoelen(userId: string) {
    return (await dbm.listWeekdoelen(this.db, userId)).map((r) => this.toWeekdoel(r));
  }
  async addWeekdoel(userId: string, v: { wat: string; week: string; deadline?: string | null }) {
    return this.toWeekdoel(await dbm.addWeekdoel(this.db, userId, v));
  }
  async updateWeekdoel(userId: string, id: string, patch: Partial<Weekdoel> & { note?: string }, today: string) {
    const r = await dbm.updateWeekdoel(
      this.db,
      userId,
      id,
      { health: patch.health, status: patch.status, outcome: patch.outcome, note: patch.note },
      today,
    );
    return r ? this.toWeekdoel(r) : null;
  }
  async latestBriefing(userId: string) {
    const b = await dbm.latestBriefing(this.db, userId);
    return b
      ? {
          id: b.id,
          date: b.date,
          title: b.title,
          createdAt: b.createdAt.toISOString(),
          session: b.session,
          sections: b.sections,
        }
      : null;
  }
  /** Tracker-items uit de import van het prototype (tracker_items), zoals commitItems() daar. */
  async legacyCommits(userId: string): Promise<CommitItem[]> {
    const rows = await dbm.listTrackerItems(this.db, userId);
    return rows.filter(dbm.trackerItemVisible).map((r) => {
      const label = r.bron?.label ?? '';
      const parts = [r.aan, label, r.bewijs ?? ''].filter(Boolean);
      // De organisatie helpt de herkenning (recognize leest titel en body); niet dubbel als hij er al in staat.
      if (r.org && !parts.join(' ').toLowerCase().includes(r.org.toLowerCase())) parts.splice(1, 0, r.org);
      return {
        id: 'cm:' + (r.legacyId ?? r.id),
        docId: r.id,
        type: 'commit' as const,
        title: r.wat,
        entities: [],
        stroom: r.stroom,
        status: r.status,
        aan: r.aan,
        deadline: r.deadline,
        plan: r.planDate,
        backlog: r.backlog,
        reminder: r.reminder,
        moved: r.moved,
        url: r.bron?.url ?? null,
        time: r.created ? r.created + 'T09:00' : null,
        body: parts.join(' · '),
      };
    });
  }
  async connections(userId: string) {
    const rows = await dbm.listConnections(this.db, userId);
    return Object.fromEntries(
      rows.map((r) => [r.provider, { status: r.status, connectedAt: r.connectedAt.toISOString() }]),
    );
  }
  async setConnection(userId: string, provider: ProviderName, state: ConnectionState | null) {
    if (!state) return dbm.deleteConnection(this.db, userId, provider);
    await dbm.setConnectionStatus(this.db, userId, provider, state.status);
  }
  async audit(userId: string, action: string, target?: string) {
    await dbm.audit(this.db, userId, action, target);
  }
  private toPin(r: typeof dbm.pins.$inferSelect): Pin {
    return { ...r, createdAt: r.createdAt.toISOString() };
  }
  async pins(userId: string) {
    return (await dbm.listPins(this.db, userId)).map((r) => this.toPin(r));
  }
  async addPin(userId: string, p: NewPin) {
    return this.toPin(await dbm.addPin(this.db, userId, p));
  }
  async deletePin(userId: string, id: string) {
    return dbm.deletePin(this.db, userId, id);
  }
  async preferences(userId: string) {
    const r = await dbm.getPreferences(this.db, userId);
    return r ? { theme: r.theme, calendars: r.calendars } : structuredClone(DEFAULT_PREFERENCES);
  }
  async savePreferences(userId: string, patch: Partial<Preferences>) {
    const r = await dbm.savePreferences(this.db, userId, patch);
    return { theme: r.theme, calendars: r.calendars };
  }
  private toEntry(r: typeof dbm.repoQueue.$inferSelect): RepoQueueEntry {
    return {
      id: r.id,
      kind: r.kind,
      repo: r.repo,
      path: r.path,
      op: r.op,
      line: r.line,
      slug: r.slug,
      status: r.status,
      commitSha: r.commitSha,
      checkExit: r.checkExit,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
      processedAt: r.processedAt?.toISOString() ?? null,
    };
  }
  async enqueueRepo(userId: string, q: QueueInput) {
    return this.toEntry(await dbm.enqueueRepoWrite(this.db, userId, q));
  }
  async repoQueue(userId: string, status?: RepoQueueStatus) {
    return (await dbm.listRepoQueue(this.db, userId, status)).map((r) => this.toEntry(r));
  }
  async repoQueueEntry(userId: string, id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const r = await dbm.getRepoQueueEntry(this.db, userId, id);
    return r ? this.toEntry(r) : null;
  }
  async queuedIdCount(userId: string, slug: string, yyyymmdd: string) {
    return dbm.countQueuedIds(this.db, userId, slug, yyyymmdd);
  }
  async close() {
    await this.conn.close();
  }
}
