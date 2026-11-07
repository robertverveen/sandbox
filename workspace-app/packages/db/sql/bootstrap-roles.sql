-- Eenmalig, door een databasebeheerder (superuser of rol met CREATEROLE), per Postgres-server.
-- Maakt de runtime-rol van de app aan: geen login, geen superuser, geen BYPASSRLS, eigenaar van niets.
-- De migratierol (lokaal en in CI: hz_dev) blijft eigenaar van alle tabellen en wordt lid van hz_app,
-- zodat withUser/withPurpose per transactie `SET LOCAL ROLE hz_app` kunnen doen.
--
--   lokaal:  sudo -u postgres psql -v migrator=hz_dev -f packages/db/sql/bootstrap-roles.sql
--   CI:      psql -h localhost -U postgres -v migrator=hz_dev -f packages/db/sql/bootstrap-roles.sql
--   productie: migrator = de migratierol; de login-rol van de app wordt alleen lid van hz_app (zie HUMAN_INPUT.md).
\set ON_ERROR_STOP on
SELECT set_config('hz.migrator', :'migrator', false);
DO $$
DECLARE m text := current_setting('hz.migrator');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hz_app') THEN
    CREATE ROLE hz_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  ALTER ROLE hz_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = m) THEN
    RAISE EXCEPTION 'migratierol % bestaat niet', m;
  END IF;
  EXECUTE format('GRANT hz_app TO %I', m);
END $$;
