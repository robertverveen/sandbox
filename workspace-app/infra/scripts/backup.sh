#!/usr/bin/env bash
# Back-up van de database (HZW-008): pg_dump (custom-formaat) -> versleuteld met age -> Hetzner Storage Box.
# Nachtelijk via systemd (hz-workspace-backup.timer, 02:30), en vóór elke productie-uitrol (deploy.sh). 30 dagen bewaren.
#
#   backup.sh [--label nightly|pre-deploy|handmatig]
#
# Omgeving (op de server uit /srv/hz-workspace/etc/hz.env en server.env.age, via hz-run):
#   HZ_BACKUP_TARGET       sftp://<gebruiker>@<host>:23/<map>   of een lokale map (tests, proefverhuizing)
#   HZ_BACKUP_RECIPIENTS   age-ontvangers (bestand); standaard infra/secrets/recipients.txt (server + beheerders)
#   HZ_BACKUP_DSN          connection string voor pg_dump; zonder: -U $HZ_BACKUP_PGUSER -d $HZ_BACKUP_DB
#   HZ_PG_EXEC             voorvoegsel voor pg_dump, bijv. "docker exec -i hz-workspace-prod-db-1" (geen open databasepoort)
#   HZ_BACKUP_PREFIX       naam vooraan het bestand (standaard hz-workspace-prod)
#   HZ_BACKUP_KEEP_DAYS    bewaartermijn in dagen (standaard 30); de 7 nieuwste blijven altijd
#   HZ_BACKUP_SSH_KEY      sleutel voor de Storage Box (standaard ~/.ssh/hz_backup_ed25519)
#   HZ_BACKUP_PING_URL     uptime-check: ping bij succes, /fail bij een fout
#
# Waarom een eigen rol hz_backup (BYPASSRLS, alleen lezen): FORCE ROW LEVEL SECURITY geldt ook voor de eigenaar,
# dus een dump als eigenaar faalt of mist rijen (infra/postgres/hz-roles.sh).
set -euo pipefail
HZ_SCRIPT=backup
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$here/lib.sh"

label=nightly
while (($#)); do
  case "$1" in
    --label)
      label="${2:?}"
      shift 2
      ;;
    *) die "onbekende optie: $1" ;;
  esac
done
[[ "$label" =~ ^[a-z0-9-]{1,20}$ ]] || die "ongeldig label"

target="${HZ_BACKUP_TARGET:?HZ_BACKUP_TARGET ontbreekt}"
recipients="${HZ_BACKUP_RECIPIENTS:-$here/../secrets/recipients.txt}"
prefix="${HZ_BACKUP_PREFIX:-hz-workspace-prod}"
keep_days="${HZ_BACKUP_KEEP_DAYS:-30}"
ssh_key="${HZ_BACKUP_SSH_KEY:-$HOME/.ssh/hz_backup_ed25519}"
[[ "$prefix" =~ ^[a-z0-9-]+$ ]] || die "ongeldig voorvoegsel"
grep -Eq '^age1[0-9a-z]+' "$recipients" || die "geen age-ontvangers in $recipients"

on_err() {
  local rc=$?
  ping_url "${HZ_BACKUP_PING_URL:+${HZ_BACKUP_PING_URL%/}/fail}" "back-up $label mislukt (exit $rc)"
  rm -rf "${work:-}"
}
trap on_err ERR
trap 'rm -rf "${work:-}"' EXIT

work="$(mktemp -d "${TMPDIR:-/tmp}/hz-backup.XXXXXX")"
ts="$(date -u +%Y%m%dT%H%M%SZ)"
name="$prefix-$ts-$label.dump.age"

read -r -a exec_prefix <<<"${HZ_PG_EXEC:-}"
dump_args=(--format=custom --compress=6 --no-password)
if [[ -n "${HZ_BACKUP_DSN:-}" ]]; then
  dump_args+=("--dbname=$HZ_BACKUP_DSN")
else
  dump_args+=(-U "${HZ_BACKUP_PGUSER:-hz_backup}" -d "${HZ_BACKUP_DB:-hz}")
fi

# Dump en versleuteling in één stroom: de onversleutelde dump raakt de schijf nooit.
set -o pipefail
"${exec_prefix[@]}" pg_dump "${dump_args[@]}" | "$HZ_AGE" -e -R "$recipients" -o "$work/$name"
size="$(wc -c <"$work/$name")"
((size > 200)) || die "back-up verdacht klein ($size bytes)"
(cd "$work" && sha256sum "$name" >"$name.sha256")

# --- Opslag -----------------------------------------------------------------------------------------------------
sftp_parts() {
  # sftp://gebruiker@host:poort/pad -> gebruiker@host poort pad
  [[ "$target" =~ ^sftp://([^@/]+@[^:/]+)(:([0-9]+))?(/.*)?$ ]] || die "HZ_BACKUP_TARGET: verwacht sftp://gebruiker@host:poort/pad"
  remote="${BASH_REMATCH[1]}"
  port="${BASH_REMATCH[3]:-23}"
  rpath="${BASH_REMATCH[4]:-/}"
  rpath="${rpath#/}"
  [[ -n "$rpath" ]] || rpath=.
}
sftp_batch() {
  sftp -b - -P "$port" -i "$ssh_key" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$remote" >/dev/null
}

store() {
  if [[ "$target" == sftp://* ]]; then
    sftp_parts
    sftp_batch <<EOF
-mkdir $rpath
put $work/$name $rpath/$name.part
put $work/$name.sha256 $rpath/$name.sha256
rename $rpath/$name.part $rpath/$name
EOF
  else
    mkdir -p "$target"
    cp "$work/$name.sha256" "$target/"
    cp "$work/$name" "$target/$name.part"
    mv "$target/$name.part" "$target/$name"
  fi
}

list_remote() {
  if [[ "$target" == sftp://* ]]; then
    sftp_parts
    printf 'ls -1 %s\n' "$rpath" | sftp -b - -P "$port" -i "$ssh_key" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$remote" 2>/dev/null |
      grep -v '^sftp>' | sed 's#.*/##'
  else
    ls -1 "$target"
  fi
}

remove_remote() {
  local f="$1"
  if [[ "$target" == sftp://* ]]; then
    sftp_parts
    printf 'rm %s/%s\nrm %s/%s.sha256\n' "$rpath" "$f" "$rpath" "$f" | sftp_batch || true
  else
    rm -f "$target/$f" "$target/$f.sha256"
  fi
}

# Bewaartermijn: alles ouder dan keep_days weg, maar de 7 nieuwste blijven altijd staan.
prune() {
  local cutoff files f stamp
  cutoff="$(date -u -d "-$keep_days days" +%Y%m%dT%H%M%SZ)"
  mapfile -t files < <(list_remote | grep -E "^$prefix-[0-9]{8}T[0-9]{6}Z-[a-z0-9-]+\.dump\.age$" | sort -r)
  for f in "${files[@]:7}"; do
    stamp="${f#"$prefix"-}"
    stamp="${stamp:0:16}"
    if [[ "$stamp" < "$cutoff" ]]; then
      remove_remote "$f"
      log "verlopen back-up verwijderd: $f"
    fi
  done
}

store
prune
log "back-up klaar: $name ($size bytes)"
ping_url "${HZ_BACKUP_PING_URL:-}" "back-up $label: $name, $size bytes"
printf '%s\n' "$name"
