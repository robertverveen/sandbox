-- Eenmalig, door een databasebeheerder (superuser of rol met CREATEROLE), per Postgres-server.
-- Maakt de runtime-rol van de app aan: geen login, geen superuser, geen BYPASSRLS, eigenaar van niets.
-- En de rollen hz_indexer (schrijven in de contextindex, alleen via SECURITY DEFINER-functies) en hz_worker
-- (id's van actieve collega's voor de worker). Idempotent.
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
  -- hz_indexer (stuk E2, migratie 0009): de enige rol die in de contextindex mag schrijven, via
  -- context_index_upsert/context_index_delete. NOLOGIN; de indexer verbindt met een eigen login die lid is
  -- (sql/indexer-login.sql). De migratierol wordt lid voor beheer en tests.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hz_indexer') THEN
    CREATE ROLE hz_indexer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  ALTER ROLE hz_indexer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  EXECUTE format('GRANT hz_indexer TO %I', m);
  -- hz_worker (stuk E2, migratie 0010): de enige rol die system_active_user_ids() mag uitvoeren (de id's van alle
  -- actieve collega's). NOLOGIN, geen tabelrechten; de worker verbindt met een eigen login die lid is van hz_app en
  -- hz_worker (sql/worker-login.sql). De api-login niet. De migratierol wordt lid voor beheer en tests.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hz_worker') THEN
    CREATE ROLE hz_worker NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  ALTER ROLE hz_worker NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  EXECUTE format('GRANT hz_worker TO %I', m);
END $$;
