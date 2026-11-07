-- Eenmalig per database, door een databasebeheerder (superuser, of CREATEROLE plus eigenaar van de database).
-- Maakt de login van pg-boss in de worker (HZ_BOSS_DATABASE_URL, stuk E2): eigenaar van alleen het schema van
-- pg-boss, geen lid van hz_app of van de migratierol, geen superuser en geen BYPASSRLS. Zo staat in het
-- worker-proces niet de credential van de tabeleigenaar; app-tabellen gaan via de app-login (DATABASE_URL).
--
--   psql -d <database> -v login=hz_boss -v password="$(openssl rand -base64 24)" -v schema=pgboss -f packages/db/sql/boss-login.sql
--   lokaal/CI (alleen tests): ... -v login=hz_boss -v password=hz_boss_test -v schema=pgboss ...
--
-- pg-boss draait bij elke start `CREATE SCHEMA IF NOT EXISTS <schema>`; Postgres controleert daarbij eerst het
-- recht CREATE op de database, ook als het schema al bestaat. Daarom krijgt deze login CREATE op de database (dan
-- kan hij alleen eigen, lege schema's maken) en is hij eigenaar van het schema. In schema public mag hij niets.
-- De worker weigert in productie een HZ_BOSS_DATABASE_URL waarvan de login eigenaar is van iets buiten dit schema.
-- Idempotent.
\set ON_ERROR_STOP on
\o /dev/null
SELECT set_config('hz.login', :'login', false), set_config('hz.password', :'password', false),
       set_config('hz.schema', :'schema', false);
\o
DO $$
DECLARE
  l text := current_setting('hz.login');
  pw text := current_setting('hz.password');
  s text := current_setting('hz.schema');
  extra text;
BEGIN
  IF l IN ('hz_app', 'hz_indexer', 'postgres') OR l !~ '^[a-z_][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'ongeldige loginnaam %', l;
  END IF;
  IF s IN ('public', 'pg_catalog', 'information_schema') OR s !~ '^[a-z_][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'ongeldige schemanaam %', s;
  END IF;
  IF length(pw) < 8 THEN
    RAISE EXCEPTION 'wachtwoord te kort (minimaal 8 tekens)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = l) THEN
    EXECUTE format('CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', l, pw);
  ELSE
    EXECUTE format('ALTER ROLE %I LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', l, pw);
  END IF;
  SELECT string_agg(g.rolname, ', ') INTO extra
    FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
   WHERE u.rolname = l;
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'login % is lid van %; de pg-boss-login hoort nergens lid van te zijn', l, extra;
  END IF;
  EXECUTE format('GRANT CONNECT, CREATE ON DATABASE %I TO %I', current_database(), l);
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = s) THEN
    EXECUTE format('CREATE SCHEMA %I AUTHORIZATION %I', s, l);
  ELSE
    EXECUTE format('ALTER SCHEMA %I OWNER TO %I', s, l);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
              WHERE r.rolname = l AND c.relnamespace <> s::regnamespace) THEN
    RAISE EXCEPTION 'login % is eigenaar van tabellen buiten schema %; dat mag niet', l, s;
  END IF;
END $$;
\o /dev/null
SELECT set_config('hz.password', '', false);
\o
