#!/usr/bin/env bash
# Databaserollen van een instantie (HZW-020 op de server, HZW-008 voor back-ups). Draait als superuser:
# - in de Postgres-container automatisch bij de eerste start (/docker-entrypoint-initdb.d/10-hz-roles.sh);
# - lokaal of bij een verhuizing met HZ_PSQL_ADMIN_URL=postgres://postgres:...@host/postgres.
# Idempotent: opnieuw draaien zet attributen en wachtwoorden opnieuw.
#
# Rollen (namen instelbaar, zodat tests op een gedeelde Postgres niet botsen met andere rollen):
#   hz_migrator   LOGIN, eigenaar van de database en alle tabellen; draait migraties en pg-boss. Geen superuser/BYPASSRLS.
#   hz_app        NOLOGIN runtime-rol (packages/db/sql/bootstrap-roles.sql). Alle app-queries draaien hierin.
#   hz_app_login  LOGIN NOINHERIT, alleen lid van hz_app; DATABASE_URL van api en worker (packages/db/sql/app-login.sql).
#   hz_backup     LOGIN BYPASSRLS + pg_read_all_data, alleen lezen: pg_dump moet alle rijen zien (FORCE RLS geldt ook
#                 voor de eigenaar). Kan niets schrijven.
set -euo pipefail

db="${HZ_DB_NAME:-${POSTGRES_DB:-hz}}"
sqldir="${HZ_SQL_DIR:-/hz-sql}"
migrator="${HZ_PG_MIGRATOR_ROLE:-hz_migrator}"
app_login="${HZ_PG_APP_ROLE:-hz_app_login}"
backup="${HZ_PG_BACKUP_ROLE:-hz_backup}"
: "${HZ_PG_MIGRATOR_PASSWORD:?HZ_PG_MIGRATOR_PASSWORD ontbreekt}"
: "${HZ_PG_APP_PASSWORD:?HZ_PG_APP_PASSWORD ontbreekt}"
: "${HZ_PG_BACKUP_PASSWORD:?HZ_PG_BACKUP_PASSWORD ontbreekt}"

for r in "$migrator" "$app_login" "$backup"; do
  [[ "$r" =~ ^[a-z_][a-z0-9_]*$ && "$r" != hz_app && "$r" != postgres ]] || {
    echo "ongeldige rolnaam: $r" >&2
    exit 2
  }
done
[[ "$db" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "ongeldige databasenaam: $db" >&2; exit 2; }
[[ -f "$sqldir/bootstrap-roles.sql" ]] || { echo "bootstrap-roles.sql niet gevonden in $sqldir" >&2; exit 2; }

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

# 2. Runtime-rol hz_app (zelfde script als lokaal en in CI).
psql_admin "$db" -v migrator="$migrator" -f "$sqldir/bootstrap-roles.sql" >/dev/null

# 3. App-login: lid van alleen hz_app, NOINHERIT, eigenaar van niets.
if [[ -f "$sqldir/app-login.sql" ]]; then
  psql_admin "$db" -v login="$app_login" -v password="$HZ_PG_APP_PASSWORD" -f "$sqldir/app-login.sql" >/dev/null
else
  psql_admin "$db" -v role="$app_login" -v pw="$HZ_PG_APP_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN IN ROLE hz_app', :'role') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') \gexec
SELECT format('ALTER ROLE %I LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', :'role', :'pw') \gexec
SELECT format('GRANT hz_app TO %I', :'role') \gexec
SQL
fi

# 4. Back-uprol: leest alles (ook door RLS heen), schrijft niets.
psql_admin "$db" -v role="$backup" -v pw="$HZ_PG_BACKUP_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'role') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') \gexec
SELECT format('ALTER ROLE %I LOGIN BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', :'role', :'pw') \gexec
SELECT format('GRANT pg_read_all_data TO %I', :'role') \gexec
SQL

# 5. Wie mag verbinden.
psql_admin "$db" -v db="$db" -v m="$migrator" -v a="$app_login" -v b="$backup" <<'SQL'
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO %I, %I, %I', :'db', :'m', :'a', :'b') \gexec
SQL

echo "rollen klaar op $db: $migrator (eigenaar), hz_app (runtime), $app_login (app-login), $backup (back-up)"
