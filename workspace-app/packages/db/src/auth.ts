/**
 * Datatoegang van stuk E1: inloggen (Auth.js-adapter), sessies, teamleden, uitnodigingslijst, onboarding,
 * OAuth-koppelingen per bron en het wissen van eigen data. Bouwt op users/sessions/connections uit het fundament.
 *
 * Geen GUC-doelen (app.purpose): die kan elke transactie zelf zetten. Wat niet als de eigen gebruiker (withUser,
 * RLS per rij) kan, loopt via SECURITY DEFINER-functies die precies één sleutel opzoeken of zelf de rol van
 * app.user_id controleren:
 *  - users en sessions: de functies van stuk E2 (auth_user_by_email, auth_upsert_user, auth_create_session,
 *    auth_session_by_token, auth_touch_session, auth_revoke_session; in deze tak uit 0006_e1_auth_compat.sql);
 *  - uitnodigingslijst, Google-account en beheer: 0005_e1_auth.sql (auth_allowlist_role,
 *    auth_apply_allowlist_role, auth_account_lookup, auth_link_account, auth_audit_refusal, admin_*).
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, like, or, sql } from 'drizzle-orm';
import { APP_ROLE, withUser, type Db, type Tx } from './client';
import { openToken, sealToken } from './crypto';
import { hashToken } from './repo';
import { connectFlows, onboarding } from './schema-auth';
import { auditLog, connections, itemState, preferences, sessions, users } from './schema';

export type OnboardingRow = typeof onboarding.$inferSelect;

/** Gebruiker zoals de functies hem teruggeven (geen tokens, geen sessies). */
export interface AuthUserRow {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
  blockedAt: Date | null;
  createdAt: Date;
}
/** Een geldige sessie (niet verlopen, niet ingetrokken, gebruiker niet geblokkeerd) met zijn gebruiker. */
export interface ValidSessionRow {
  id: string;
  userId: string;
  userAgent: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  user: AuthUserRow;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Transactie als hz_app zonder gebruiker en zonder doel: alleen de SECURITY DEFINER-functies werken dan. */
async function asApp<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL ROLE ${APP_ROLE}`));
    return fn(tx);
  });
}

type Raw = Record<string, unknown>;
/** Tijdstip uit een ruwe query (drizzle geeft timestamptz als tekst terug, bv. "2026-11-07 16:20:00.12+00"). */
const ts = (v: unknown): Date | null => {
  if (v == null) return null;
  if (v instanceof Date) return v;
  return new Date(
    String(v)
      .replace(' ', 'T')
      .replace(/([+-]\d\d)$/, '$1:00'),
  );
};
const tsx = (v: unknown) => ts(v) ?? new Date(0);
const rows = async (tx: Tx, q: ReturnType<typeof sql>) => (await tx.execute(q)).rows as Raw[];
const toUserRow = (r: Raw): AuthUserRow => ({
  id: String(r.id),
  email: String(r.email),
  name: String(r.name ?? ''),
  role: r.role === 'admin' ? 'admin' : 'member',
  blockedAt: ts(r.blocked_at),
  createdAt: tsx(r.created_at),
});

/* ---------- Gebruikers en Google-accounts ---------- */

/** Eigen rij, als die gebruiker zelf (RLS per rij). */
export async function getUserById(db: Db, id: string): Promise<AuthUserRow | null> {
  if (!UUID.test(id)) return null;
  return withUser(db, id, async (tx) => {
    const [u] = await tx.select().from(users).where(eq(users.id, id));
    return u
      ? { id: u.id, email: u.email, name: u.name, role: u.role, blockedAt: u.blockedAt, createdAt: u.createdAt }
      : null;
  });
}

export async function getUserByEmail(db: Db, email: string): Promise<AuthUserRow | null> {
  return asApp(db, async (tx) => {
    const [r] = await rows(tx, sql`select * from auth_user_by_email(${email})`);
    return r ? toUserRow(r) : null;
  });
}

/**
 * Gebruiker bij de eerste login (altijd 'member', domein gecontroleerd in de database), daarna de rol van de
 * uitnodigingslijst overnemen; desgewenst de onboarding-rij (als die gebruiker zelf, RLS).
 */
export async function createUser(db: Db, email: string, name: string, opts: { onboarding: boolean }) {
  return asApp(db, async (tx) => {
    const [r] = await rows(tx, sql`select * from auth_upsert_user(${email}, ${name})`);
    const user = toUserRow(r!);
    const [role] = await rows(tx, sql`select auth_apply_allowlist_role(${user.id}::uuid) as role`);
    user.role = role?.role === 'admin' ? 'admin' : 'member';
    if (opts.onboarding) {
      await tx.execute(sql`select set_config('app.user_id', ${user.id}, true)`);
      await tx.insert(onboarding).values({ userId: user.id, status: 'new' }).onConflictDoNothing();
      await tx.execute(sql`select set_config('app.user_id', '', true)`);
    }
    return user;
  });
}

/** Rol overnemen van de uitnodigingslijst (die alleen beheerders vullen). Geeft de rol terug. */
export async function applyAllowlistRole(db: Db, userId: string): Promise<'admin' | 'member' | null> {
  if (!UUID.test(userId)) return null;
  return asApp(db, async (tx) => {
    const [r] = await rows(tx, sql`select auth_apply_allowlist_role(${userId}::uuid) as role`);
    return r?.role === 'admin' ? 'admin' : r?.role === 'member' ? 'member' : null;
  });
}

export async function getUserByAccount(db: Db, provider: string, providerAccountId: string) {
  return asApp(db, async (tx) => {
    const [r] = await rows(tx, sql`select * from auth_account_lookup(${provider}, ${providerAccountId})`);
    return r ? toUserRow(r) : null;
  });
}

export async function linkAccount(db: Db, userId: string, provider: string, providerAccountId: string) {
  if (!UUID.test(userId)) return false;
  return asApp(db, async (tx) => {
    const [r] = await rows(tx, sql`select auth_link_account(${userId}::uuid, ${provider}, ${providerAccountId}) as ok`);
    return r?.ok === true;
  });
}

/* ---------- Uitnodigingslijst ---------- */

export async function allowlistLookup(db: Db, email: string): Promise<{ role: 'admin' | 'member' } | null> {
  return asApp(db, async (tx) => {
    const [r] = await rows(tx, sql`select auth_allowlist_role(${email}) as role`);
    return r?.role === 'admin' || r?.role === 'member' ? { role: r.role } : null;
  });
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
  await asApp(db, (tx) =>
    tx.execute(sql`select auth_create_session(${userId}::uuid, ${hashToken(token)}, ${userAgent}, ${expiresAt})`),
  );
  // Hoe er is ingelogd (google, dev-login): als die gebruiker zelf (eigen auditregel).
  await withUser(db, userId, (tx) => tx.insert(auditLog).values({ userId, action: 'session.via', target: via }));
  return { token, expiresAt };
}

/** De geldige sessie bij een token (verlopen, ingetrokken of geblokkeerd = null), met de gebruiker. */
export async function sessionByToken(db: Db, token: string): Promise<ValidSessionRow | null> {
  return asApp(db, async (tx) => {
    const [r] = await rows(tx, sql`select * from auth_session_by_token(${hashToken(token)})`);
    if (!r) return null;
    return {
      id: String(r.session_id),
      userId: String(r.user_id),
      userAgent: String(r.user_agent ?? ''),
      createdAt: tsx(r.created_at),
      lastSeenAt: tsx(r.last_seen_at),
      expiresAt: tsx(r.expires_at),
      user: {
        id: String(r.user_id),
        email: String(r.email),
        name: String(r.name ?? ''),
        role: r.role === 'admin' ? 'admin' : 'member',
        blockedAt: null,
        createdAt: tsx(r.created_at),
      },
    };
  });
}

/** Laatst gezien bijwerken en desgewenst verlengen (glijdend venster). Alleen een geldige sessie. */
export async function touchSession(db: Db, token: string, patch: { expiresAt?: Date }) {
  await asApp(db, (tx) =>
    tx.execute(sql`select auth_touch_session(${hashToken(token)}, ${patch.expiresAt ?? null}::timestamptz)`),
  );
}

export async function revokeSessionByToken(db: Db, token: string) {
  return asApp(db, async (tx) => {
    const [r] = await rows(tx, sql`select auth_revoke_session(${hashToken(token)}) as ok`);
    return r?.ok === true;
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

/* ---------- Beheer (SECURITY DEFINER-functies die zelf de rol van app.user_id controleren) ---------- */

export class NotAdminError extends Error {
  constructor() {
    super('Alleen voor beheerders');
    this.name = 'NotAdminError';
  }
}

/** Als die beheerder (app.user_id); de functie in de database weigert met 42501 als hij geen beheerder is. */
async function asAdmin<T>(db: Db, adminId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await withUser(db, adminId, fn);
  } catch (e) {
    const code =
      (e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code;
    if (code === '42501') throw new NotAdminError();
    throw e;
  }
}

export async function listMembers(db: Db, adminId: string) {
  return asAdmin(db, adminId, async (tx) => {
    const members = (await rows(tx, sql`select * from admin_members_list()`)).map((r) => ({
      user: toUserRow(r),
      lastSeenAt: ts(r.last_seen_at),
      activeSessions: Number(r.active_sessions ?? 0),
    }));
    const allowlist = (await rows(tx, sql`select * from admin_allowlist_list()`)).map((r) => ({
      email: String(r.email),
      role: (r.role === 'admin' ? 'admin' : 'member') as 'admin' | 'member',
      createdAt: tsx(r.created_at),
    }));
    return { members, allowlist };
  });
}

/** Blokkeren trekt meteen alle sessies van die collega in (in de functie). */
export async function setUserBlocked(db: Db, adminId: string, userId: string, blocked: boolean) {
  if (!UUID.test(userId)) return null;
  return asAdmin(db, adminId, async (tx) => {
    const [r] = await rows(tx, sql`select * from admin_set_user_blocked(${userId}::uuid, ${blocked})`);
    return r ? toUserRow(r) : null;
  });
}

export async function addToAllowlist(db: Db, adminId: string, email: string, role: 'admin' | 'member') {
  return asAdmin(db, adminId, async (tx) => {
    const [r] = await rows(tx, sql`select * from admin_allowlist_add(${email}, ${role})`);
    return {
      email: String(r!.email),
      role: (r!.role === 'admin' ? 'admin' : 'member') as 'admin' | 'member',
      createdAt: tsx(r!.created_at),
    };
  });
}

export async function removeFromAllowlist(db: Db, adminId: string, email: string) {
  return asAdmin(db, adminId, async (tx) => {
    const [r] = await rows(tx, sql`select admin_allowlist_remove(${email}) as ok`);
    return r?.ok === true;
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

/** Geweigerde login zonder gebruiker; alleen het soort reden, geen e-mailadres (functie auth_audit_refusal). */
export async function auditLoginRefused(db: Db, reason: string) {
  await asApp(db, (tx) => tx.execute(sql`select auth_audit_refusal(${reason})`));
}
