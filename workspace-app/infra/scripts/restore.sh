#!/usr/bin/env bash
# Herstel een back-up in een database (HZW-008, HZW-082). Gebruikt door hersteltest.sh (lege testdatabase) en bij
# een echte herstelactie of verhuizing (RUNBOOK.md).
#
#   restore.sh <bestand.dump.age|latest> <doel-database> [--create] [--role <rol>] [--counts <bestand>]
#
#   --create    maak de doel-database eerst aan (moet nog niet bestaan)
#   --role      objecten worden van deze rol (bij een verhuizing: hz_migrator), anders van wie herstelt
#   --counts    schrijf de rijen per tabel zoals ze in de back-up staan (schema.tabel<TAB>aantal)
#
# Omgeving:
#   HZ_BACKUP_TARGET       waar de back-ups staan (sftp://... of een lokale map), voor 'latest' of een bestandsnaam
#   HZ_BACKUP_PREFIX       standaard hz-workspace-prod
#   HZ_AGE_IDENTITY        age-sleutel die mag ontsleutelen (server: /srv/hz-workspace/etc/age.key)
#   HZ_RESTORE_ADMIN_DSN   verbinding met rechten om databases te maken, naar de database 'postgres'
#                          (server: postgresql:///postgres?user=postgres binnen de db-container)
#   HZ_PG_EXEC             voorvoegsel voor psql/pg_restore, bijv. "docker exec -i hz-workspace-prod-db-1"
set -euo pipefail
HZ_SCRIPT=restore
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$here/lib.sh"

src="${1:-}"
db="${2:-}"
shift 2 || die "gebruik: restore.sh <bestand|latest> <doel-database> [--create] [--role rol] [--counts bestand]"
create=0
role=""
counts=""
while (($#)); do
  case "$1" in
    --create)
      create=1
      shift
      ;;
    --role)
      role="${2:?}"
      shift 2
      ;;
    --counts)
      counts="${2:?}"
      shift 2
      ;;
    *) die "onbekende optie: $1" ;;
  esac
done
[[ "$db" =~ ^[a-z_][a-z0-9_]*$ ]] || die "ongeldige databasenaam: $db"
[[ -z "$role" || "$role" =~ ^[a-z_][a-z0-9_]*$ ]] || die "ongeldige rol"
admin_dsn="${HZ_RESTORE_ADMIN_DSN:?HZ_RESTORE_ADMIN_DSN ontbreekt}"
prefix="${HZ_BACKUP_PREFIX:-hz-workspace-prod}"
read -r -a exec_prefix <<<"${HZ_PG_EXEC:-}"
pgx() { "${exec_prefix[@]}" "$@"; }

work="$(mktemp -d "${TMPDIR:-/tmp}/hz-restore.XXXXXX")"
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"

# 1. Ophalen
fetch() {
  local name="$1" target="${HZ_BACKUP_TARGET:-}"
  if [[ "$target" == sftp://* ]]; then
    [[ "$target" =~ ^sftp://([^@/]+@[^:/]+)(:([0-9]+))?(/.*)?$ ]] || die "HZ_BACKUP_TARGET ongeldig"
    local remote="${BASH_REMATCH[1]}" port="${BASH_REMATCH[3]:-23}" rpath="${BASH_REMATCH[4]:-/}"
    rpath="${rpath#/}"
    local key="${HZ_BACKUP_SSH_KEY:-$HOME/.ssh/hz_backup_ed25519}"
    if [[ "$name" == latest ]]; then
      name="$(printf 'ls -1 %s\n' "${rpath:-.}" | sftp -b - -P "$port" -i "$key" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$remote" 2>/dev/null |
        grep -v '^sftp>' | sed 's#.*/##' | grep -E "^$prefix-.*\.dump\.age$" | sort | tail -n1)"
      [[ -n "$name" ]] || die "geen back-ups gevonden"
    fi
    printf 'get %s/%s %s/\nget %s/%s.sha256 %s/\n' "${rpath:-.}" "$name" "$work" "${rpath:-.}" "$name" "$work" |
      sftp -b - -P "$port" -i "$key" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$remote" >/dev/null || die "ophalen van $name mislukt"
  elif [[ -n "$target" && ! -f "$name" ]]; then
    if [[ "$name" == latest ]]; then
      name="$(find "$target" -maxdepth 1 -name "$prefix-*.dump.age" -printf '%f\n' | sort | tail -n1)"
      [[ -n "$name" ]] || die "geen back-ups gevonden in $target"
    fi
    cp "$target/$name" "$work/"
    [[ -f "$target/$name.sha256" ]] && cp "$target/$name.sha256" "$work/"
  else
    [[ -f "$name" ]] || die "bestand niet gevonden: $name"
    cp "$name" "$work/"
    [[ -f "$name.sha256" ]] && cp "$name.sha256" "$work/"
    name="$(basename "$name")"
  fi
  printf '%s\n' "$name"
}
name="$(fetch "$src")"
log "back-up: $name"
if [[ -f "$work/$name.sha256" ]]; then
  (cd "$work" && sha256sum -c --quiet "$name.sha256") || die "controlesom klopt niet: $name is beschadigd"
fi

# 2. Ontsleutelen (alleen in de werkmap, 0600)
(umask 077 && "$HZ_AGE" -d -i "$HZ_AGE_IDENTITY" -o "$work/dump" "$work/$name") || die "ontsleutelen mislukt"

# 3. Wat er in de back-up staat (rijen per tabel), los van de database
pgx pg_restore --data-only -f - <"$work/dump" |
  awk '/^COPY [^ ]+ .*FROM stdin;$/ {t=$2; n=0; inb=1; next}
       inb && /^\\\.$/ {print t "\t" n; inb=0; next}
       inb {n++}' >"$work/expected.tsv"
[[ -n "$counts" ]] && cp "$work/expected.tsv" "$counts"

# 4. Herstellen
if ((create)); then
  pgx psql "$admin_dsn" -X -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $db" || die "database $db aanmaken mislukt"
fi
target_dsn="$(dsn_db "$admin_dsn" "$db")"
restore_args=(--exit-on-error --no-owner --single-transaction "--dbname=$target_dsn")
[[ -n "$role" ]] && restore_args+=("--role=$role")
[[ "${HZ_RESTORE_NO_ACL:-0}" == 1 ]] && restore_args+=(--no-acl)
pgx pg_restore "${restore_args[@]}" <"$work/dump" || die "pg_restore naar $db mislukt"
log "hersteld in $db: $(wc -l <"$work/expected.tsv") tabellen, $(awk -F'\t' '{s+=$2} END {print s+0}' "$work/expected.tsv") rijen"
printf '%s\n' "$name"
