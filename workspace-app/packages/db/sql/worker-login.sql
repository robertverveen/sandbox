-- Eenmalig, door een databasebeheerder (superuser of CREATEROLE), na bootstrap-roles.sql.
-- Maakt de login waarmee de worker app-tabellen gebruikt (DATABASE_URL van de worker, stuk E2, migratie 0010):
-- LOGIN, NOINHERIT, lid van hz_app (werken onder RLS met withUser) en hz_worker (alleen: system_active_user_ids(),
-- de id's van actieve collega's om per collega een job te plannen). Eigenaar van niets, geen superuser, geen BYPASSRLS.
-- De api gebruikt een andere login (sql/app-login.sql, alleen hz_app): een request kan dus geen gebruikers-id's
-- opvragen.
--
--   lokaal:    sudo -u postgres psql -v login=hz_worker_login -v password=hz_worker_login -f packages/db/sql/worker-login.sql
--   CI:        psql -h localhost -U postgres -v login=hz_worker_login -v password=hz_worker_login -f packages/db/sql/worker-login.sql
--   productie: kies een sterk wachtwoord (openssl rand -base64 24) en zet de URL als DATABASE_URL van de worker.
-- Idempotent: opnieuw draaien zet de attributen en het wachtwoord opnieuw.
\set ON_ERROR_STOP on
\o /dev/null
SELECT set_config('hz.login', :'login', false), set_config('hz.password', :'password', false);
\o
DO $$
DECLARE
  l text := current_setting('hz.login');
  pw text := current_setting('hz.password');
  extra text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hz_app') OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hz_worker') THEN
    RAISE EXCEPTION 'rol hz_app of hz_worker ontbreekt; draai eerst packages/db/sql/bootstrap-roles.sql';
  END IF;
  IF l IN ('hz_app', 'hz_worker', 'hz_indexer', 'postgres') OR l !~ '^[a-z_][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'ongeldige loginnaam %', l;
  END IF;
  IF length(pw) < 8 THEN
    RAISE EXCEPTION 'wachtwoord te kort (minimaal 8 tekens)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = l) THEN
    EXECUTE format('CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L IN ROLE hz_app, hz_worker', l, pw);
  ELSE
    EXECUTE format('ALTER ROLE %I LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', l, pw);
    EXECUTE format('GRANT hz_app, hz_worker TO %I', l);
  END IF;
  SELECT string_agg(g.rolname, ', ') INTO extra
    FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
   WHERE u.rolname = l AND g.rolname NOT IN ('hz_app', 'hz_worker');
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'login % is ook lid van %; alleen hz_app en hz_worker zijn toegestaan', l, extra;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = l) THEN
    RAISE EXCEPTION 'login % is eigenaar van tabellen; dat mag niet', l;
  END IF;
END $$;
\o /dev/null
SELECT set_config('hz.password', '', false);
\o
