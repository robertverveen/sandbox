/**
 * Datatoegang van stuk E1: inloggen (Auth.js-adapter), sessies, teamleden, uitnodigingslijst, onboarding,
 * OAuth-koppelingen per bron en het wissen van eigen data. Bouwt op users/sessions/connections uit het fundament.
 *
 * Doelen (app.purpose):
 *  - 'auth'  inloggen: gebruiker, Google-account en uitnodigingslijst opzoeken, sessie maken of verlengen;
 *  - 'admin' beheer: alleen via withAdmin(), dat eerst in dezelfde transactie controleert dat app.user_id een
 *            niet-geblokkeerde beheerder is. De rest (eigen sessies, onboarding, koppelingen) loopt via withUser.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, like, or, sql } from 'drizzle-orm';
import { withPurpose, withUser, type Db, type Tx } from './client';
import { openToken, sealToken } from './crypto';
import { hashToken } from './repo';
import { allowlist, authAccounts, connectFlows, onboarding } from './schema-auth';
import { auditLog, connections, itemState, preferences, sessions, users } from './schema';

export type UserRow = typeof users.$inferSelect;
export type SessionDbRow = typeof sessions.$inferSelect;
export type OnboardingRow = typeof onboarding.$inferSelect;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/* ---------- Gebruikers en Google-accounts (purpose 'auth') ---------- */

export async function getUserById(db: Db, id: string) {
  if (!UUID.test(id)) return null;
  return withPurpose(db, 'auth', async (tx) => (await tx.select().from(users).where(eq(users.id, id)))[0] ?? null);
}

export async function getUserByEmail(db: Db, email: string) {
  return withPurpose(
    db,
    'auth',
    async (tx) =>
      (
        await tx
          .select()
          .from(users)
          .where(sql`lower(${users.email}) = lower(${email})`)
      )[0] ?? null,
  );
}

/** Nieuwe gebruiker bij de eerste login, met de rol uit de uitnodigingslijst; maakt ook de onboarding-rij. */
export async function createUserWithOnboarding(db: Db, email: string, name: string, role: 'admin' | 'member') {
  return withPurpose(db, 'auth', async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({ email: email.toLowerCase(), name, role })
      .onConflictDoNothing()
      .returning();
    const user =
      u ??
      (
        await tx
          .select()
          .from(users)
          .where(sql`lower(${users.email}) = lower(${email})`)
      )[0]!;
    await tx.insert(auditLog).values({ userId: user.id, action: 'user.created', target: 'users' });
    // De onboarding-rij valt onder RLS per gebruiker: even als die gebruiker schrijven.
    await tx.execute(sql`select set_config('app.user_id', ${user.id}, true)`);
    await tx.insert(onboarding).values({ userId: user.id, status: 'new' }).onConflictDoNothing();
    await tx.execute(sql`select set_config('app.user_id', '', true)`);
    return user;
  });
}

/** Rol bijwerken bij inloggen (bv. vaste beheerder uit HZ_ADMIN_EMAILS). */
export async function setUserRoleOnLogin(db: Db, userId: string, role: 'admin' | 'member') {
  return withPurpose(db, 'auth', async (tx) => {
    const [u] = await tx.update(users).set({ role }).where(eq(users.id, userId)).returning();
    return u ?? null;
  });
}

export async function getUserByAccount(db: Db, provider: string, providerAccountId: string) {
  return withPurpose(db, 'auth', async (tx) => {
    const r = await tx
      .select({ user: users })
      .from(authAccounts)
      .innerJoin(users, eq(users.id, authAccounts.userId))
      .where(and(eq(authAccounts.provider, provider), eq(authAccounts.providerAccountId, providerAccountId)));
    return r[0]?.user ?? null;
  });
}

export async function linkAccount(db: Db, userId: string, provider: string, providerAccountId: string) {
  await withPurpose(db, 'auth', async (tx) => {
    await tx.insert(authAccounts).values({ userId, provider, providerAccountId }).onConflictDoNothing();
    await tx.insert(auditLog).values({ userId, action: 'account.linked', target: provider });
  });
}

/* ---------- Uitnodigingslijst ---------- */

export async function allowlistLookup(db: Db, email: string) {
  return withPurpose(
    db,
    'auth',
    async (tx) => (await tx.select().from(allowlist).where(eq(allowlist.email, email.toLowerCase())))[0] ?? null,
  );
}

/* ---------- Sessies ---------- */

/** Sessie met een token dat de bibliotheek (Auth.js) of de dev-login maakte. Alleen de hash wordt bewaard. */
export async function createSessionWithToken(
  db: Db,
  userId: string,
  token: string,
  userAgent: string,
  expiresAt: Date,
  via: string,
) {
  await withPurpose(db, 'auth', async (tx) => {
    await tx.insert(sessions).values({ userId, tokenHash: hashToken(token), userAgent, expiresAt });
    await tx.insert(auditLog).values({ userId, action: 'session.created', target: via });
  });
  return { token, expiresAt };
}

/** Sessie bij een token, ook verlopen of ingetrokken (de aanroeper beslist), met de gebruiker. */
export async function sessionByToken(db: Db, token: string) {
  return withPurpose(db, 'auth', async (tx) => {
    const r = await tx
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.tokenHash, hashToken(token)));
    return r[0] ?? null;
  });
}

/** Verlengen (glijdend venster) en laatste activiteit bijwerken. */
export async function touchSession(db: Db, token: string, patch: { lastSeenAt: Date; expiresAt?: Date }) {
  await withPurpose(db, 'auth', (tx) =>
    tx
      .update(sessions)
      .set(patch)
      .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt))),
  );
}

export async function revokeSessionByToken(db: Db, token: string, reason: string) {
  await withPurpose(db, 'auth', async (tx) => {
    const [s] = await tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt)))
      .returning({ userId: sessions.userId });
    if (s) await tx.insert(auditLog).values({ userId: s.userId, action: 'session.revoked', target: reason });
  });
}

export async function listOwnSessions(db: Db, userId: string, now = new Date()) {
  return withUser(db, userId, (tx) =>
    tx
      .select()
      .from(sessions)
      .where(and(isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
      .orderBy(desc(sessions.lastSeenAt)),
  );
}

export async function revokeOwnSession(db: Db, userId: string, sessionId: string) {
  if (!UUID.test(sessionId)) return false;
  return withUser(db, userId, async (tx) => {
    const r = await tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    if (r.length) await tx.insert(auditLog).values({ userId, action: 'session.revoked', target: 'apparaat' });
    return r.length > 0;
  });
}

/** Uitloggen overal: alle eigen sessies intrekken. */
export async function revokeAllOwnSessions(db: Db, userId: string) {
  return withUser(db, userId, async (tx) => {
    const r = await tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(isNull(sessions.revokedAt))
      .returning({ id: sessions.id });
    await tx.insert(auditLog).values({ userId, action: 'session.revoked-all', meta: { n: r.length } });
    return r.length;
  });
}

/* ---------- Beheer (purpose 'admin') ---------- */

export class NotAdminError extends Error {
  constructor() {
    super('Alleen voor beheerders');
    this.name = 'NotAdminError';
  }
}

/** Transactie als beheerder: eerst controleren (eigen rij, RLS), dan pas purpose 'admin'. */
export async function withAdmin<T>(db: Db, adminId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withUser(db, adminId, async (tx) => {
    const [me] = await tx.select().from(users).where(eq(users.id, adminId));
    if (!me || me.role !== 'admin' || me.blockedAt) throw new NotAdminError();
    await tx.execute(sql`select set_config('app.purpose', 'admin', true)`);
    return fn(tx);
  });
}

export async function listMembers(db: Db, adminId: string, now = new Date()) {
  return withAdmin(db, adminId, async (tx) => {
    const rows = await tx.select().from(users).orderBy(users.createdAt);
    const sess = await tx
      .select({
        userId: sessions.userId,
        last: sql<Date | null>`max(${sessions.lastSeenAt})`,
        active: sql<number>`count(*) filter (where ${sessions.revokedAt} is null and ${sessions.expiresAt} > ${now})::int`,
      })
      .from(sessions)
      .groupBy(sessions.userId);
    const by = new Map(sess.map((s) => [s.userId, s]));
    const list = await tx.select().from(allowlist).orderBy(allowlist.email);
    return {
      members: rows.map((u) => ({
        user: u,
        lastSeenAt: by.get(u.id)?.last ? new Date(by.get(u.id)!.last!) : null,
        activeSessions: by.get(u.id)?.active ?? 0,
      })),
      allowlist: list,
    };
  });
}

/** Blokkeren trekt meteen alle sessies van die collega in. */
export async function setUserBlocked(db: Db, adminId: string, userId: string, blocked: boolean) {
  if (!UUID.test(userId)) return null;
  return withAdmin(db, adminId, async (tx) => {
    const [u] = await tx
      .update(users)
      .set({ blockedAt: blocked ? new Date() : null })
      .where(eq(users.id, userId))
      .returning();
    if (!u) return null;
    if (blocked)
      await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
    await tx
      .insert(auditLog)
      .values({ userId: adminId, action: blocked ? 'admin.blocked' : 'admin.unblocked', target: userId });
    return u;
  });
}

export async function addToAllowlist(db: Db, adminId: string, email: string, role: 'admin' | 'member') {
  return withAdmin(db, adminId, async (tx) => {
    const [r] = await tx
      .insert(allowlist)
      .values({ email: email.toLowerCase(), role, addedBy: adminId })
      .onConflictDoUpdate({ target: allowlist.email, set: { role } })
      .returning();
    await tx.insert(auditLog).values({ userId: adminId, action: 'admin.allowlist.add', target: email.toLowerCase() });
    return r!;
  });
}

export async function removeFromAllowlist(db: Db, adminId: string, email: string) {
  return withAdmin(db, adminId, async (tx) => {
    const r = await tx.delete(allowlist).where(eq(allowlist.email, email.toLowerCase())).returning();
    await tx
      .insert(auditLog)
      .values({ userId: adminId, action: 'admin.allowlist.remove', target: email.toLowerCase() });
    return r.length > 0;
  });
}

/* ---------- Onboarding ---------- */

export async function getOnboarding(db: Db, userId: string) {
  return withUser(db, userId, async (tx) => (await tx.select().from(onboarding))[0] ?? null);
}

export async function saveOnboarding(
  db: Db,
  userId: string,
  patch: Partial<Pick<OnboardingRow, 'status' | 'step' | 'steps' | 'weekritme' | 'persRepo' | 'completedAt'>>,
) {
  return withUser(db, userId, async (tx) => {
    const [row] = await tx
      .insert(onboarding)
      .values({ userId, ...patch, updatedAt: new Date() })
      .onConflictDoUpdate({ target: onboarding.userId, set: { ...patch, updatedAt: new Date() } })
      .returning();
    return row!;
  });
}

/* ---------- OAuth-koppelingen per bron ---------- */

export async function createConnectFlow(
  db: Db,
  userId: string,
  v: { provider: string; state: string; codeVerifier: string; returnTo: string; ttlMs?: number },
) {
  await withUser(db, userId, async (tx) => {
    // Oude, verlopen flows van deze collega opruimen.
    await tx.delete(connectFlows).where(sql`${connectFlows.expiresAt} < now()`);
    await tx.insert(connectFlows).values({
      userId,
      provider: v.provider,
      stateHash: sha256(v.state),
      codeVerifier: v.codeVerifier,
      returnTo: v.returnTo,
      expiresAt: new Date(Date.now() + (v.ttlMs ?? 10 * 60_000)),
    });
  });
}

/** Eenmalig: de flow wordt bij gebruik verwijderd. Alleen eigen flows (RLS) en niet verlopen. */
export async function takeConnectFlow(db: Db, userId: string, provider: string, state: string) {
  return withUser(db, userId, async (tx) => {
    const [f] = await tx
      .delete(connectFlows)
      .where(and(eq(connectFlows.stateHash, sha256(state)), eq(connectFlows.provider, provider)))
      .returning();
    if (!f || f.expiresAt < new Date()) return null;
    return f;
  });
}

export async function listConnectionDetails(db: Db, userId: string) {
  return withUser(db, userId, (tx) =>
    tx
      .select({
        provider: connections.provider,
        status: connections.status,
        scopes: connections.scopes,
        account: connections.account,
        connectedAt: connections.connectedAt,
        error: connections.error,
        hasToken: sql<boolean>`${connections.tokenCiphertext} is not null`,
      })
      .from(connections),
  );
}

export async function saveSealedConnection(
  db: Db,
  masterKey: Buffer,
  userId: string,
  provider: string,
  secret: string,
  meta: { scopes?: string[]; account?: string | null; status?: 'connected' | 'error' | 'needs_reauth' },
) {
  const sealed = sealToken(secret, masterKey, userId, provider);
  await withUser(db, userId, async (tx) => {
    const set = {
      ...sealed,
      scopes: meta.scopes ?? [],
      account: meta.account ?? null,
      status: meta.status ?? ('connected' as const),
      error: null,
      connectedAt: new Date(),
    };
    await tx
      .insert(connections)
      .values({ userId, provider, ...set })
      .onConflictDoUpdate({ target: [connections.userId, connections.provider], set });
    await tx.insert(auditLog).values({ userId, action: 'connection.connected', target: provider });
  });
}

export async function readSealedConnection(db: Db, masterKey: Buffer, userId: string, provider: string) {
  return withUser(db, userId, async (tx) => {
    const [c] = await tx.select().from(connections).where(eq(connections.provider, provider));
    if (!c?.tokenCiphertext || !c.tokenIv || !c.tokenTag || !c.dekWrapped) return null;
    return openToken(
      {
        tokenCiphertext: c.tokenCiphertext,
        tokenIv: c.tokenIv,
        tokenTag: c.tokenTag,
        dekWrapped: c.dekWrapped,
        keyVersion: c.keyVersion,
      },
      masterKey,
      userId,
      provider,
    );
  });
}

/** Token weg: de rij blijft als 'disconnected' (zonder versleuteld token), zodat de app weet dat je bewust ontkoppelde. */
export async function clearConnection(db: Db, userId: string, provider: string, error: string | null = null) {
  await withUser(db, userId, async (tx) => {
    const set = {
      status: 'disconnected' as const,
      tokenCiphertext: null,
      tokenIv: null,
      tokenTag: null,
      dekWrapped: null,
      scopes: [],
      account: null,
      error,
    };
    await tx
      .insert(connections)
      .values({ userId, provider, ...set })
      .onConflictDoUpdate({ target: [connections.userId, connections.provider], set });
    await tx.insert(auditLog).values({ userId, action: 'connection.revoked', target: provider });
  });
}

export async function setConnectionError(
  db: Db,
  userId: string,
  provider: string,
  status: 'error' | 'needs_reauth',
  error: string,
) {
  await withUser(db, userId, (tx) =>
    tx.update(connections).set({ status, error }).where(eq(connections.provider, provider)),
  );
}

export async function deleteConnectionRow(db: Db, userId: string, provider: string) {
  await withUser(db, userId, (tx) => tx.delete(connections).where(eq(connections.provider, provider)));
}

/* ---------- Eigen data van een bron wissen ---------- */

export async function deleteItemStates(db: Db, userId: string, keys: string[], prefixes: string[]) {
  if (!keys.length && !prefixes.length) return 0;
  return withUser(db, userId, async (tx) => {
    const conds = [
      ...(keys.length ? [inArray(itemState.itemKey, keys)] : []),
      ...prefixes.map((p) => like(itemState.itemKey, p.replace(/[%_\\]/g, '\\$&') + '%')),
    ];
    const r = await tx
      .delete(itemState)
      .where(or(...conds))
      .returning({ k: itemState.itemKey });
    return r.length;
  });
}

export async function resetCalendarPreferences(db: Db, userId: string) {
  return withUser(db, userId, async (tx) => {
    const r = await tx
      .update(preferences)
      .set({ calendars: {}, updatedAt: new Date() })
      .where(sql`${preferences.calendars} <> '{}'::jsonb`)
      .returning({ u: preferences.userId });
    return r.length;
  });
}

export async function auditAs(db: Db, userId: string, action: string, target?: string) {
  await withUser(db, userId, (tx) => tx.insert(auditLog).values({ userId, action, target }));
}

/** Auditregel zonder gebruiker (geweigerde login); alleen het soort reden, geen e-mailadres. */
export async function auditAnonymous(db: Db, action: string, target?: string) {
  await withPurpose(db, 'auth', (tx) => tx.insert(auditLog).values({ userId: null, action, target }));
}
