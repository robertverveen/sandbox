-- Runtime-rol hz_app (HZW-020). Handgeschreven.
-- De migratierol (lokaal en in CI hz_dev) blijft eigenaar van alle tabellen. De app werkt als hz_app:
-- NOLOGIN, NOSUPERUSER, NOBYPASSRLS en eigenaar van niets. Daardoor kan de app RLS niet uitzetten
-- (ALTER TABLE ... NO FORCE ROW LEVEL SECURITY, DISABLE, DROP POLICY vereisen eigenaarschap).
-- withUser/withPurpose doen per transactie SET LOCAL ROLE hz_app; createDb() start elke verbinding als hz_app.
-- De rol zelf maakt een beheerder eenmalig aan: packages/db/sql/bootstrap-roles.sql.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hz_app') THEN
    RAISE EXCEPTION 'rol hz_app ontbreekt. Laat een beheerder eenmalig packages/db/sql/bootstrap-roles.sql draaien (zie README, Database).';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hz_app' AND (rolsuper OR rolbypassrls OR rolcanlogin)) THEN
    RAISE EXCEPTION 'rol hz_app mag geen superuser, BYPASSRLS of login hebben';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
             WHERE c.relnamespace = 'public'::regnamespace AND r.rolname = 'hz_app') THEN
    RAISE EXCEPTION 'hz_app mag geen eigenaar van tabellen zijn';
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['pins', 'preferences'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id())', t || '_own', t);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO hz_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hz_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hz_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_user_id(), app_purpose() TO hz_app;
--> statement-breakpoint
-- Nieuwe tabellen van latere migraties krijgen dezelfde rechten (niet meer: geen TRUNCATE, REFERENCES of TRIGGER).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hz_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO hz_app;
