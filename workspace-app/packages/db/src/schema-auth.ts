/**
 * Tabellen van stuk E1 (inloggen en onboarding, HZW-010 t/m 014). Apart van schema.ts zodat de auth-migratie
 * (drizzle/0014_e1_auth.sql) los staat van het fundament. Gebruikt users, sessions en connections uit het fundament.
 *
 * RLS: zie 0014_e1_auth.sql en 0015_e1_auth_roles.sql. allowlist is voor de app dicht (alleen SECURITY DEFINER-functies: opzoeken bij
 * inloggen, beheer met een rolcontrole op app.user_id); auth_accounts alleen de eigen rij lezen; connect_flows en
 * onboarding per gebruiker. Geen GUC-doelen (app.purpose).
 */
import { index, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './schema';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** Uitnodigingslijst: wie mag inloggen (naast domein, hd en email_verified). E-mail altijd in kleine letters. */
export const allowlist = pgTable('allowlist', {
  email: text('email').primaryKey(),
  role: text('role', { enum: ['admin', 'member'] })
    .notNull()
    .default('member'),
  addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: ts('created_at').notNull().defaultNow(),
});

/** Google-account (sub) bij een gebruiker. Geen tokens: inloggen vraagt alleen naam en e-mail. */
export const authAccounts = pgTable(
  'auth_accounts',
  {
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] }), index('auth_accounts_user_idx').on(t.userId)],
);

/** Lopende OAuth-koppelingen per bron: state (gehasht) en PKCE-verifier, 10 minuten geldig. */
export const connectFlows = pgTable(
  'connect_flows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    stateHash: text('state_hash').notNull(),
    codeVerifier: text('code_verifier').notNull(),
    returnTo: text('return_to').notNull().default('/instellingen/koppelingen'),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [uniqueIndex('connect_flows_state_uq').on(t.stateHash)],
);

/** Stand van de onboarding-wizard per collega. */
export const onboarding = pgTable('onboarding', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  status: text('status', { enum: ['new', 'busy', 'later', 'done'] })
    .notNull()
    .default('new'),
  step: text('step').notNull().default('welkom'),
  steps: jsonb('steps').$type<Record<string, 'done' | 'skipped'>>().notNull().default({}),
  weekritme: jsonb('weekritme').$type<Record<string, unknown>>(),
  persRepo: text('pers_repo'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  completedAt: ts('completed_at'),
});

export const E1_PER_USER_TABLES = ['connect_flows', 'onboarding'] as const;
export const E1_TABLES = ['allowlist', 'auth_accounts', ...E1_PER_USER_TABLES] as const;
