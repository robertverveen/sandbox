-- Eenmalig, door een databasebeheerder (superuser of CREATEROLE), na bootstrap-roles.sql.
-- Maakt de login waarmee de app (api, en de worker voor app-tabellen) verbindt: LOGIN, NOINHERIT, lid van
-- alleen hz_app, eigenaar van niets, geen superuser en geen BYPASSRLS. Zonder SET ROLE hz_app heeft deze login
-- geen enkel tabelrecht (NOINHERIT); createDb() zet die rol bij elke verbinding (-c role=hz_app).
--
--   lokaal:    sudo -u postgres psql -v login=hz_app_login -v password=hz_app_login -f packages/db/sql/app-login.sql
--   CI:        psql -h localhost -U postgres -v login=hz_app_login -v password=hz_app_login -f packages/db/sql/app-login.sql
--   productie: kies een sterk wachtwoord (openssl rand -base64 24) en zet de URL als DATABASE_URL van api en worker.
--   TEMP:      voeg na de migraties -v db=<app-database> toe; het script controleert dan dat de login daar geen
--              tijdelijke tabellen mag maken (migratie 0013).
-- Idempotent: opnieuw draaien zet de attributen en het wachtwoord opnieuw.
\set ON_ERROR_STOP on
-- TEMP-controle (0013): geef -v db=<app-database> mee (na de migraties) om te controleren dat de login daar geen
-- tijdelijke tabellen mag maken. Zonder -v db controleert het script de database waarmee psql verbindt, behalve een
-- onderhoudsdatabase (postgres, template0/1): dan alleen een melding.
\if :{?db}
\set hz_db_given 1
\else
\set db :DBNAME
\set hz_db_given 0
\endif
\o /dev/null
SELECT set_config('hz.db', :'db', false), set_config('hz.db_given', :'hz_db_given', false);
\o
\o /dev/null
SELECT set_config('hz.login', :'login', false), set_config('hz.password', :'password', false);
\o
DO $$
DECLARE
  l text := current_setting('hz.login');
  pw text := current_setting('hz.password');
  extra text;
  d text;
  tmp text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hz_app') THEN
    RAISE EXCEPTION 'rol hz_app ontbreekt; draai eerst packages/db/sql/bootstrap-roles.sql';
  END IF;
  IF l IN ('hz_app', 'postgres') OR l !~ '^[a-z_][a-z0-9_]*$' THEN
    RAISE EXCEPTION 'ongeldige loginnaam %', l;
  END IF;
  IF length(pw) < 8 THEN
    RAISE EXCEPTION 'wachtwoord te kort (minimaal 8 tekens)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = l) THEN
    EXECUTE format('CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L IN ROLE hz_app', l, pw);
  ELSE
    EXECUTE format('ALTER ROLE %I LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', l, pw);
    EXECUTE format('GRANT hz_app TO %I', l);
  END IF;
  SELECT string_agg(g.rolname, ', ') INTO extra
    FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
   WHERE u.rolname = l AND g.rolname <> 'hz_app';
  IF extra IS NOT NULL THEN
    RAISE EXCEPTION 'login % is ook lid van %; alleen hz_app is toegestaan', l, extra;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = l) THEN
    RAISE EXCEPTION 'login % is eigenaar van tabellen; dat mag niet', l;
  END IF;
  -- Geen tijdelijke tabellen (0013): anders kan een request een app-tabel overschaduwen voor de volgende request.
  d := current_setting('hz.db');
  IF current_setting('hz.db_given') = '1' OR d NOT IN ('postgres', 'template0', 'template1') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = d) THEN
      RAISE EXCEPTION 'database % bestaat niet', d;
    END IF;
    SELECT string_agg(x.rolname, ', ') INTO tmp FROM pg_roles x
     WHERE (x.rolname = l OR pg_has_role(l, x.oid, 'MEMBER'))
       AND has_database_privilege(x.oid, d, 'TEMPORARY');
    IF tmp IS NOT NULL THEN
      RAISE EXCEPTION 'login % mag via % tijdelijke tabellen maken in database %; draai de migraties (0013) of REVOKE TEMPORARY ON DATABASE % FROM PUBLIC', l, tmp, d, d;
    END IF;
    RAISE NOTICE 'TEMP-controle: login % mag geen tijdelijke tabellen maken in database %', l, d;
  ELSE
    RAISE NOTICE 'TEMP-controle overgeslagen (onderhoudsdatabase %); draai opnieuw met -v db=<app-database> na de migraties', d;
  END IF;
END $$;
\o /dev/null
SELECT set_config('hz.password', '', false);
\o
