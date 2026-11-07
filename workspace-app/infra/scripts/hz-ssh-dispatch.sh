#!/usr/bin/env bash
# Vaste opdracht (forced command) voor de SSH-sleutel van GitHub Actions op de server (HZW-004/005).
# Staat in /home/deploy/.ssh/authorized_keys als: restrict,command="/opt/hz/bin/hz-ssh-dispatch" ssh-ed25519 ...
# De CI-sleutel kan dus géén shell openen; alleen deze opdrachten, met gecontroleerde argumenten:
#
#   deploy <prod|test> <tag>      images ophalen, uitrolbundel uitpakken, deploy.sh van die versie draaien
#   rollback <prod|test>          terug naar de vorige versie (bundel en images staan nog op de server)
#   preview up <nr> <tag>         preview van pull request <nr> starten of bijwerken
#   preview down <nr>             preview opruimen
#   status                        wat draait er (versies, previews, containers)
#   check                         servercontrole (server-check.sh --markdown)
#
# Een registry-token (GITHUB_TOKEN van de workflow, alleen packages:read, verloopt na de job) komt op stdin mee
# en wordt alleen in een tijdelijke DOCKER_CONFIG gebruikt; op de server staat geen blijvend registry-token.
set -euo pipefail
HZ_ROOT="${HZ_ROOT:-/opt/hz}"
HZ_ETC="${HZ_ETC:-/etc/hz}"
HZ_DOCKER="${HZ_DOCKER:-docker}"

log() { printf '%s [dispatch] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() {
  log "FOUT: $*"
  exit 1
}
valid_env() { [[ "$1" == prod || "$1" == test ]]; }
valid_tag() { [[ "$1" =~ ^(sha-[0-9a-f]{7,40}|v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?|pr-[0-9]{1,6}-[0-9a-f]{7,40})$ ]]; }
valid_pr() { [[ "$1" =~ ^[0-9]{1,6}$ ]]; }

registry="$(sed -n -E 's/^HZ_REGISTRY=(.*)$/\1/p' "$HZ_ETC/hz.env" | tail -n1)"
[[ "$registry" =~ ^[a-z0-9.-]+(/[a-z0-9._-]+)+$ ]] || die "HZ_REGISTRY ontbreekt of is ongeldig in $HZ_ETC/hz.env"

cmdline="${SSH_ORIGINAL_COMMAND:-}"
[[ "$cmdline" =~ ^[a-z0-9\ .-]*$ ]] || die "niet toegestaan"
read -r -a a <<<"$cmdline"
logger -t hz-dispatch "opdracht: $cmdline" 2>/dev/null || true

dcfg=""
cleanup() { [[ -n "$dcfg" ]] && rm -rf "$dcfg"; return 0; }
trap cleanup EXIT

login_from_stdin() {
  local token=""
  if [[ ! -t 0 ]]; then IFS= read -r -t 10 token || true; fi
  [[ -n "$token" ]] || return 0
  dcfg="$(mktemp -d)"
  export DOCKER_CONFIG="$dcfg"
  printf '%s' "$token" | "$HZ_DOCKER" login "${registry%%/*}" -u hz-deploy --password-stdin >/dev/null || die "inloggen bij de registry mislukt"
}

# Haal het api-image van <tag> op en pak de uitrolbundel uit naar releases/<tag>.
fetch_bundle() {
  local tag="$1" dir="$HZ_ROOT/releases/$1" cid
  "$HZ_DOCKER" pull --quiet "$registry/hz-api:$tag" >/dev/null || die "image hz-api:$tag niet gevonden"
  if [[ ! -f "$dir/.compleet" ]]; then
    rm -rf "$dir.tmp"
    mkdir -p "$dir.tmp"
    cid="$("$HZ_DOCKER" create "$registry/hz-api:$tag")"
    "$HZ_DOCKER" cp "$cid:/app/bundle/." "$dir.tmp/" || { "$HZ_DOCKER" rm "$cid" >/dev/null; die "bundel uitpakken mislukt"; }
    "$HZ_DOCKER" rm "$cid" >/dev/null
    : >"$dir.tmp/.compleet"
    rm -rf "$dir"
    mv "$dir.tmp" "$dir"
  fi
  printf '%s\n' "$dir"
}

case "${a[0]:-}" in
  deploy)
    if ! { valid_env "${a[1]:-}" && valid_tag "${a[2]:-}" && ((${#a[@]} == 3)); }; then die "gebruik: deploy <prod|test> <tag>"; fi
    login_from_stdin
    dir="$(fetch_bundle "${a[2]}")"
    "$dir/infra/scripts/deploy.sh" "${a[1]}" "${a[2]}"
    ;;
  rollback)
    if ! { valid_env "${a[1]:-}" && ((${#a[@]} == 2)); }; then die "gebruik: rollback <prod|test>"; fi
    prev="$(cat "$HZ_ROOT/env/${a[1]}/previous" 2>/dev/null || true)"
    if ! { valid_tag "$prev"; }; then die "geen vorige versie bekend voor ${a[1]}"; fi
    [[ -f "$HZ_ROOT/releases/$prev/.compleet" ]] || die "bundel van $prev staat niet meer op de server; rol $prev opnieuw uit via de workflow"
    "$HZ_ROOT/releases/$prev/infra/scripts/deploy.sh" "${a[1]}" "$prev"
    ;;
  preview)
    case "${a[1]:-}" in
      up)
        if ! { valid_pr "${a[2]:-}" && valid_tag "${a[3]:-}" && ((${#a[@]} == 4)); }; then die "gebruik: preview up <nr> <tag>"; fi
        login_from_stdin
        dir="$(fetch_bundle "${a[3]}")"
        "$dir/infra/scripts/preview.sh" up "${a[2]}" "${a[3]}"
        ;;
      down)
        if ! { valid_pr "${a[2]:-}" && ((${#a[@]} == 3)); }; then die "gebruik: preview down <nr>"; fi
        tag="$(cat "$HZ_ROOT/previews/pr-${a[2]}/tag" 2>/dev/null || true)"
        dir="$HZ_ROOT/releases/$tag"
        if ! valid_tag "$tag" || [[ ! -f "$dir/.compleet" ]]; then
          dir="$(readlink -f "$HZ_ROOT/env/test/bundle" 2>/dev/null || true)"
        fi
        [[ -x "$dir/infra/scripts/preview.sh" ]] || die "geen bundel om de preview mee op te ruimen"
        "$dir/infra/scripts/preview.sh" down "${a[2]}"
        ;;
      *) die "gebruik: preview up|down ..." ;;
    esac
    ;;
  status)
    for e in prod test; do
      printf '%s: %s (vorige: %s)\n' "$e" "$(cat "$HZ_ROOT/env/$e/current" 2>/dev/null || echo -)" "$(cat "$HZ_ROOT/env/$e/previous" 2>/dev/null || echo -)"
    done
    for d in "$HZ_ROOT"/previews/pr-*/; do
      [[ -d "$d" ]] && printf 'preview %s: %s\n' "$(basename "$d")" "$(cat "$d/tag" 2>/dev/null || echo ?)"
    done
    "$HZ_DOCKER" ps --format '{{.Names}}\t{{.Status}}'
    ;;
  check)
    ((${#a[@]} == 1)) || die "gebruik: check"
    # Vaste kopie van root (cloud-init), met een sudo-regel voor precies deze opdracht: sshd -T en ufw vragen root.
    sudo -n "$HZ_ROOT/bin/hz-server-check" --markdown
    ;;
  *) die "niet toegestaan: ${a[0]:-<leeg>}" ;;
esac
