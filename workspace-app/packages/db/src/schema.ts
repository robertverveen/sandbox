/**
 * Databaseschema (Postgres 16, Drizzle). De app bewaart alleen wat nergens anders staat:
 * leesstatus en planning (item_state), weekdoelen, tracker-items uit het prototype (tracker_items), briefings, vastgezette zoekopdrachten, voorkeuren, koppelingen (tokens versleuteld), sessies,
 * de wachtrij naar de repo's, het auditlog en de zoekindex van de contextlaag.
 * Niet: mailtekst, Slack-geschiedenis, acties (acties.md), taken (Google Taken of taken.md).
 *
 * Rij-beveiliging (RLS) staat in drizzle/0001_rls.sql en 0004_app_role.sql: elke tabel met user_id ziet alleen de rijen
 * van `app.user_id` (gezet per transactie met SET LOCAL via set_config(..., true)).
 */
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull().default(''),
    role: text('role', { enum: ['admin', 'member'] })
      .notNull()
      .default('member'),
    blockedAt: ts('blocked_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_uq').on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** sha256 van het cookie-token; het token zelf staat nergens. */
    tokenHash: text('token_hash').notNull(),
    userAgent: text('user_agent').notNull().default(''),
    createdAt: ts('created_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [uniqueIndex('sessions_token_uq').on(t.tokenHash), index('sessions_user_idx').on(t.userId)],
);

/** Koppelingen per collega. Token envelope-versleuteld (zie crypto.ts); nooit in de browser. */
export const connections = pgTable(
  'connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    status: text('status', { enum: ['connected', 'disconnected', 'error', 'needs_reauth'] })
      .notNull()
      .default('connected'),
    scopes: text('scopes')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    account: text('account'),
    tokenCiphertext: text('token_ciphertext'),
    tokenIv: text('token_iv'),
    tokenTag: text('token_tag'),
    dekWrapped: text('dek_wrapped'),
    keyVersion: integer('key_version').notNull().default(1),
    connectedAt: ts('connected_at').notNull().defaultNow(),
    lastSyncAt: ts('last_sync_at'),
    error: text('error'),
  },
  (t) => [uniqueIndex('connections_user_provider_uq').on(t.userId, t.provider)],
);

/**
 * Leesstatus, verwerkt-vlaggen en planning per item (alleen in de app). PUT /api/itemstate/:key schrijft hier;
 * Google Taken houden hun eigen datum (TasksProvider), dit is voor items die geen taak zijn.
 */
export const itemState = pgTable(
  'item_state',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    itemKey: text('item_key').notNull(),
    read: boolean('read').notNull().default(false),
    readAt: ts('read_at'),
    processed: boolean('processed').notNull().default(false),
    skipPrep: boolean('skip_prep').notNull().default(false),
    answeredBy: text('answered_by'),
    /** Planning (1–5 in Inhalen, Plansessie): dag of backlog. Eén plek voor de planning: deze tabel. */
    planDate: date('plan_date'),
    backlog: boolean('backlog').notNull().default(false),
    /** Hoe vaak doorgeschoven. */
    moved: integer('moved').notNull().default(0),
    extra: jsonb('extra').$type<Record<string, unknown>>().notNull().default({}),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.itemKey] })],
);

export const weekdoelen = pgTable(
  'weekdoelen',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    soort: text('soort', { enum: ['weekdoel', 'roadmap'] })
      .notNull()
      .default('weekdoel'),
    week: text('week'),
    wat: text('wat').notNull(),
    deadline: date('deadline'),
    status: text('status').notNull().default('open'),
    health: text('health'),
    outcome: text('outcome'),
    checks: jsonb('checks').$type<Array<{ d: string; h: string; note?: string }>>().notNull().default([]),
    closedAt: date('closed_at'),
    bron: jsonb('bron').$type<{ label: string; url?: string }>(),
    /** Doc-id uit de artifact-opslag van het prototype (import HZW-021); leeg voor doelen uit de app. */
    legacyId: text('legacy_id'),
    /** Velden uit het prototype zonder eigen kolom (outcomeNote, lastCheck, …); niets gaat verloren bij import. */
    extra: jsonb('extra').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: ts('created_at').notNull().defaultNow(),
    /** Laatste wijziging. Een trigger zet dit bij elke UPDATE (0007), ook als de app het vergeet. */
    updatedAt: ts('updated_at').notNull().defaultNow(),
    /**
     * Moment van de laatste import van deze rij (HZW-021). updated_at > imported_at = in de app gewijzigd sinds de
     * import; dan laat een volgende import de rij staan (de app wint).
     */
    importedAt: ts('imported_at'),
  },
  (t) => [
    index('weekdoelen_user_week_idx').on(t.userId, t.week),
    uniqueIndex('weekdoelen_user_legacy_uq').on(t.userId, t.legacyId),
  ],
);

/**
 * Tracker-items die (nog) nergens anders staan: de toezeggingen uit de artifact-opslag van het prototype
 * (collectie commitments: Ik beloofde, Eigen voornemen, Wachten op, Bespreken). Keuze 10: geen eigen takenlijst;
 * nieuwe taken gaan naar Google Taken of taken.md, wachten op en bespreken naar wachten-op.md. Deze tabel houdt
 * wat al bestond en wat nog niet is overgezet (`overgezet`), zodat de collega zijn tracker terugziet (HZW-021).
 * Weekdoelen en roadmapdoelen staan in `weekdoelen`.
 */
export const trackerItems = pgTable(
  'tracker_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Doc-id uit de artifact-opslag (commitments/<id>); uniek per gebruiker, maakt de import idempotent. */
    legacyId: text('legacy_id'),
    stroom: text('stroom', { enum: ['mijn', 'voornemen', 'aan_mij', 'bespreken'] }).notNull(),
    wat: text('wat').notNull(),
    aan: text('aan').notNull().default(''),
    org: text('org').notNull().default(''),
    status: text('status', {
      enum: ['open', 'waarschijnlijk_klaar', 'klaar', 'te_laat', 'overgedragen', 'losgelaten'],
    })
      .notNull()
      .default('open'),
    deadline: date('deadline'),
    /** Planning (1–5): dag of backlog, zoals item_state voor andere items. */
    planDate: date('plan_date'),
    backlog: boolean('backlog').notNull().default(false),
    moved: integer('moved').notNull().default(0),
    reminder: date('reminder'),
    /** Bestemming in de Persoonlijk-repo (taken.md, wachten-op.md) zolang hij nog niet is overgezet. */
    naar: text('naar'),
    overgezet: boolean('overgezet').notNull().default(false),
    /** Gekoppelde Google Taak (dan toont de tracker de taak, niet dit item). */
    gtask: text('gtask'),
    /** Item-sleutel van de bron (Slack-bericht, mail) waaruit dit item ontstond. */
    srcKey: text('src_key'),
    bron: jsonb('bron').$type<{ label: string; url?: string | null; key?: string }>(),
    citaat: text('citaat').notNull().default(''),
    bewijs: text('bewijs'),
    /** Dag waarop het item ontstond (prototype: created). */
    created: date('created'),
    closedAt: date('closed_at'),
    extra: jsonb('extra').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: ts('created_at').notNull().defaultNow(),
    /** Laatste wijziging; een trigger zet dit bij elke UPDATE (0007). */
    updatedAt: ts('updated_at').notNull().defaultNow(),
    /** Moment van de laatste import (zie weekdoelen.importedAt): updated_at > imported_at = de app wint. */
    importedAt: ts('imported_at'),
  },
  (t) => [
    uniqueIndex('tracker_items_user_legacy_uq').on(t.userId, t.legacyId),
    index('tracker_items_user_status_idx').on(t.userId, t.status),
  ],
);

/**
 * Wachtrij naar de repo's: regels die nog naar de contextlaag of de Persoonlijk-repo moeten.
 * Gevuld door POST /api/repo/queue (fundament: regel opmaken volgens _systeem/schema.md en in de rij zetten);
 * verwerkt door de schrijfjob van het context-stuk (HZW-060/062: git pull --rebase, contextcheck --push,
 * status pushed/blocked/failed). Tot die job er is blijft elke rij 'queued'.
 */
export const repoQueue = pgTable(
  'repo_queue',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    repo: text('repo', { enum: ['context', 'persoonlijk'] }).notNull(),
    /** Wat de collega deed: wachten-op, bespreken, partneractie of meeting (zie RepoWrite in @hz/shared). */
    kind: text('kind', { enum: ['wachten-op', 'bespreken', 'partneractie', 'meeting'] }).notNull(),
    /** Partner- of projectslug (alleen uit het register). */
    slug: text('slug'),
    path: text('path').notNull(),
    op: text('op', { enum: ['append', 'check', 'uncheck', 'strike', 'new-file'] }).notNull(),
    line: text('line').notNull(),
    status: text('status', { enum: ['queued', 'pushed', 'blocked', 'failed'] })
      .notNull()
      .default('queued'),
    /** Commit-sha na een geslaagde push. */
    commitSha: text('commit_sha'),
    checkExit: integer('check_exit'),
    error: text('error'),
    createdAt: ts('created_at').notNull().defaultNow(),
    processedAt: ts('processed_at'),
  },
  (t) => [index('repo_queue_status_idx').on(t.status, t.createdAt)],
);

export const briefings = pgTable(
  'briefings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    title: text('title').notNull(),
    sections: jsonb('sections')
      .$type<Array<{ title: string; items: Array<{ text: string; url?: string }> }>>()
      .notNull(),
    session: text('session'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('briefings_user_date_uq').on(t.userId, t.date)],
);

/** Vastgezette zoekopdrachten en views (⌘K-palet: vastzetten; zijbalk onder Gesprekken). */
export const pins = pgTable(
  'pins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['search', 'view'] }).notNull(),
    label: text('label').notNull(),
    /** Zoekopdracht met komma-verfijning, bv. "feenstra, offerte, tijdlijn". */
    q: text('q'),
    /** Route van een view, bv. "/tracker?tab=wachten". */
    view: text('view'),
    position: integer('position').notNull().default(0),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('pins_user_idx').on(t.userId, t.position)],
);

/** Voorkeuren per collega: thema en per agenda kleur en zichtbaarheid ('overal' of 'alleen in Agenda'). */
export const preferences = pgTable('preferences', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  theme: text('theme', { enum: ['system', 'light', 'dark'] })
    .notNull()
    .default('system'),
  calendars: jsonb('calendars')
    .$type<Record<string, { color?: string; scope?: 'overal' | 'agenda'; hidden?: boolean }>>()
    .notNull()
    .default({}),
  extra: jsonb('extra').$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/** Auditlog van gevoelige acties (inloggen, koppelen, versturen, schrijven naar de repo). Geen inhoud. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    target: text('target'),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    at: ts('at').notNull().defaultNow(),
  },
  (t) => [index('audit_user_at_idx').on(t.userId, t.at)],
);

/**
 * Zoekindex van de contextlaag (gedeelde bedrijfsdata, geen user_id): register, brief, acties als rijen,
 * meetings. Full-text (dutch) + pg_trgm; geen embeddings (open vraag, na de pilot). Nooit admin.md.
 * Gevuld door de indexjob van het context-stuk (HZW-060, webhook op push, withPurpose('index'));
 * gelezen door het zoek-stuk (HZW-070). In het fundament: schema, RLS en upsertContextIndex/searchContextIndex.
 */
export const contextIndex = pgTable(
  'context_index',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['partner', 'project', 'actie', 'meeting', 'besluit', 'product', 'overig'] }).notNull(),
    slug: text('slug'),
    path: text('path').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    geheimVoor: text('geheim_voor')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    commit: text('commit'),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    tsv: tsvector('tsv').generatedAlwaysAs(
      sql`to_tsvector('dutch'::regconfig, coalesce(title, '') || ' ' || coalesce(body, ''))`,
    ),
  },
  (t) => [index('context_index_slug_idx').on(t.slug), index('context_index_tsv_idx').using('gin', t.tsv)],
);

/**
 * Welke sleutels de import van het prototype (HZW-021) per collega al eens schreef. Zo zet een volgende import
 * niets terug wat de collega in de app heeft verwijderd (een weekdoel, een vastgezette zoekopdracht).
 */
export const importKeys = pgTable(
  'import_keys',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Doeltabel: tracker_items, weekdoelen, pins of briefings. */
    tabel: text('tabel').notNull(),
    /** Sleutel in die tabel: legacy_id, zoekopdracht of dag. */
    sleutel: text('sleutel').notNull(),
    importedAt: ts('imported_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.tabel, t.sleutel] })],
);

/**
 * Toegestane e-maildomeinen voor nieuwe gebruikers (0008). Alleen de SECURITY DEFINER-functies auth_upsert_user en
 * auth_create_session lezen hem; hz_app heeft er geen rechten op. Een domein toevoegen doet een beheerder als de
 * migratierol (README, "Inloggen en de auth-bibliotheek").
 */
export const authDomains = pgTable('auth_domains', {
  domain: text('domain').primaryKey(),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** Tabellen met user_id: die vallen onder de per-collega RLS-regel. */
export const PER_USER_TABLES = [
  'connections',
  'item_state',
  'weekdoelen',
  'repo_queue',
  'briefings',
  'pins',
  'preferences',
  'tracker_items',
  'import_keys',
] as const;
export const ALL_TABLES = ['users', 'sessions', ...PER_USER_TABLES, 'audit_log', 'context_index'] as const;
