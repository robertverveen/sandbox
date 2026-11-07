/**
 * Datatoegang voor de API. Alles per gebruiker loopt via withUser (RLS). Inloggen en sessies opzoeken gaan via
 * SECURITY DEFINER-functies die precies één sleutel opzoeken (geen open SELECT op users of sessions).
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { withIndexer, withPurpose, withUser, withWorker, type Db, type Tx } from './client';
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
  trackerItems,
  weekdoelen,
} from './schema';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

type AuthUserRow = {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
  blocked_at: Date | string | null;
  created_at: Date | string;
};
const toUser = (r: AuthUserRow) => ({
  id: r.id,
  email: r.email,
  name: r.name,
  role: r.role,
  blockedAt: r.blocked_at ? new Date(r.blocked_at) : null,
  createdAt: new Date(r.created_at),
});
export type AuthUser = ReturnType<typeof toUser>;

/**
 * Inloggen en sessies lopen via SECURITY DEFINER-functies (drizzle/0006_e2_auth_functions.sql): de app-rol heeft
 * geen open SELECT op users of sessions. Elke functie zoekt precies één sleutel op. De transactie draait als hz_app.
 */
const asApp = <T>(db: Db, fn: (tx: Tx) => Promise<T>) => withPurpose(db, 'auth', fn);

/** Gebruiker bij precies één e-mailadres, of null. */
export async function findUserByEmail(db: Db, email: string): Promise<AuthUser | null> {
  return asApp(db, async (tx) => {
    const r = await tx.execute<AuthUserRow>(sql`select * from auth_user_by_email(${email})`);
    return r.rows[0] ? toUser(r.rows[0]) : null;
  });
}

/**
 * Gebruiker opzoeken of aanmaken (na de checks van de server). Altijd als 'member' en alleen voor een domein uit
 * auth_domains (standaard homezero.nl); anders faalt hij (42501). Admin wordt je alleen via sql/set-role.sql.
 */
export async function upsertUser(db: Db, email: string, name: string) {
  return asApp(db, async (tx) => {
    const r = await tx.execute<AuthUserRow>(sql`select * from auth_upsert_user(${email}, ${name})`);
    return toUser(r.rows[0]!);
  });
}

/** Sessie voor een bestaande gebruiker; het token zelf staat nergens, alleen de sha256-hash. */
export async function createSession(db: Db, userId: string, userAgent: string, days = 30) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + days * 864e5);
  await asApp(db, (tx) =>
    tx.execute(
      sql`select auth_create_session(${userId}::uuid, ${hashToken(token)}, ${userAgent}, ${expiresAt.toISOString()}::timestamptz)`,
    ),
  );
  return { token, expiresAt };
}

type AuthSessionRow = {
  session_id: string;
  user_id: string;
  expires_at: Date | string;
  created_at: Date | string;
  last_seen_at: Date | string;
  user_agent: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
};

/** Sessie bij een cookie-token: geldig, niet ingetrokken, niet verlopen, gebruiker niet geblokkeerd. */
export async function findSession(db: Db, token: string) {
  return asApp(db, async (tx) => {
    const r = (await tx.execute<AuthSessionRow>(sql`select * from auth_session_by_token(${hashToken(token)})`)).rows[0];
    if (!r) return null;
    return {
      session: {
        id: r.session_id,
        userId: r.user_id,
        userAgent: r.user_agent,
        createdAt: new Date(r.created_at),
        lastSeenAt: new Date(r.last_seen_at),
        expiresAt: new Date(r.expires_at),
      },
      user: { id: r.user_id, email: r.email, name: r.name, role: r.role, blockedAt: null },
    };
  });
}

/** Laatst gezien bijwerken en desgewenst de sessie verlengen. false als de sessie niet (meer) geldig is. */
export async function touchSession(db: Db, token: string, expiresAt?: Date) {
  return asApp(db, async (tx) => {
    const r = await tx.execute<{ ok: boolean }>(
      sql`select auth_touch_session(${hashToken(token)}, ${expiresAt ? expiresAt.toISOString() : null}::timestamptz) as ok`,
    );
    return r.rows[0]?.ok === true;
  });
}

export async function revokeSession(db: Db, token: string) {
  return asApp(db, async (tx) => {
    const r = await tx.execute<{ ok: boolean }>(sql`select auth_revoke_session(${hashToken(token)}) as ok`);
    return r.rows[0]?.ok === true;
  });
}

/**
 * Worker: id's van actieve collega's (geen e-mail of naam). Per id daarna withUser. Alleen als hz_worker (0010): de
 * worker-login (sql/worker-login.sql) kan dit, de api-login niet (42501).
 */
export async function activeUserIds(db: Db): Promise<string[]> {
  return withWorker(db, async (tx) => {
    const r = await tx.execute<{ id: string }>(sql`select id from system_active_user_ids() as id`);
    return r.rows.map((x) => x.id);
  });
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

/** Rij voor context_index_upsert (snake_case, zoals de kolommen). */
export const toIndexJson = (r: ContextIndexRow) => ({
  id: r.id,
  kind: r.kind,
  slug: r.slug ?? null,
  path: r.path,
  title: r.title,
  body: r.body ?? '',
  data: r.data ?? {},
  geheim_voor: r.geheimVoor ?? [],
  commit: r.commit ?? null,
});

/** Rijen schrijven via context_index_upsert; geeft de rijen terug die echt nieuw of gewijzigd zijn. */
export async function indexUpsertTx(tx: Tx, rows: ContextIndexRow[]) {
  if (!rows.length) return [];
  for (const r of rows)
    if (/(^|\/)admin\.md($|#)/i.test(r.path) || /(^|\/)admin\.md($|#)/i.test(r.id))
      throw new Error('admin.md hoort nooit in de index');
  const res = await tx.execute<{ row_id: string; was_inserted: boolean }>(
    sql`select row_id, was_inserted from context_index_upsert(${JSON.stringify(rows.map(toIndexJson))}::jsonb)`,
  );
  return res.rows.map((x) => ({ id: x.row_id, inserted: x.was_inserted }));
}

/**
 * Contextindex bijwerken (de indexjob na elke push, HZW-060). Alleen als hz_indexer: geef een verbinding van
 * createIndexerDb() (productie: HZ_INDEX_DATABASE_URL). De app-login kan dit niet (migratie 0009). admin.md weigert
 * zowel deze functie als de database zelf.
 */
export async function upsertContextIndex(db: Db, rows: ContextIndexRow[]) {
  if (!rows.length) return 0;
  return withIndexer(db, async (tx) => (await indexUpsertTx(tx, rows)).length);
}

/** Alle rijen van één bestand uit de index halen (bestand weg of hernoemd). Alleen als hz_indexer. */
export async function deleteContextIndexPath(db: Db, path: string) {
  return withIndexer(db, async (tx) => {
    const r = await tx.execute<{ n: number }>(sql`select context_index_delete(${path}) as n`);
    return r.rows[0]?.n ?? 0;
  });
}

/** Eén indexrij weghalen op zijn sleutel (een actie die uit acties.md verdween). Alleen als hz_indexer (0010). */
export async function deleteContextIndexId(db: Db, id: string) {
  return withIndexer(db, async (tx) => {
    const r = await tx.execute<{ n: number }>(sql`select context_index_delete_id(${id}) as n`);
    return r.rows[0]?.n ?? 0;
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

/* ---------- Tracker-items uit het prototype (HZW-021) ---------- */

export type TrackerItemRow = typeof trackerItems.$inferSelect;

/** Tracker-items van een collega (geïmporteerd uit de artifact-opslag), oudste eerst. */
export async function listTrackerItems(db: Db, userId: string) {
  return withUser(db, userId, (tx) =>
    tx.select().from(trackerItems).orderBy(asc(trackerItems.created), asc(trackerItems.createdAt)),
  );
}

/**
 * Zichtbaar in de tracker, zoals commitVisible() in het prototype: niet de oude canvas-items (sinds 5 nov in
 * wachten-op.md), niet wat al naar de repo is overgezet, en geen taak die al in Google Taken staat.
 */
export const trackerItemVisible = (
  r: Pick<TrackerItemRow, 'stroom' | 'overgezet' | 'gtask' | 'bron'> & { extra?: unknown },
) =>
  !(r.bron?.label === 'Canvas Wachten op' && (r.stroom === 'aan_mij' || r.stroom === 'bespreken')) &&
  !r.overgezet &&
  // gtask: de taak-id; extra.gtask: een koppeling uit het prototype zonder bruikbare id (die verbergt hij ook)
  !((r.stroom === 'mijn' || r.stroom === 'voornemen') && (r.gtask || hasExtraGtask(r.extra)));
const hasExtraGtask = (x: unknown) =>
  !!x && typeof x === 'object' && !Array.isArray(x) && !!(x as Record<string, unknown>).gtask;
