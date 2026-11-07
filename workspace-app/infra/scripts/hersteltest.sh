#!/usr/bin/env bash
# Hersteltest (HZW-008): de nieuwste (of een gegeven) back-up herstellen in een lege database en per tabel de rijen
# tellen. Groen als elke tabel evenveel rijen heeft als in de back-up staat en er überhaupt rijen zijn.
# Maandelijks via systemd (hz-hersteltest.timer) en na elke wijziging aan back-ups; uitkomst in hersteltest.log.
#
#   hersteltest.sh [latest|<bestand.dump.age>] [--keep]
#
# Omgeving: als restore.sh, plus
#   HZ_RESTORE_COUNT_DSN   verbinding om te tellen; moet door RLS heen kunnen kijken (superuser of hz_backup).
#                          Standaard HZ_RESTORE_ADMIN_DSN.
#   HZ_RESTORE_PING_URL    uptime-check: ping bij groen, /fail bij rood
#   HZ_RESTORE_ALLOW_EMPTY 1 = een lege database is ook goed (alleen voor een kale installatie)
#   HZ_RESTORE_DB_PREFIX   naam van de tijdelijke database (standaard hz_hersteltest_<tijd>)
set -euo pipefail
HZ_SCRIPT=hersteltest
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$here/lib.sh"

src=latest
keep=0
for a in "$@"; do
  case "$a" in
    --keep) keep=1 ;;
    *) src="$a" ;;
  esac
done

admin_dsn="${HZ_RESTORE_ADMIN_DSN:?HZ_RESTORE_ADMIN_DSN ontbreekt}"
count_base="${HZ_RESTORE_COUNT_DSN:-$admin_dsn}"
read -r -a exec_prefix <<<"${HZ_PG_EXEC:-}"
pgx() { "${exec_prefix[@]}" "$@"; }
db="${HZ_RESTORE_DB_PREFIX:-hz_hersteltest}_$(date -u +%Y%m%d%H%M%S)_$$"
[[ "$db" =~ ^[a-z_][a-z0-9_]*$ ]] || die "ongeldig HZ_RESTORE_DB_PREFIX"
work="$(mktemp -d "${TMPDIR:-/tmp}/hz-hersteltest.XXXXXX")"
t0="$(date +%s)"

result_log() {
  if mkdir -p "$HZ_LOG_DIR" 2>/dev/null; then
    printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$HZ_LOG_DIR/hersteltest.log" 2>/dev/null || true
  fi
}
fail() {
  log "ROOD: $*"
  ping_url "${HZ_RESTORE_PING_URL:+${HZ_RESTORE_PING_URL%/}/fail}" "hersteltest rood: $*"
  result_log "rood $*"
  exit 1
}
cleanup() {
  rm -rf "$work"
  if ((keep == 0)); then
    pgx psql "$admin_dsn" -X -q -c "DROP DATABASE IF EXISTS $db WITH (FORCE)" >/dev/null 2>&1 || log "opruimen van $db mislukt"
  fi
}
trap cleanup EXIT

# De test gaat over de gegevens: rechten (GRANT, DEFAULT PRIVILEGES) slaan we standaard over, zodat de test ook
# zonder superuser kan draaien. De verhuisproef (verhuis-proef.sh) herstelt wél met rechten, als hz_migrator.
export HZ_RESTORE_NO_ACL="${HZ_RESTORE_NO_ACL:-1}"
name="$("$here/restore.sh" "$src" "$db" --create --counts "$work/expected.tsv" | tail -n1)" || fail "herstellen mislukt"

count_dsn="$(dsn_db "$count_base" "$db")"
tables=0
rows=0
bad=0
printf '%-40s %10s %10s\n' tabel back-up hersteld
while IFS=$'\t' read -r table expected; do
  actual="$(pgx psql "$count_dsn" -X -tAq -c "SELECT count(*) FROM $table")" || fail "tellen in $table mislukt"
  flag=""
  if [[ "$actual" != "$expected" ]]; then
    flag="  <- verschil"
    bad=$((bad + 1))
  fi
  printf '%-40s %10s %10s%s\n' "$table" "$expected" "$actual" "$flag"
  tables=$((tables + 1))
  rows=$((rows + actual))
done <"$work/expected.tsv"

((tables > 0)) || fail "$name: geen tabellen in de back-up"
((bad == 0)) || fail "$name: $bad tabel(len) met een ander aantal rijen"
((rows > 0 || ${HZ_RESTORE_ALLOW_EMPTY:-0} == 1)) || fail "$name: hersteld, maar de database is leeg"

secs=$(($(date +%s) - t0))
summary="hersteltest groen: $name, $tables tabellen, $rows rijen, ${secs}s"
log "$summary"
result_log "groen $summary"
ping_url "${HZ_RESTORE_PING_URL:-}" "$summary"
((keep == 0)) || log "database $db blijft staan (--keep)"
printf '%s\n' "$summary"
