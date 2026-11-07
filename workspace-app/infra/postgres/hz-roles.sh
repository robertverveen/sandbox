#!/usr/bin/env bash
# Databaserollen van een instantie (HZW-020 op de server, HZW-008 voor back-ups). Draait als superuser:
# - in de Postgres-container automatisch bij de eerste start (/docker-entrypoint-initdb.d/10-hz-roles.sh);
# - lokaal of bij een verhuizing met HZ_PSQL_ADMIN_URL=postgres://postgres:...@host/postgres.
# Idempotent: opnieuw draaien zet attributen en wachtwoorden opnieuw.
#
# Rollen (namen instelbaar, zodat tests op een gedeelde Postgres niet botsen met andere rollen):
#   hz_migrator   LOGIN, eigenaar van de database en alle tabellen; draait migraties en pg-boss. Geen superuser/BYPASSRLS.
#   hz_app        NOLOGIN runtime-rol (packages/db/sql/bootstrap-roles.sql). Alle app-queries draaien hierin.
#   hz_app_login  LOGIN NOINHERIT, alleen lid van hz_app; DATABASE_URL van de api (packages/db/sql/app-login.sql).
#   hz_auth_login LOGIN NOINHERIT, alleen lid van hz_auth: inloggen en sessies; HZ_AUTH_DATABASE_URL van de api
#                 (packages/db/sql/auth-login.sql, stuk E2, migratie 0011).
#   hz_worker_login LOGIN NOINHERIT, lid van hz_app en hz_worker: DATABASE_URL van de worker (werkt namens collega's,
#                 packages/db/sql/worker-login.sql, migratie 0010).
#   hz_indexer_login LOGIN NOINHERIT, alleen lid van hz_indexer: HZ_INDEX_DATABASE_URL van de indexjob en het
#                 importscript (packages/db/sql/indexer-login.sql, migratie 0009).
#   hz_boss       LOGIN, eigenaar van alleen het schema van pg-boss: HZ_BOSS_DATABASE_URL van de worker
#                 (packages/db/sql/boss-login.sql).
#   hz_backup     LOGIN BYPASSRLS + pg_read_all_data, alleen lezen: pg_dump moet alle rijen zien (FORCE RLS geldt ook
#                 voor de eigenaar). Kan niets schrijven.
# Geen enkele login mag tijdelijke tabellen maken (migratie 0013): CONNECT wel, TEMPORARY nooit.
set -euo pipefail

db="${HZ_DB_NAME:-${POSTGRES_DB:-hz}}"
sqldir="${HZ_SQL_DIR:-/hz-sql}"
migrator="${HZ_PG_MIGRATOR_ROLE:-hz_migrator}"
app_login="${HZ_PG_APP_ROLE:-hz_app_login}"
backup="${HZ_PG_BACKUP_ROLE:-hz_backup}"
auth_login="${HZ_PG_AUTH_ROLE:-hz_auth_login}"
worker_login="${HZ_PG_WORKER_ROLE:-hz_worker_login}"
indexer_login="${HZ_PG_INDEXER_ROLE:-hz_indexer_login}"
boss="${HZ_PG_BOSS_ROLE:-hz_boss}"
boss_schema="${HZ_BOSS_SCHEMA:-pgboss}"
: "${HZ_PG_MIGRATOR_PASSWORD:?HZ_PG_MIGRATOR_PASSWORD ontbreekt}"
: "${HZ_PG_APP_PASSWORD:?HZ_PG_APP_PASSWORD ontbreekt}"
: "${HZ_PG_BACKUP_PASSWORD:?HZ_PG_BACKUP_PASSWORD ontbreekt}"
: "${HZ_PG_AUTH_PASSWORD:?HZ_PG_AUTH_PASSWORD ontbreekt}"
: "${HZ_PG_WORKER_PASSWORD:?HZ_PG_WORKER_PASSWORD ontbreekt}"
: "${HZ_PG_INDEXER_PASSWORD:?HZ_PG_INDEXER_PASSWORD ontbreekt}"
: "${HZ_PG_BOSS_PASSWORD:?HZ_PG_BOSS_PASSWORD ontbreekt}"

for r in "$migrator" "$app_login" "$backup" "$auth_login" "$worker_login" "$indexer_login" "$boss"; do
  [[ "$r" =~ ^[a-z_][a-z0-9_]*$ && ! "$r" =~ ^(hz_app|hz_auth|hz_worker|hz_indexer|postgres)$ ]] || {
    echo "ongeldige rolnaam: $r" >&2
    exit 2
  }
done
[[ "$db" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "ongeldige databasenaam: $db" >&2; exit 2; }
[[ "$boss_schema" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "ongeldige schemanaam: $boss_schema" >&2; exit 2; }
for f in bootstrap-roles app-login auth-login worker-login indexer-login boss-login; do
  [[ -f "$sqldir/$f.sql" ]] || { echo "$f.sql niet gevonden in $sqldir" >&2; exit 2; }
done

# psql als superuser op database $1: via HZ_PSQL_ADMIN_URL (database daarin vervangen) of de lokale socket.
psql_admin() {
  local target="$1"
  shift
  export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"
  if [[ -n "${HZ_PSQL_ADMIN_URL:-}" ]]; then
    local base="${HZ_PSQL_ADMIN_URL%%\?*}" query=""
    [[ "$HZ_PSQL_ADMIN_URL" == *\?* ]] && query="?${HZ_PSQL_ADMIN_URL#*\?}"
    [[ "$base" =~ ^(postgres(ql)?://[^/]*) ]] || { echo "HZ_PSQL_ADMIN_URL ongeldig" >&2; exit 2; }
    psql "${BASH_REMATCH[1]}/$target$query" -X -q -v ON_ERROR_STOP=1 "$@"
  else
    psql --username "${POSTGRES_USER:-postgres}" --dbname "$target" -X -q -v ON_ERROR_STOP=1 "$@"
  fi
}

# 1. Migratierol, eigenaar van de database (mag schema's maken: public-tabellen en pgboss).
psql_admin "$db" -v role="$migrator" -v pw="$HZ_PG_MIGRATOR_PASSWORD" -v db="$db" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'role') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') \gexec
SELECT format('ALTER ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', :'role', :'pw') \gexec
SELECT format('ALTER DATABASE %I OWNER TO %I', :'db', :'role') \gexec
SELECT format('ALTER SCHEMA public OWNER TO %I', :'role') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db') \gexec
SQL

# 1b. Geen tijdelijke tabellen voor de logins (0013). Een eerdere versie van dit script gaf TEMPORARY; weghalen.
psql_admin "$db" -v db="$db" -v roles="$app_login,$auth_login,$worker_login,$indexer_login,$boss,$backup" <<'SQL'
SELECT format('REVOKE TEMPORARY ON DATABASE %I FROM %I', :'db', r) FROM unnest(string_to_array(:'roles', ',')) r
 WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec
SQL

# 2. Groepsrollen hz_app, hz_auth, hz_worker en hz_indexer (zelfde script als lokaal en in CI).
psql_admin "$db" -v migrator="$migrator" -f "$sqldir/bootstrap-roles.sql" >/dev/null

# 3. Logins met elk één doel (stuk E2): eigenaar van niets, geen superuser, geen BYPASSRLS, geen TEMP. De scripts
#    controleren zelf het lidmaatschap en weigeren als een login ergens anders lid of eigenaar van is.
psql_admin "$db" -v login="$app_login" -v password="$HZ_PG_APP_PASSWORD" -f "$sqldir/app-login.sql" >/dev/null
psql_admin "$db" -v login="$auth_login" -v password="$HZ_PG_AUTH_PASSWORD" -f "$sqldir/auth-login.sql" >/dev/null
psql_admin "$db" -v login="$worker_login" -v password="$HZ_PG_WORKER_PASSWORD" -f "$sqldir/worker-login.sql" >/dev/null
psql_admin "$db" -v login="$indexer_login" -v password="$HZ_PG_INDEXER_PASSWORD" -f "$sqldir/indexer-login.sql" >/dev/null
psql_admin "$db" -v login="$boss" -v password="$HZ_PG_BOSS_PASSWORD" -v schema="$boss_schema" -f "$sqldir/boss-login.sql" >/dev/null
# 3b. Na een herstel (pg_restore --no-owner --role <migratierol>) zijn de objecten van pg-boss van de migratierol; dan
#     kan pg-boss ze als zijn eigen login niet gebruiken. Terug naar de pg-boss-login (niets te doen = niets gebeurt).
psql_admin "$db" -v boss="$boss" -v s="$boss_schema" <<'SQL'
SELECT format('ALTER %s %I.%I OWNER TO %I', CASE c.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' ELSE 'TABLE' END,
              n.nspname, c.relname, :'boss')
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = :'s' AND c.relkind IN ('r', 'p', 'v', 'S') AND pg_get_userbyid(c.relowner) <> :'boss'
   AND NOT (c.relkind = 'S' AND EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i')))
 ORDER BY c.relkind DESC \gexec
SELECT format('ALTER FUNCTION %s OWNER TO %I', p.oid::regprocedure, :'boss')
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = :'s' AND pg_get_userbyid(p.proowner) <> :'boss' \gexec
SELECT format('ALTER TYPE %I.%I OWNER TO %I', n.nspname, t.typname, :'boss')
  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
 WHERE n.nspname = :'s' AND t.typtype IN ('e', 'd') AND pg_get_userbyid(t.typowner) <> :'boss' \gexec
SQL

# 4. Back-uprol: leest alles (ook door RLS heen), schrijft niets.
psql_admin "$db" -v role="$backup" -v pw="$HZ_PG_BACKUP_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'role') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') \gexec
SELECT format('ALTER ROLE %I LOGIN BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', :'role', :'pw') \gexec
SELECT format('GRANT pg_read_all_data TO %I', :'role') \gexec
SQL

# 5. Wie mag verbinden (geen TEMPORARY: zie 1b).
psql_admin "$db" -v db="$db" -v roles="$migrator,$app_login,$auth_login,$worker_login,$indexer_login,$boss,$backup" <<'SQL'
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'db', r) FROM unnest(string_to_array(:'roles', ',')) r \gexec
SQL

echo "rollen klaar op $db: $migrator (eigenaar), hz_app (runtime), $app_login (api), $auth_login (inloggen)," \
  "$worker_login (worker), $indexer_login (index), $boss (pg-boss), $backup (back-up)"
