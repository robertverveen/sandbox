#!/usr/bin/env bash
# Gedeelde hulpfuncties voor de beheerscripts. Wordt gesourced, niet uitgevoerd.
# Alles is via omgevingsvariabelen te overschrijven, zodat de tests de scripts echt kunnen draaien met nep-docker,
# een lokale Postgres en tijdelijke mappen in plaats van /srv/hz-workspace.
#
# De workspace draait op een bestaande server naast andere projecten (HZW-002, plaat keuze 01). Alles van de
# workspace heeft daarom één eigen naam, hz-workspace: gebruiker, map (/srv/hz-workspace), compose-projecten
# (hz-workspace-prod, -test, -pr-<nr>, -ops, -router), Docker-netwerken (hz-workspace-net, <project>-net),
# volumes, systemd-units en het label nl.homezero.workspace=1 op elke container, elk netwerk en elk volume.
# shellcheck shell=bash

HZ_LABEL=nl.homezero.workspace
HZ_NET=hz-workspace-net
HZ_ROOT="${HZ_ROOT:-/srv/hz-workspace}"
HZ_ETC="${HZ_ETC:-$HZ_ROOT/etc}"
HZ_RUN="${HZ_RUN:-/run/hz-workspace}"
HZ_LOG_DIR="${HZ_LOG_DIR:-$HZ_ROOT/log}"
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

# Het gedeelde netwerk van de workspace (router <-> web-containers van prod, test en previews), met ons label.
ensure_net() {
  "$HZ_DOCKER" network inspect "$HZ_NET" >/dev/null 2>&1 ||
    "$HZ_DOCKER" network create --label "$HZ_LABEL=1" "$HZ_NET" >/dev/null
}

# Compose-bestanden van de router, afhankelijk van hoe de bestaande reverse proxy erbij komt (hz.env):
#   HZ_PROXY_KIND=caddy|traefik   proxy die al op de server draait; HZ_PROXY_NETWORK (proxy in Docker) of
#                                 HZ_ROUTER_PORT (proxy op de host, router alleen op 127.0.0.1)
#   HZ_PROXY_KIND=eigen           geen proxy op de server (eigen server, HZW-082): eigen edge op 443 (edge.yaml)
router_files() {
  local c="$1/compose"
  printf '%s\n' -f "$c/router.yaml"
  if [[ -n "${HZ_PROXY_NETWORK:-}" ]]; then
    printf '%s\n' -f "$c/router-network.yaml"
  elif [[ -n "${HZ_ROUTER_PORT:-}" ]]; then
    printf '%s\n' -f "$c/router-loopback.yaml"
  fi
  [[ "${HZ_PROXY_KIND:-}" == traefik ]] && printf '%s\n' -f "$c/router-traefik.yaml"
  return 0
}

valid_proxy() {
  case "${HZ_PROXY_KIND:-}" in
    caddy | traefik)
      [[ -n "${HZ_PROXY_NETWORK:-}" || -n "${HZ_ROUTER_PORT:-}" ]] || return 1
      [[ "${HZ_PROXY_KIND}" != traefik || -n "${HZ_PROXY_NETWORK:-}" ]] || return 1
      ;;
    eigen) ;;
    *) return 1 ;;
  esac
  [[ -z "${HZ_PROXY_NETWORK:-}" || "$HZ_PROXY_NETWORK" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$ ]] || return 1
  [[ -z "${HZ_ROUTER_PORT:-}" || "$HZ_ROUTER_PORT" =~ ^[0-9]{4,5}$ ]] || return 1
}

# Afgeleide waarden voor de router en de proxy (na load_env van hz.env).
proxy_env() {
  export HZ_ERRORS_DOMAIN="${HZ_ERRORS_DOMAIN:-fouten.${HZ_DOMAIN:?}}"
  export HZ_TEST_DOMAIN_RE="${HZ_TEST_DOMAIN//./\\.}"
  if [[ -n "${HZ_ROUTER_PORT:-}" ]]; then export HZ_ROUTER_ASK_PORT=$((HZ_ROUTER_PORT + 1)); fi
  return 0
}
