#!/usr/bin/env bash
# Preview per pull request (HZW-005): pr-<nr>.<HZ_TEST_DOMAIN>, met eigen database, op demodata (fixtures) en
# achter het previewwachtwoord (router). Wordt opgeruimd zodra de PR sluit (workflow workspace-preview).
# Elke preview is een eigen compose-project hz-workspace-pr-<nr> met kleinere limieten; maximaal HZ_PREVIEW_MAX (3).
#
#   preview.sh up <nr> <tag>     starten of bijwerken
#   preview.sh down <nr>         stoppen en alles weg (containers, database, certificaat-aanmelding)
#   preview.sh list              welke previews draaien
#
# Previews hebben geen echte secrets: wachtwoorden en HZ_TOKEN_KEY worden per preview willekeurig gemaakt, er is
# geen koppeling met Google/Slack en de app draait op fixtures (nooit echte partnerdata).
set -euo pipefail
HZ_SCRIPT=preview
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$here/lib.sh"
infra="$(dirname "$here")"

load_env "$HZ_ETC/hz.env"
: "${HZ_TEST_DOMAIN:?}" "${HZ_REGISTRY:?}"
previews="$HZ_ROOT/previews"
allow="$previews/allow"
max="${HZ_PREVIEW_MAX:-3}"
mkdir -p "$allow"

compose_pr() {
  local nr="$1"
  shift
  "$HZ_DOCKER" compose -p "hz-workspace-pr-$nr" --env-file "$HZ_ETC/hz.env" --env-file "$previews/pr-$nr/.env" -f "$infra/compose/app.yaml" "$@"
}

down() {
  local nr="$1"
  if [[ -f "$previews/pr-$nr/.env" ]]; then
    compose_pr "$nr" down -v --remove-orphans --timeout 20 || log "compose down gaf een fout; ga door met opruimen"
  fi
  rm -f "$allow/pr-$nr.$HZ_TEST_DOMAIN"
  rm -rf "$previews/pr-$nr"
  log "preview pr-$nr opgeruimd"
}

list() {
  local d
  for d in "$previews"/pr-*/; do
    [[ -d "$d" ]] || continue
    printf '%s %s\n' "$(basename "$d")" "$(cat "$d/tag" 2>/dev/null || echo '?')"
  done
}

cmd="${1:-}"
case "$cmd" in
  up)
    nr="${2:-}"
    tag="${3:-}"
    valid_pr "$nr" || die "ongeldig PR-nummer"
    valid_tag "$tag" || die "ongeldige tag"
    dir="$previews/pr-$nr"
    exec 9>"$previews/.lock"
    flock -w 300 9 || die "wacht te lang op een andere preview-actie"
    if [[ ! -d "$dir" ]]; then
      # Te veel previews: de oudste gaat eruit (de server is er niet op berekend om er tientallen te draaien).
      count="$(find "$previews" -maxdepth 1 -type d -name 'pr-*' | wc -l)"
      while ((count >= max)); do
        # shellcheck disable=SC2012 # namen zijn pr-<nr>, sorteren op tijd kan find niet zonder omweg
        oldest="$(ls -1dtr "$previews"/pr-*/ | head -n1)"
        old_nr="$(basename "$oldest")"
        old_nr="${old_nr#pr-}"
        log "maximaal $max previews: pr-$old_nr wordt opgeruimd"
        down "$old_nr"
        count=$((count - 1))
      done
      (umask 077 && mkdir -p "$dir" && {
        printf 'HZ_PG_SUPERUSER_PASSWORD=%s\n' "$(openssl rand -hex 24)"
        printf 'HZ_PG_MIGRATOR_PASSWORD=%s\n' "$(openssl rand -hex 24)"
        printf 'HZ_PG_APP_PASSWORD=%s\n' "$(openssl rand -hex 24)"
        printf 'HZ_PG_BACKUP_PASSWORD=%s\n' "$(openssl rand -hex 24)"
      } >"$dir/.env" && printf 'HZ_TOKEN_KEY=%s\nHZ_AUTH_SECRET=%s\n' "$(openssl rand -base64 32)" "$(openssl rand -base64 32)" >"$dir/app.env")
    fi
    host="pr-$nr.$HZ_TEST_DOMAIN"
    export HZ_INSTANCE="hz-workspace-pr-$nr" HZ_TAG="$tag" HZ_APP_ENV_FILE="$dir/app.env" HZ_ENVIRONMENT=preview \
      HZ_PUBLIC_URL="https://$host" HZ_NODE_ENV=development HZ_DEV_LOGIN=1 HZ_FIXTURE_SET=demo \
      HZ_MEM_DB="${HZ_PREVIEW_MEM_DB:-384m}" HZ_MEM_API="${HZ_PREVIEW_MEM_API:-256m}" HZ_MEM_WORKER="${HZ_PREVIEW_MEM_WORKER:-256m}" \
      HZ_CPUS_DB=0.5 HZ_CPUS_API=0.5 HZ_CPUS_WORKER=0.5
    ensure_net
    compose_pr "$nr" pull --quiet
    compose_pr "$nr" up -d --remove-orphans --wait --wait-timeout "${HZ_WAIT_TIMEOUT:-300}" || die "preview pr-$nr wordt niet gezond"
    # Health-check binnen de instantie (de router vraagt een wachtwoord): web -> api -> database.
    body="$(compose_pr "$nr" exec -T web wget -q -O - http://127.0.0.1:8080/api/health)" || die "health-check pr-$nr faalt"
    [[ "$body" == *'"ok":true'* && "$body" != *'"db":"error"'* ]] || die "health-check pr-$nr: $body"
    printf '%s\n' "$tag" >"$dir/tag"
    # Pas nu mag de proxy een certificaat voor deze naam aanvragen (on-demand TLS: de router antwoordt op /ask).
    : >"$allow/$host"
    log "preview klaar: https://$host ($tag)"
    printf 'https://%s\n' "$host"
    ;;
  down)
    nr="${2:-}"
    valid_pr "$nr" || die "ongeldig PR-nummer"
    exec 9>"$previews/.lock"
    flock -w 300 9 || die "wacht te lang op een andere preview-actie"
    down "$nr"
    ;;
  list) list ;;
  *)
    sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
