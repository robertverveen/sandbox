/**
 * Datatoegang voor de API. Alles per gebruiker loopt via withUser (RLS); alleen inloggen en
 * sessies opzoeken gebruiken withPurpose('auth').
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { withPurpose, withUser, type Db } from './client';
import { openToken, sealToken } from './crypto';
import {
  auditLog,
  briefings,
  connections,
  contextIndex,
  itemState,
  pins,
  preferences,
  repoQueue,
  sessions,
  users,
  weekdoelen,
} from './schema';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export async function upsertUser(db: Db, email: string, name: string, role: 'admin' | 'member' = 'member') {
  return withPurpose(db, 'auth', async (tx) => {
    const found = await tx
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = lower(${email})`);
    if (found[0]) return found[0];
    const [u] = await tx.insert(users).values({ email: email.toLowerCase(), name, role }).returning();
    await tx.insert(auditLog).values({ userId: u!.id, action: 'user.created', target: 'users' });
    return u!;
  });
}

export async function createSession(db: Db, userId: string, userAgent: string, days = 30) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + days * 864e5);
  await withPurpose(db, 'auth', async (tx) => {
    await tx.insert(sessions).values({ userId, tokenHash: hashToken(token), userAgent, expiresAt });
    await tx.insert(auditLog).values({ userId, action: 'session.created' });
  });
  return { token, expiresAt };
}

/** Sessie bij een cookie-token: geldig, niet ingetrokken, niet verlopen, gebruiker niet geblokkeerd. */
export async function findSession(db: Db, token: string) {
  return withPurpose(db, 'auth', async (tx) => {
    const rows = await tx
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt), isNull(users.blockedAt)));
    const r = rows[0];
    if (!r || r.session.expiresAt < new Date()) return null;
    return r;
  });
}

export async function revokeSession(db: Db, token: string) {
  await withPurpose(db, 'auth', (tx) =>
    tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(eq(sessions.tokenHash, hashToken(token))),
  );
}

export async function listItemState(db: Db, userId: string) {
  return withUser(db, userId, (tx) => tx.select().from(itemState));
}

export async function setItemState(
  db: Db,
  userId: string,
  key: string,
  patch: {
    read?: boolean;
    processed?: boolean;
    skipPrep?: boolean;
    answeredBy?: string;
    planDate?: string | null;
    backlog?: boolean;
    moved?: number;
    extra?: Record<string, unknown>;
  },
) {
  return withUser(db, userId, async (tx) => {
    const values = {
      userId,
      itemKey: key,
      ...patch,
      readAt: patch.read ? new Date() : undefined,
      updatedAt: new Date(),
    };
    const [row] = await tx
      .insert(itemState)
      .values(values)
      .onConflictDoUpdate({ target: [itemState.userId, itemState.itemKey], set: { ...patch, updatedAt: new Date() } })
      .returning();
    return row!;
  });
}

export async function listWeekdoelen(db: Db, userId: string) {
  return withUser(db, userId, (tx) => tx.select().from(weekdoelen).orderBy(desc(weekdoelen.createdAt)));
}

export async function addWeekdoel(db: Db, userId: string, v: { wat: string; week: string; deadline?: string | null }) {
  return withUser(db, userId, async (tx) => {
    const [row] = await tx
      .insert(weekdoelen)
      .values({ userId, wat: v.wat, week: v.week, deadline: v.deadline ?? null })
      .returning();
    return row!;
  });
}

export async function latestBriefing(db: Db, userId: string) {
  return withUser(
    db,
    userId,
    async (tx) => (await tx.select().from(briefings).orderBy(desc(briefings.date)).limit(1))[0] ?? null,
  );
}

export async function saveConnectionToken(
  db: Db,
  masterKey: Buffer,
  userId: string,
  provider: string,
  token: string,
  meta: { scopes?: string[]; account?: string } = {},
) {
  const sealed = sealToken(token, masterKey, userId, provider);
  return withUser(db, userId, async (tx) => {
    await tx
      .insert(connections)
      .values({ userId, provider, ...sealed, scopes: meta.scopes ?? [], account: meta.account, status: 'connected' })
      .onConflictDoUpdate({
        target: [connections.userId, connections.provider],
        set: {
          ...sealed,
          scopes: meta.scopes ?? [],
          account: meta.account,
          status: 'connected',
          error: null,
          connectedAt: new Date(),
        },
      });
    await tx.insert(auditLog).values({ userId, action: 'connection.connected', target: provider });
  });
}

export async function readConnectionToken(db: Db, masterKey: Buffer, userId: string, provider: string) {
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

/** Ontkoppelen: token weg en de rij weg (data van die bron wissen doet de aanroeper per bron). */
export async function deleteConnection(db: Db, userId: string, provider: string) {
  return withUser(db, userId, async (tx) => {
    await tx.delete(connections).where(eq(connections.provider, provider));
    await tx.insert(auditLog).values({ userId, action: 'connection.deleted', target: provider });
  });
}

export async function audit(
  db: Db,
  userId: string,
  action: string,
  target?: string,
  meta: Record<string, unknown> = {},
) {
  await withUser(db, userId, (tx) => tx.insert(auditLog).values({ userId, action, target, meta }));
}

export async function updateWeekdoel(
  db: Db,
  userId: string,
  id: string,
  patch: { health?: string; status?: string; outcome?: string; note?: string },
  today: string,
) {
  return withUser(db, userId, async (tx) => {
    const [cur] = await tx.select().from(weekdoelen).where(eq(weekdoelen.id, id));
    if (!cur) return null;
    const checks = patch.health
      ? [...cur.checks, { d: today, h: patch.health, ...(patch.note ? { note: patch.note } : {}) }]
      : cur.checks;
    const [r] = await tx
      .update(weekdoelen)
      .set({
        health: patch.health ?? cur.health,
        status: patch.status ?? cur.status,
        outcome: patch.outcome ?? cur.outcome,
        checks,
        closedAt: patch.status && patch.status !== 'open' ? today : cur.closedAt,
      })
      .where(eq(weekdoelen.id, id))
      .returning();
    return r ?? null;
  });
}

export async function listConnections(db: Db, userId: string) {
  return withUser(db, userId, (tx) =>
    tx
      .select({ provider: connections.provider, status: connections.status, connectedAt: connections.connectedAt })
      .from(connections),
  );
}

export async function setConnectionStatus(
  db: Db,
  userId: string,
  provider: string,
  status: 'connected' | 'disconnected' | 'error' | 'needs_reauth',
) {
  await withUser(db, userId, (tx) =>
    tx
      .insert(connections)
      .values({ userId, provider, status })
      .onConflictDoUpdate({ target: [connections.userId, connections.provider], set: { status } }),
  );
}

/* ---------- Vastgezette zoekopdrachten en views ---------- */

export async function listPins(db: Db, userId: string) {
  return withUser(db, userId, (tx) => tx.select().from(pins).orderBy(asc(pins.position), asc(pins.createdAt)));
}

export async function addPin(
  db: Db,
  userId: string,
  v: { kind: 'search' | 'view'; label: string; q?: string | null; view?: string | null },
) {
  return withUser(db, userId, async (tx) => {
    const [{ n }] = (await tx.select({ n: sql<number>`count(*)::int` }).from(pins)) as [{ n: number }];
    const [row] = await tx
      .insert(pins)
      .values({ userId, kind: v.kind, label: v.label, q: v.q ?? null, view: v.view ?? null, position: n })
      .returning();
    return row!;
  });
}

export async function deletePin(db: Db, userId: string, id: string) {
  return withUser(db, userId, async (tx) => (await tx.delete(pins).where(eq(pins.id, id)).returning()).length > 0);
}

/* ---------- Voorkeuren ---------- */

export type PreferencesRow = typeof preferences.$inferSelect;

export async function getPreferences(db: Db, userId: string) {
  return withUser(db, userId, async (tx) => (await tx.select().from(preferences))[0] ?? null);
}

export async function savePreferences(
  db: Db,
  userId: string,
  patch: { theme?: PreferencesRow['theme']; calendars?: PreferencesRow['calendars'] },
) {
  return withUser(db, userId, async (tx) => {
    const [cur] = await tx.select().from(preferences);
    const next = {
      theme: patch.theme ?? cur?.theme ?? 'system',
      calendars: patch.calendars ? { ...(cur?.calendars ?? {}), ...patch.calendars } : (cur?.calendars ?? {}),
      updatedAt: new Date(),
    };
    const [row] = await tx
      .insert(preferences)
      .values({ userId, ...next })
      .onConflictDoUpdate({ target: preferences.userId, set: next })
      .returning();
    return row!;
  });
}

/* ---------- Wachtrij naar de repo's ---------- */

export type RepoQueueRow = typeof repoQueue.$inferSelect;

export async function enqueueRepoWrite(
  db: Db,
  userId: string,
  v: Pick<RepoQueueRow, 'repo' | 'kind' | 'path' | 'op' | 'line' | 'slug'>,
) {
  return withUser(db, userId, async (tx) => {
    const [row] = await tx
      .insert(repoQueue)
      .values({ userId, ...v })
      .returning();
    await tx.insert(auditLog).values({ userId, action: 'repo.queued', target: `${v.repo}:${v.path}` });
    return row!;
  });
}

export async function listRepoQueue(db: Db, userId: string, status?: RepoQueueRow['status']) {
  return withUser(db, userId, (tx) =>
    tx
      .select()
      .from(repoQueue)
      .where(status ? eq(repoQueue.status, status) : undefined)
      .orderBy(desc(repoQueue.createdAt)),
  );
}

export async function getRepoQueueEntry(db: Db, userId: string, id: string) {
  return withUser(db, userId, async (tx) => (await tx.select().from(repoQueue).where(eq(repoQueue.id, id)))[0] ?? null);
}

/** Aantal regels van vandaag voor een slug in de rij, voor het volgnummer in `[id:: <slug>-JJJJMMDD-n]`. */
export async function countQueuedIds(db: Db, userId: string, slug: string, yyyymmdd: string) {
  return withUser(db, userId, async (tx) => {
    const r = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(repoQueue)
      .where(and(eq(repoQueue.slug, slug), sql`${repoQueue.line} like ${'%[id:: ' + slug + '-' + yyyymmdd + '-%'}`));
    return r[0]?.n ?? 0;
  });
}

/* ---------- Contextindex (gevuld door de indexjob van het context-stuk) ---------- */

export type ContextIndexRow = typeof contextIndex.$inferInsert;

/** Alleen met purpose 'index' (RLS); de indexjob roept dit aan na elke push (HZW-060). */
export async function upsertContextIndex(db: Db, rows: ContextIndexRow[]) {
  if (!rows.length) return 0;
  return withPurpose(db, 'index', async (tx) => {
    for (const r of rows) {
      if (/(^|\/)admin\.md$/i.test(r.path)) throw new Error('admin.md hoort nooit in de index');
      await tx
        .insert(contextIndex)
        .values(r)
        .onConflictDoUpdate({ target: contextIndex.id, set: { ...r, updatedAt: new Date() } });
    }
    return rows.length;
  });
}

/** Full-text (dutch) met trigram-terugval op de titel. Lezen mag iedere ingelogde collega. */
export async function searchContextIndex(db: Db, userId: string, q: string, limit = 20) {
  return withUser(db, userId, (tx) =>
    tx
      .select({
        id: contextIndex.id,
        kind: contextIndex.kind,
        slug: contextIndex.slug,
        path: contextIndex.path,
        title: contextIndex.title,
      })
      .from(contextIndex)
      .where(sql`${contextIndex.tsv} @@ plainto_tsquery('dutch', ${q}) or ${contextIndex.title} % ${q}`)
      .orderBy(
        sql`ts_rank(${contextIndex.tsv}, plainto_tsquery('dutch', ${q})) desc, similarity(${contextIndex.title}, ${q}) desc`,
      )
      .limit(limit),
  );
}
