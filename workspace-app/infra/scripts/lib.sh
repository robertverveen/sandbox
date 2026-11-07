#!/usr/bin/env bash
# Gedeelde hulpfuncties voor de beheerscripts. Wordt gesourced, niet uitgevoerd.
# Alles is via omgevingsvariabelen te overschrijven, zodat de tests de scripts echt kunnen draaien met nep-docker,
# een lokale Postgres en tijdelijke mappen in plaats van /opt/hz en /etc/hz.
# shellcheck shell=bash

HZ_ROOT="${HZ_ROOT:-/opt/hz}"
HZ_ETC="${HZ_ETC:-/etc/hz}"
HZ_RUN="${HZ_RUN:-/run/hz}"
HZ_LOG_DIR="${HZ_LOG_DIR:-/var/log/hz}"
HZ_DOCKER="${HZ_DOCKER:-docker}"
HZ_AGE="${HZ_AGE:-age}"
HZ_CURL="${HZ_CURL:-curl}"
HZ_AGE_IDENTITY="${HZ_AGE_IDENTITY:-$HZ_ETC/age.key}"

log() { printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${HZ_SCRIPT:-hz}" "$*" >&2; }
die() {
  log "FOUT: $*"
  exit 1
}
need() {
  local c
  for c in "$@"; do command -v "$c" >/dev/null 2>&1 || die "programma ontbreekt: $c"; done
}

# Laad een dotenv-bestand (KEY=waarde per regel, # voor commentaar) in de omgeving, zonder shell-expansie.
load_env() {
  local f="$1" line k v
  [[ -f "$f" ]] || die "bestand niet gevonden: $f"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]] || die "ongeldige regel in $f (verwacht KEY=waarde)"
    k="${BASH_REMATCH[1]}"
    v="${BASH_REMATCH[2]}"
    v="${v#\"}"
    v="${v%\"}"
    export "$k=$v"
  done <"$f"
}

# Verplichte sleutels uit een .keys-bestand (regels "NAAM bron", optioneel met ? ervoor).
required_keys() {
  local f="$1" name
  while read -r name _; do
    [[ -z "$name" || "$name" == \#* || "$name" == \?* ]] && continue
    printf '%s\n' "$name"
  done <"$f"
}

# Controleer dat een dotenv-bestand alle verplichte sleutels (niet leeg) bevat. Print de ontbrekende.
missing_keys() {
  local env_file="$1" keys_file="$2" k missing=()
  while read -r k; do
    grep -Eq "^${k}=.+" "$env_file" || missing+=("$k")
  done < <(required_keys "$keys_file")
  ((${#missing[@]} == 0)) || printf '%s\n' "${missing[@]}"
}

# Vervang de database in een connection string: postgres://u:p@h:5432/oud?x -> postgres://u:p@h:5432/nieuw?x
dsn_db() {
  local dsn="$1" db="$2" base query=""
  base="${dsn%%\?*}"
  [[ "$dsn" == *\?* ]] && query="?${dsn#*\?}"
  if [[ "$base" =~ ^(postgres(ql)?://[^/]*)(/.*)?$ ]]; then
    printf '%s/%s%s\n' "${BASH_REMATCH[1]}" "$db" "$query"
  else
    die "ongeldige connection string"
  fi
}

# Ping naar een uptime-dienst (healthchecks.io of compatibel). Faalt nooit hard: een melding mag het werk niet stoppen.
ping_url() {
  local url="$1" body="${2:-}"
  [[ -n "$url" ]] || return 0
  "$HZ_CURL" -fsS -m 10 --retry 3 -o /dev/null --data-raw "${body:0:1000}" "$url" || log "ping mislukt: ${url%%\?*}"
}

valid_env() { [[ "$1" == prod || "$1" == test ]]; }
valid_tag() { [[ "$1" =~ ^(sha-[0-9a-f]{7,40}|v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?|pr-[0-9]{1,6}-[0-9a-f]{7,40})$ ]]; }
valid_pr() { [[ "$1" =~ ^[0-9]{1,6}$ ]]; }
