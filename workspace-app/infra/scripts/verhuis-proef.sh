#!/usr/bin/env bash
# Proefverhuizing (HZW-082): de database van de huidige server via een back-up naar een "nieuwe server" brengen en
# de app daar laten draaien op een ander domein, zonder codewijziging. Lokaal (twee databases op één Postgres) en
# bij een echte verhuizing (nieuwe Hetzner-server, zie RUNBOOK.md) dezelfde stappen:
#
#   1. back-up van de oude database (backup.sh; versleuteld, met controlesom)
#   2. nieuwe database met dezelfde rollen (hz-roles.sh, nieuwe wachtwoorden)
#   3. herstel met rechten, objecten van de migratierol (restore.sh --role)
#   4. migraties op de nieuwe database: moet niets meer te doen hebben
#   5. rijen per tabel oud en nieuw gelijk
#   6. de gebouwde API (zelfde code als het image) start in productiemodus op het nieuwe domein: /api/health groen
#
# Omgeving:
#   HZ_PSQL_ADMIN_URL           superuser op de nieuwe Postgres, database 'postgres'
#   HZ_VERHUIS_SRC_DSN          oude database, als back-uprol (BYPASSRLS), bijv. postgres://hz_backup:...@oud/hz
#   HZ_VERHUIS_DOMAIN           het nieuwe domein (bijv. workspace.homezero.nl)
#   HZ_VERHUIS_API_DIR          map uit infra/docker/build-app.sh api (dist/index.js, dist/migrate.js)
#   HZ_VERHUIS_NEW_DB           naam van de nieuwe database (standaard hz_verhuis_<tijd>)
#   HZ_SQL_DIR                  packages/db/sql (rollen)
#   HZ_PG_MIGRATOR_ROLE, HZ_PG_APP_ROLE, HZ_PG_BACKUP_ROLE   rolnamen (standaard hz_migrator, hz_app_login, hz_backup)
#   HZ_PG_AUTH_ROLE, HZ_PG_WORKER_ROLE, HZ_PG_INDEXER_ROLE, HZ_PG_BOSS_ROLE   (standaard hz_auth_login, hz_worker_login,
#                               hz_indexer_login, hz_boss; zie hz-roles.sh)
#   HZ_VERHUIS_PORT             poort voor de proefstart van de API (standaard de eerste vrije vanaf 8701)
#   HZ_VERHUIS_KEEP=1           nieuwe database laten staan
set -euo pipefail
HZ_SCRIPT=verhuis-proef
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$here/lib.sh"
need psql pg_dump pg_restore node openssl "$HZ_AGE" age-keygen

admin="${HZ_PSQL_ADMIN_URL:?HZ_PSQL_ADMIN_URL ontbreekt}"
src="${HZ_VERHUIS_SRC_DSN:?HZ_VERHUIS_SRC_DSN ontbreekt}"
domain="${HZ_VERHUIS_DOMAIN:?HZ_VERHUIS_DOMAIN ontbreekt}"
apidir="${HZ_VERHUIS_API_DIR:?HZ_VERHUIS_API_DIR ontbreekt}"
newdb="${HZ_VERHUIS_NEW_DB:-hz_verhuis_$(date -u +%Y%m%d%H%M%S)}"
migrator="${HZ_PG_MIGRATOR_ROLE:-hz_migrator}"
app_login="${HZ_PG_APP_ROLE:-hz_app_login}"
auth_login="${HZ_PG_AUTH_ROLE:-hz_auth_login}"
boss_schema="${HZ_BOSS_SCHEMA:-pgboss}"
[[ "$newdb" =~ ^[a-z_][a-z0-9_]*$ ]] || die "ongeldige databasenaam"
[[ -f "$apidir/dist/index.js" && -f "$apidir/dist/migrate.js" ]] || die "geen gebouwde API in $apidir (infra/docker/build-app.sh api <map>)"

work="$(mktemp -d "${TMPDIR:-/tmp}/hz-verhuis.XXXXXX")"
api_pid=""
cleanup() {
  [[ -n "$api_pid" ]] && kill "$api_pid" 2>/dev/null && wait "$api_pid" 2>/dev/null
  rm -rf "$work"
  if [[ "${HZ_VERHUIS_KEEP:-0}" != 1 ]]; then
    psql "$admin" -X -q -c "DROP DATABASE IF EXISTS $newdb WITH (FORCE)" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$*" >&2; }
pw() { openssl rand -hex 24; }

# Eigen sleutel voor deze proef (op een echte nieuwe server: de server-sleutel uit cloud-init).
age-keygen -o "$work/age.key" 2>/dev/null
age-keygen -y "$work/age.key" >"$work/recipients.txt"

step "1. back-up van de oude database"
HZ_BACKUP_TARGET="${HZ_BACKUP_TARGET:-$work/box}" HZ_BACKUP_DSN="$src" HZ_BACKUP_RECIPIENTS="$work/recipients.txt" \
  HZ_BACKUP_PREFIX=hz-verhuis HZ_BACKUP_PING_URL="" HZ_PG_EXEC="" "$here/backup.sh" --label verhuizing >"$work/name"
name="$(tail -n1 "$work/name")"
# Tellingen van de oude database direct na de back-up (op een echte verhuizing staat de oude app dan stil).
# De rollen hieronder krijgen nieuwe wachtwoorden; lokaal delen oude en nieuwe database één Postgres.
psql "$src" -X -tAq -F $'\t' -c "SELECT n.nspname || '.' || c.relname, 0 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind = 'r' AND n.nspname IN ('public', 'drizzle') ORDER BY 1" >"$work/tables.tsv"
: >"$work/old.tsv"
while IFS=$'\t' read -r table _; do
  printf '%s\t%s\n' "$table" "$(psql "$src" -X -tAq -c "SELECT count(*) FROM $table")" >>"$work/old.tsv"
done <"$work/tables.tsv"

step "2. nieuwe database met rollen"
psql "$admin" -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $newdb"
mig_pw="$(pw)"
app_pw="$(pw)"
auth_pw="$(pw)"
backup_pw="$(pw)"
worker_pw="$(pw)"
indexer_pw="$(pw)"
boss_pw="$(pw)"
roles() {
  HZ_DB_NAME="$newdb" HZ_PSQL_ADMIN_URL="$(dsn_db "$admin" "$newdb")" HZ_PG_MIGRATOR_PASSWORD="$mig_pw" \
    HZ_PG_APP_PASSWORD="$app_pw" HZ_PG_BACKUP_PASSWORD="$backup_pw" HZ_PG_AUTH_PASSWORD="$auth_pw" \
    HZ_PG_WORKER_PASSWORD="$worker_pw" HZ_PG_INDEXER_PASSWORD="$indexer_pw" HZ_PG_BOSS_PASSWORD="$boss_pw" \
    "$here/../postgres/hz-roles.sh" >&2
}
roles
# Het (lege) schema van pg-boss komt ook uit de back-up; anders stopt het herstel op "schema bestaat al".
psql "$(dsn_db "$admin" "$newdb")" -X -q -v ON_ERROR_STOP=1 -c "DROP SCHEMA IF EXISTS $boss_schema" >&2

step "3. herstel uit de back-up (met rechten, objecten van $migrator)"
HZ_BACKUP_TARGET="${HZ_BACKUP_TARGET:-$work/box}" HZ_BACKUP_PREFIX=hz-verhuis HZ_AGE_IDENTITY="$work/age.key" \
  HZ_RESTORE_ADMIN_DSN="$admin" HZ_RESTORE_NO_ACL=0 HZ_PG_EXEC="" \
  "$here/restore.sh" "$name" "$newdb" --role "$migrator" --counts "$work/expected.tsv" >/dev/null
# Rechten na het herstel gelijkzetten (het schema van pg-boss weer van de pg-boss-login, logins zonder TEMP).
roles

host_part() { # postgres://u:p@host:port/db -> host:port
  local s="${1#*://}"
  s="${s#*@}"
  printf '%s\n' "${s%%/*}"
}
hp="$(host_part "$admin")"
mig_dsn="postgres://$migrator:$mig_pw@$hp/$newdb"
app_dsn="postgres://$app_login:$app_pw@$hp/$newdb"
auth_dsn="postgres://$auth_login:$auth_pw@$hp/$newdb"

step "4. migraties op de nieuwe database (horen niets meer te doen)"
before="$(psql "$(dsn_db "$admin" "$newdb")" -X -tAq -c 'SELECT count(*) FROM drizzle.__drizzle_migrations')"
DATABASE_URL="$mig_dsn" node "$apidir/dist/migrate.js" >&2
after="$(psql "$(dsn_db "$admin" "$newdb")" -X -tAq -c 'SELECT count(*) FROM drizzle.__drizzle_migrations')"
[[ "$before" == "$after" ]] || die "migraties waren niet bij: $before -> $after"

step "5. rijen per tabel: oud, in de back-up, nieuw"
diff=0
total=0
printf '%-40s %8s %8s %8s\n' tabel oud back-up nieuw
while IFS=$'\t' read -r table old; do
  inbackup="$(awk -F'\t' -v t="$table" '$1 == t {print $2}' "$work/expected.tsv")"
  new="$(psql "$(dsn_db "$admin" "$newdb")" -X -tAq -c "SELECT count(*) FROM $table")"
  mark=""
  [[ "$old" == "$new" && "$inbackup" == "$new" ]] || {
    mark="  <- verschil"
    diff=$((diff + 1))
  }
  total=$((total + new))
  printf '%-40s %8s %8s %8s%s\n' "$table" "$old" "${inbackup:--}" "$new" "$mark"
done <"$work/old.tsv"
((diff == 0)) || die "$diff tabel(len) verschillen"

step "6. API op het nieuwe adres (productiemodus, zelfde code als het image)"
port="${HZ_VERHUIS_PORT:-}"
if [[ -z "$port" ]]; then
  for p in $(seq 8701 8799); do
    if ! (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then
      port="$p"
      break
    fi
  done
fi
[[ -n "$port" ]] || die "geen vrije poort"
(
  cd "$apidir"
  exec env NODE_ENV=production HZ_STORE=db DATABASE_URL="$app_dsn" HZ_AUTH_DATABASE_URL="$auth_dsn" HZ_TOKEN_KEY="$(openssl rand -base64 32)" \
    HZ_API_HOST=127.0.0.1 HZ_API_PORT="$port" HZ_PUBLIC_URL="https://$domain" HZ_WEB_ORIGIN="https://$domain" \
    HZ_DEV_LOGIN=0 HZ_LOG_FORMAT=json HZ_ENVIRONMENT=verhuisproef \
    node dist/index.js
) >"$work/api.log" 2>&1 &
api_pid=$!
health=""
for _ in $(seq 1 50); do
  if health="$("$HZ_CURL" -fsS -m 2 "http://127.0.0.1:$port/api/health" 2>/dev/null)"; then break; fi
  kill -0 "$api_pid" 2>/dev/null || { cat "$work/api.log" >&2; die "API stopte direct"; }
  sleep 0.2
done
[[ "$health" == *'"ok":true'* && "$health" == *'"db":"ok"'* ]] || { cat "$work/api.log" >&2; die "health op het nieuwe adres niet groen: ${health:-geen antwoord}"; }

printf '\nproefverhuizing groen: %s -> %s, %s rijen, https://%s (health: %s)\n' "$name" "$newdb" "$total" "$domain" "$health"
