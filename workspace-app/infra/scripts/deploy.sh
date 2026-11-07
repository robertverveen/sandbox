#!/usr/bin/env bash
# Uitrol van productie of test op de server (HZW-004). Draait vanuit de uitrolbundel van de nieuwe versie
# (/srv/hz-workspace/releases/<tag>/infra/scripts/deploy.sh); hz-ssh-dispatch start hem na het ophalen van de images.
#
#   deploy.sh <prod|test> <tag>
#
# Stappen: voorcheck (botst niets met de andere projecten op de server, anders stoppen vóór er iets verandert) ->
# secrets ontsleutelen (age) -> verplichte sleutels controleren -> router bijwerken (herladen zonder onderbreking)
# en het site-blok voor de bestaande proxy bijhouden -> productie: eerst een back-up -> rollen gelijkzetten ->
# migraties -> containers vervangen en wachten tot ze gezond zijn -> health-check via https -> vastleggen.
# Mislukt iets na het vervangen, dan gaat de vorige versie terug (rollback).
# Migraties gaan alleen vooruit: schrijf ze uitbreidend (eerst kolom erbij, later pas weg), zie RUNBOOK.md.
set -euo pipefail
HZ_SCRIPT=deploy
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$here/lib.sh"
infra="$(dirname "$here")"
bundle="$(dirname "$infra")"

env="${1:-}"
tag="${2:-}"
valid_env "$env" || die "omgeving moet prod of test zijn"
valid_tag "$tag" || die "ongeldige tag: $tag"

load_env "$HZ_ETC/hz.env"
: "${HZ_REGISTRY:?HZ_REGISTRY ontbreekt in $HZ_ETC/hz.env}"
: "${HZ_DOMAIN:?}" "${HZ_TEST_DOMAIN:?}"
proxy_env
valid_proxy || die "HZ_PROXY_KIND/HZ_PROXY_NETWORK/HZ_ROUTER_PORT in $HZ_ETC/hz.env kloppen niet (zie server-setup.sh)"

instance="hz-workspace-$env"
state="$HZ_ROOT/env/$env"
mkdir -p "$state" "$HZ_RUN" "$HZ_LOG_DIR" "$HZ_ROOT/router" "$HZ_ROOT/proxy" "$HZ_ROOT/edge" "$HZ_ROOT/previews/allow"
exec 9>"$state/.lock"
flock -n 9 || die "er loopt al een uitrol voor $env"

# 0. Voorcheck: botst er iets met de andere projecten op deze server (poorten, netwerken, projecten, volumes,
# mappen, domeinen), dan stopt de uitrol hier, vóór er iets aan de server verandert.
if [[ "${HZ_SKIP_VOORCHECK:-0}" != 1 ]]; then
  "$here/server-check.sh" --voorcheck >&2 || die "voorcheck rood: uitrol gestopt, er is niets gewijzigd (RUNBOOK.md §2)"
fi

# 1. Secrets: alleen in /run (tmpfs), alleen leesbaar voor deze gebruiker.
umask 077
secrets="$HZ_RUN/$env.env"
appenv="$HZ_RUN/$env.app.env"
"$HZ_AGE" -d -i "$HZ_AGE_IDENTITY" -o "$secrets" "$infra/secrets/$env.env.age" || die "ontsleutelen van $env mislukt"
miss="$(missing_keys "$secrets" "$infra/secrets/$env.keys")"
[[ -z "$miss" ]] || die "verplichte secrets ontbreken in $env: $(tr '\n' ' ' <<<"$miss")(zie infra/secrets/$env.keys)"
# api en worker krijgen geen databasewachtwoorden (die zet compose zelf in DATABASE_URL).
grep -v -E '^(HZ_PG_|#|[[:space:]]*$)' "$secrets" >"$appenv" || true
server_env="$HZ_RUN/server.env"
if [[ -f "$infra/secrets/server.env.age" ]]; then
  "$HZ_AGE" -d -i "$HZ_AGE_IDENTITY" -o "$server_env" "$infra/secrets/server.env.age" || die "ontsleutelen van server mislukt"
else
  : >"$server_env"
fi
# Server-secrets: de router heeft het previewwachtwoord nodig; productie ook back-ups en de hartslag (server.keys).
if [[ "$env" == prod ]]; then
  miss="$(missing_keys "$server_env" "$infra/secrets/server.keys")"
else
  miss="$(printf 'HZ_PREVIEW_USER x\nHZ_PREVIEW_HASH x\n' | missing_keys "$server_env" /dev/stdin)"
fi
[[ -z "$miss" ]] || die "server-secrets ontbreken: $(tr '\n' ' ' <<<"$miss")(zie infra/secrets/server.keys en RUNBOOK.md §5)"

export HZ_INSTANCE="$instance" HZ_TAG="$tag" HZ_APP_ENV_FILE="$appenv"
if [[ "$env" == prod ]]; then
  export HZ_ENVIRONMENT=production HZ_PUBLIC_URL="https://$HZ_DOMAIN"
else
  export HZ_ENVIRONMENT=test HZ_PUBLIC_URL="https://$HZ_TEST_DOMAIN"
fi

compose_app() { "$HZ_DOCKER" compose -p "$instance" --env-file "$HZ_ETC/hz.env" --env-file "$secrets" -f "$infra/compose/app.yaml" "$@"; }
mapfile -t router_args < <(router_files "$infra")
compose_router() { HZ_ROUTER_DIR="$HZ_ROOT/router" HZ_PREVIEWS_ALLOW_DIR="$HZ_ROOT/previews/allow" "$HZ_DOCKER" compose -p hz-workspace-router --env-file "$HZ_ETC/hz.env" --env-file "$server_env" "${router_args[@]}" "$@"; }
compose_edge() { HZ_EDGE_DIR="$HZ_ROOT/edge" "$HZ_DOCKER" compose -p hz-workspace-edge --env-file "$HZ_ETC/hz.env" -f "$infra/compose/edge.yaml" "$@"; }

# Kopieer een bestand alleen als het anders is; zegt of het veranderde.
sync_file() {
  if cmp -s "$1" "$2"; then return 1; fi
  cat "$1" >"$2"
  chmod 644 "$2"
}

# 2. Router: Caddyfile naar een vaste map, starten als hij nog niet draait, anders herladen zonder onderbreking.
ensure_net
router_changed=0
sync_file "$infra/caddy/router/Caddyfile" "$HZ_ROOT/router/Caddyfile" && router_changed=1
compose_router up -d --wait --wait-timeout 60 || die "router start niet"
if ((router_changed)); then
  compose_router exec -T router caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile || die "router herladen mislukt"
  log "router herladen"
fi

# Site-blok voor de bestaande proxy (Caddy) of de eigen edge. De bestaande proxy is van de andere projecten: deze
# uitrol herlaadt hem niet zelf. Verandert het blok (alleen bij een ander domein), dan zegt de log het.
case "$HZ_PROXY_KIND" in
  caddy)
    before="$(cat "$HZ_ROOT/proxy/hz-workspace.caddy" "$HZ_ROOT/proxy/hz-workspace.global.caddy" 2>/dev/null || true)"
    "$here/proxy-snippet.sh" caddy --out "$HZ_ROOT/proxy" 2>/dev/null
    if [[ -n "$before" && "$before" != "$(cat "$HZ_ROOT/proxy/hz-workspace.caddy" "$HZ_ROOT/proxy/hz-workspace.global.caddy")" ]]; then
      log "LET OP: site-blok voor de proxy gewijzigd ($HZ_ROOT/proxy); valideer en herlaad de bestaande proxy (RUNBOOK.md §2)"
    fi
    ;;
  eigen)
    "$here/proxy-snippet.sh" caddy --out "$HZ_ROOT/edge" 2>/dev/null
    sync_file "$infra/caddy/edge/Caddyfile" "$HZ_ROOT/edge/Caddyfile" || true
    compose_edge up -d --wait --wait-timeout 60 || die "eigen edge start niet"
    compose_edge exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile || die "eigen edge herladen mislukt"
    ;;
esac

# Foutregistratie (GlitchTip) hoort bij productie; alleen als de server-secrets ervoor er zijn.
if [[ "$env" == prod ]] && grep -Eq '^HZ_GLITCHTIP_SECRET_KEY=.+' "$server_env"; then
  "$HZ_DOCKER" compose -p hz-workspace-ops --env-file "$HZ_ETC/hz.env" --env-file "$server_env" -f "$infra/compose/ops.yaml" up -d --remove-orphans ||
    log "GlitchTip start niet; uitrol gaat door (zie RUNBOOK.md, Monitoring)"
fi

prev="$(cat "$state/current" 2>/dev/null || true)"

# 3. Productie: eerst een back-up van de huidige database (een migratie gaat alleen vooruit).
if [[ "$env" == prod && -n "$prev" && "${HZ_SKIP_PREDEPLOY_BACKUP:-0}" != 1 ]]; then
  log "back-up vóór uitrol"
  (load_env "$server_env" && "$here/backup.sh" --label pre-deploy) || die "back-up vóór uitrol mislukt; uitrol gestopt"
fi

health_ok() {
  local url="${HZ_HEALTH_URL:-$HZ_PUBLIC_URL/api/health}" i body
  for ((i = 1; i <= ${HZ_HEALTH_TRIES:-30}; i++)); do
    if body="$("$HZ_CURL" -fsS -m 10 "$url" 2>/dev/null)" && [[ "$body" == *'"ok":true'* && "$body" != *'"db":"error"'* ]]; then
      log "health-check groen: ${url%%\?*}"
      return 0
    fi
    sleep "${HZ_HEALTH_SLEEP:-2}"
  done
  log "health-check rood na ${HZ_HEALTH_TRIES:-30} pogingen: ${url%%\?*}"
  return 1
}

up() {
  # Rollen en wachtwoorden elke uitrol gelijkzetten met de secrets (hz-roles.sh is idempotent): een gewisseld
  # databasewachtwoord gaat zo vanzelf mee, ook op een database van vóór een wijziging aan de rollen.
  compose_app pull --quiet &&
    compose_app up -d --wait --wait-timeout 120 db &&
    compose_app exec -T db /docker-entrypoint-initdb.d/10-hz-roles.sh &&
    compose_app run --rm migrate &&
    compose_app up -d --remove-orphans --wait --wait-timeout "${HZ_WAIT_TIMEOUT:-300}"
}

# 4. Vervangen, controleren, en bij twijfel terug naar de vorige versie.
log "uitrol $env: ${prev:-(eerste keer)} -> $tag"
if up && health_ok; then
  [[ -n "$prev" && "$prev" != "$tag" ]] && printf '%s\n' "$prev" >"$state/previous"
  printf '%s\n' "$tag" >"$state/current"
  ln -sfn "$bundle" "$state/bundle"
  printf '%s %s %s %s ok\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$env" "$tag" "${prev:--}" >>"$HZ_LOG_DIR/deploys.log"
  log "uitrol $env geslaagd: $tag"
else
  printf '%s %s %s %s mislukt\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$env" "$tag" "${prev:--}" >>"$HZ_LOG_DIR/deploys.log"
  if [[ -n "$prev" && "$prev" != "$tag" ]]; then
    log "terug naar $prev"
    export HZ_TAG="$prev"
    if compose_app up -d --remove-orphans --wait --wait-timeout "${HZ_WAIT_TIMEOUT:-300}" && health_ok; then
      printf '%s %s %s %s teruggezet\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$env" "$prev" "$tag" >>"$HZ_LOG_DIR/deploys.log"
      die "uitrol $tag mislukt; $prev draait weer"
    fi
    die "uitrol $tag mislukt EN terugzetten naar $prev mislukt: zie RUNBOOK.md, 'Plat'"
  fi
  die "uitrol $tag mislukt (geen vorige versie om naar terug te gaan)"
fi

# 5. Opruimen: oude bundels (houd de 5 nieuwste plus wat in gebruik is) en onze eigen oude images. Nooit
# 'docker image prune': op deze server staan images van andere projecten.
keep="$(cat "$HZ_ROOT"/env/*/current "$HZ_ROOT"/env/*/previous 2>/dev/null | sort -u || true)"
if [[ -d "$HZ_ROOT/releases" ]]; then
  # shellcheck disable=SC2012 # namen zijn tags; sorteren op tijd
  while IFS= read -r dir; do
    t="$(basename "$dir")"
    grep -qxF "$t" <<<"$keep" || rm -rf "$dir"
  done < <(ls -1dt "$HZ_ROOT"/releases/*/ 2>/dev/null | tail -n +6)
fi
previews="$(cat "$HZ_ROOT"/previews/pr-*/tag 2>/dev/null || true)"
for repo in "$HZ_REGISTRY/hz-api" "$HZ_REGISTRY/hz-worker" "$HZ_REGISTRY/hz-web"; do
  while IFS= read -r t; do
    [[ -n "$t" && "$t" != "<none>" ]] || continue
    grep -qxF "$t" <<<"$keep"$'\n'"$previews" && continue
    "$HZ_DOCKER" image rm "$repo:$t" >/dev/null 2>&1 || true
  done < <("$HZ_DOCKER" image ls "$repo" --format '{{.Tag}}' 2>/dev/null || true)
done
