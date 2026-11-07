-- Rij-beveiliging (RLS) en zoekextensies. Handgeschreven; niet door drizzle-kit gegenereerd.
-- De app draait als rol zonder BYPASSRLS en zet per transactie SET LOCAL app.user_id
-- (via set_config('app.user_id', <uuid>, true)). FORCE zorgt dat ook de eigenaar van de tabellen
-- (de migratierol) aan de regels vastzit. Alleen superusers en BYPASSRLS-rollen omzeilen dit;
-- die gebruikt de app nooit (test: packages/db/test/rls.test.ts).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS unaccent;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS context_index_title_trgm_idx ON context_index USING gin (title gin_trgm_ops);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;
--> statement-breakpoint
-- Doel van een transactie zonder ingelogde gebruiker: 'auth' (inloggen, sessie opzoeken),
-- 'system' (worker plant jobs per gebruiker; alleen users lezen), 'index' (contextindex bijwerken).
CREATE OR REPLACE FUNCTION app_purpose() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.purpose', true), '')
$$;
--> statement-breakpoint
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE users FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY users_select ON users FOR SELECT USING (id = app_user_id() OR app_purpose() IN ('auth', 'system'));
--> statement-breakpoint
CREATE POLICY users_write ON users FOR ALL USING (id = app_user_id() OR app_purpose() = 'auth') WITH CHECK (id = app_user_id() OR app_purpose() = 'auth');
--> statement-breakpoint
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY sessions_own ON sessions FOR ALL USING (user_id = app_user_id() OR app_purpose() = 'auth') WITH CHECK (user_id = app_user_id() OR app_purpose() = 'auth');
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['connections', 'item_state', 'planning', 'weekdoelen', 'repo_queue', 'briefings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id())', t || '_own', t);
  END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY audit_insert ON audit_log FOR INSERT WITH CHECK (user_id = app_user_id() OR app_purpose() IN ('auth', 'system'));
--> statement-breakpoint
CREATE POLICY audit_select ON audit_log FOR SELECT USING (user_id = app_user_id());
--> statement-breakpoint
ALTER TABLE context_index ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE context_index FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY context_index_read ON context_index FOR SELECT USING (true);
--> statement-breakpoint
CREATE POLICY context_index_write ON context_index FOR ALL USING (app_purpose() = 'index') WITH CHECK (app_purpose() = 'index');
--> statement-breakpoint
-- Productie: een aparte app-rol zonder BYPASSRLS. Lokaal (hz_dev zonder CREATEROLE) wordt dit overgeslagen
-- en draait de app als hz_dev, die zelf geen superuser en geen BYPASSRLS is; FORCE houdt hem aan de regels.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hz_app')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolcreaterole OR rolsuper)) THEN
    CREATE ROLE hz_app NOLOGIN NOBYPASSRLS NOSUPERUSER;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hz_app') THEN
    GRANT USAGE ON SCHEMA public TO hz_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hz_app;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO hz_app;
    GRANT EXECUTE ON FUNCTION app_user_id(), app_purpose() TO hz_app;
  END IF;
END $$;
