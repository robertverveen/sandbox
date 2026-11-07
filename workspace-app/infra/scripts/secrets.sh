#!/usr/bin/env bash
# Secrets van de server (HZW-006): versleuteld in de repo met age, per omgeving één bestand.
#
#   infra/secrets/<omgeving>.env.age   versleuteld (mag in Git), omgeving = prod | test | server
#   infra/secrets/<omgeving>.keys      welke sleutels er moeten zijn en waar ze vandaan komen (geen waarden)
#   infra/secrets/recipients.txt       publieke age-sleutels die mogen ontsleutelen: de server en de beheerders
#
# Opdrachten (identiteit: HZ_AGE_IDENTITY, standaard ~/.config/hz/age.key op een beheerderslaptop):
#   secrets.sh keygen <pad>                maak een age-sleutel (server: /etc/hz/age.key) en print de publieke sleutel
#   secrets.sh gen <omgeving>              vul alle machine-geheimen (wachtwoorden, HZ_TOKEN_KEY, ...) die nog ontbreken
#   secrets.sh set <omgeving> <SLEUTEL>    zet één waarde, gelezen van stdin (komt nooit in de shell-geschiedenis)
#   secrets.sh unset <omgeving> <SLEUTEL>
#   secrets.sh keys <omgeving>             welke sleutels staan erin (zonder waarden)
#   secrets.sh check <omgeving>            ontbreekt er een verplichte sleutel? (exit 1 als ja)
#   secrets.sh edit <omgeving>             open in $EDITOR (in /dev/shm), daarna opnieuw versleuteld
#   secrets.sh rekey <omgeving>            opnieuw versleutelen voor de huidige recipients.txt (nieuwe server)
#   secrets.sh decrypt <omgeving> <uit>    ontsleutel naar een bestand (0600); alleen voor deploy.sh op de server
set -euo pipefail
HZ_SCRIPT=secrets
identity_in="${HZ_AGE_IDENTITY:-}"
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SECRETS_DIR="${HZ_SECRETS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../secrets" && pwd)}"
RECIPIENTS="${HZ_AGE_RECIPIENTS_FILE:-$SECRETS_DIR/recipients.txt}"
# Identiteit: HZ_AGE_IDENTITY, anders de beheerderssleutel op de laptop, anders die van de server.
IDENTITY="${identity_in:-$HOME/.config/hz/age.key}"
[[ -n "$identity_in" || -f "$IDENTITY" || ! -f "$HZ_ETC/age.key" ]] || IDENTITY="$HZ_ETC/age.key"

valid_scope() { [[ "$1" == prod || "$1" == test || "$1" == server ]] || die "onbekende omgeving: $1 (prod, test, server)"; }

tmpdir() {
  local base=/dev/shm
  [[ -d "$base" && -w "$base" ]] || base="${TMPDIR:-/tmp}"
  mktemp -d "$base/hz-secrets.XXXXXX"
}

recipients_args() {
  local n
  n="$(grep -Ec '^age1[0-9a-z]+' "$RECIPIENTS" || true)"
  ((n > 0)) || die "geen ontvangers in $RECIPIENTS (zet de publieke sleutel van server en beheerders erin)"
  printf '%s\n' -R "$RECIPIENTS"
}

decrypt_to() {
  local scope="$1" out="$2" src="$SECRETS_DIR/$1.env.age"
  (umask 077 && : >"$out")
  if [[ -f "$src" ]]; then
    "$HZ_AGE" -d -i "$IDENTITY" -o "$out" "$src" || die "ontsleutelen van $scope mislukt (juiste sleutel in $IDENTITY?)"
  fi
  chmod 600 "$out"
}

encrypt_from() {
  local scope="$1" plain="$2" dest="$SECRETS_DIR/$1.env.age" args
  mapfile -t args < <(recipients_args)
  validate_plain "$plain"
  "$HZ_AGE" -e "${args[@]}" -o "$dest.tmp" "$plain"
  mv "$dest.tmp" "$dest"
}

validate_plain() {
  local f="$1" n=0 line
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n + 1))
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ ^[A-Z_][A-Z0-9_]*=.*$ ]] || die "regel $n is geen KEY=waarde"
  done <"$f"
}

set_kv() {
  local f="$1" k="$2" v="$3" tmp
  [[ "$k" =~ ^[A-Z_][A-Z0-9_]*$ ]] || die "ongeldige sleutelnaam: $k"
  [[ "$v" != *$'\n'* ]] || die "waarde mag geen regeleinde bevatten"
  tmp="$f.new"
  grep -v -E "^${k}=" "$f" >"$tmp" || true
  printf '%s=%s\n' "$k" "$v" >>"$tmp"
  mv "$tmp" "$f"
}

gen_value() {
  case "$1" in
    gen:hex) openssl rand -hex 24 ;;
    gen:b64) openssl rand -base64 32 ;;
    *) return 1 ;;
  esac
}

cmd="${1:-}"
shift || true
case "$cmd" in
  keygen)
    out="${1:?pad voor de sleutel}"
    need age-keygen
    [[ ! -e "$out" ]] || die "$out bestaat al; overschrijven doe je niet per ongeluk"
    (umask 077 && mkdir -p "$(dirname "$out")" && age-keygen -o "$out" 2>/dev/null)
    age-keygen -y "$out"
    ;;
  gen)
    scope="${1:?omgeving}"
    valid_scope "$scope"
    d="$(tmpdir)"
    trap 'rm -rf "$d"' EXIT
    decrypt_to "$scope" "$d/plain"
    added=()
    while read -r name src _; do
      [[ -z "$name" || "$name" == \#* ]] && continue
      name="${name#\?}"
      grep -Eq "^${name}=.+" "$d/plain" && continue
      if v="$(gen_value "$src")"; then
        set_kv "$d/plain" "$name" "$v"
        added+=("$name")
      fi
    done <"$SECRETS_DIR/$scope.keys"
    encrypt_from "$scope" "$d/plain"
    log "gegenereerd in $scope: ${added[*]:-niets nieuw}"
    ;;
  set)
    scope="${1:?omgeving}"
    key="${2:?sleutel}"
    valid_scope "$scope"
    IFS= read -r value || true
    [[ -n "$value" ]] || die "lege waarde op stdin"
    d="$(tmpdir)"
    trap 'rm -rf "$d"' EXIT
    decrypt_to "$scope" "$d/plain"
    set_kv "$d/plain" "$key" "$value"
    encrypt_from "$scope" "$d/plain"
    log "$key gezet in $scope"
    ;;
  unset)
    scope="${1:?omgeving}"
    key="${2:?sleutel}"
    valid_scope "$scope"
    d="$(tmpdir)"
    trap 'rm -rf "$d"' EXIT
    decrypt_to "$scope" "$d/plain"
    grep -v -E "^${key}=" "$d/plain" >"$d/new" || true
    encrypt_from "$scope" "$d/new"
    log "$key verwijderd uit $scope"
    ;;
  keys)
    scope="${1:?omgeving}"
    valid_scope "$scope"
    d="$(tmpdir)"
    trap 'rm -rf "$d"' EXIT
    decrypt_to "$scope" "$d/plain"
    sed -n -E 's/^([A-Z_][A-Z0-9_]*)=.*/\1/p' "$d/plain" | sort
    ;;
  check)
    scope="${1:?omgeving}"
    valid_scope "$scope"
    d="$(tmpdir)"
    trap 'rm -rf "$d"' EXIT
    decrypt_to "$scope" "$d/plain"
    absent="$(missing_keys "$d/plain" "$SECRETS_DIR/$scope.keys")"
    if [[ -n "$absent" ]]; then
      log "ontbrekend in $scope: $(tr '\n' ' ' <<<"$absent")"
      exit 1
    fi
    log "$scope compleet"
    ;;
  edit)
    scope="${1:?omgeving}"
    valid_scope "$scope"
    d="$(tmpdir)"
    trap 'rm -rf "$d"' EXIT
    decrypt_to "$scope" "$d/plain"
    "${EDITOR:-vi}" "$d/plain"
    encrypt_from "$scope" "$d/plain"
    log "$scope opnieuw versleuteld"
    ;;
  rekey)
    scope="${1:?omgeving}"
    valid_scope "$scope"
    d="$(tmpdir)"
    trap 'rm -rf "$d"' EXIT
    decrypt_to "$scope" "$d/plain"
    encrypt_from "$scope" "$d/plain"
    log "$scope versleuteld voor $(grep -Ec '^age1' "$RECIPIENTS") ontvanger(s)"
    ;;
  decrypt)
    scope="${1:?omgeving}"
    out="${2:?uitbestand}"
    valid_scope "$scope"
    [[ -f "$SECRETS_DIR/$scope.env.age" ]] || die "geen $scope.env.age"
    decrypt_to "$scope" "$out"
    ;;
  *)
    sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
