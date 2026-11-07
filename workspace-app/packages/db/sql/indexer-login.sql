-- Eenmalig, door een databasebeheerder (superuser of CREATEROLE), na bootstrap-roles.sql.
-- Maakt de login van de indexer (stuk E2, migratie 0009): de indexjob van de contextlaag en het importscript
-- (HZ_INDEX_DATABASE_URL) schrijven daarmee in de contextindex, via context_index_upsert/context_index_delete.
-- LOGIN, NOINHERIT, lid van alleen hz_indexer, eigenaar van niets, geen superuser en geen BYPASSRLS. De app-login
-- (hz_app_login) is geen lid van hz_indexer: een request kan de gedeelde index dus niet wijzigen.
--
--   lokaal:    sudo -u postgres psql -v login=hz_indexer_login -v password=hz_indexer_login -f packages/db/sql/indexer-login.sql
--   CI:        psql -h localhost -U postgres -v login=hz_indexer_login -v password=hz_indexer_login -f packages/db/sql/indexer-login.sql
--   productie: kies een sterk wachtwoord (openssl rand -base64 24) en zet de URL als HZ_INDEX_DATABASE_URL van de
--              worker (indexjob) en van het importscript.
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
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hz_indexer') THEN
    RAISE EXCEPTION 'rol hz_indexer ontbreekt; draai eerst packages/db/sql/bootstrap-roles.sql';
  END IF;
  IF l IN ('hz_indexer', 'hz_app', 'postgres') OR l !~ '^[a-z_][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'ongeldige loginnaam %', l;
  END IF;
  IF length(pw) < 8 THEN
    RAISE EXCEPTION 'wachtwoord te kort (minimaal 8 tekens)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = l) THEN
    EXECUTE format('CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L IN ROLE hz_indexer', l, pw);
  ELSE
    EXECUTE format('ALTER ROLE %I LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', l, pw);
    EXECUTE format('GRANT hz_indexer TO %I', l);
  END IF;
  SELECT string_agg(g.rolname, ', ') INTO extra
    FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
   WHERE u.rolname = l AND g.rolname <> 'hz_indexer';
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'login % is ook lid van %; alleen hz_indexer is toegestaan', l, extra;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = l) THEN
    RAISE EXCEPTION 'login % is eigenaar van tabellen; dat mag niet', l;
  END IF;
END $$;
\o /dev/null
SELECT set_config('hz.password', '', false);
\o
