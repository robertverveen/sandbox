#!/usr/bin/env bash
# Vaste opdracht (forced command) voor de SSH-sleutels van GitHub Actions op de server (HZW-004/005).
# Elke sleutel heeft één doel en een eigen regel in authorized_keys; de rol staat vast in die regel, niet in wat de
# client vraagt (server-setup.sh zet ze zo neer):
#
#   /srv/hz-workspace/.ssh/authorized_keys          (gebruiker hz-workspace)
#     restrict,command="/srv/hz-workspace/bin/hz-ssh-dispatch test" <sleutel uit environment 'test'>
#     restrict,command="/srv/hz-workspace/bin/hz-ssh-dispatch prod" <sleutel uit environment 'production'>
#   /srv/hz-workspace/previews/.ssh/authorized_keys (gebruiker hz-preview: geen lid van de groep hz-workspace, kan
#                                                    etc/age.key dus niet lezen)
#     restrict,command="/srv/hz-workspace/bin/hz-ssh-dispatch preview" <sleutel uit environment 'preview'>
#
# Wat elke rol mag (alles anders wordt geweigerd):
#   test     deploy test <sha-tag> [<digest api> <digest worker> <digest web>]
#            rollback test | status | check | voorcheck
#   prod     deploy prod <v-tag> [<sha-tag die op test groen was>]
#            rollback prod | status | check | voorcheck
#   preview  preview up <nr> pr-<nr>-<commit> | preview down <nr>
#
# Waarom zo:
#   - Productie draait alleen een release (v-tag) die eerder als build van main op test groen was: dezelfde images
#     (zelfde digests), niets nieuws. Een PR-tag of een losse sha kan nooit naar productie of test.
#   - Images gaan per digest, niet per tag: tags in de registry zijn te overschrijven (ook door een workflow van een
#     pull request). De digests komen bij de eerste uitrol naar test uit de build-job van die run (environment
#     'test', alleen main) en liggen daarna vast in /srv/hz-workspace/images/<tag>.env.
#   - Een preview draait nooit een script uit het image van de pull request. preview.sh komt uit de bundel die nu op
#     test draait (code van main); van het PR-image worden alleen de containers gestart (read-only, zonder rechten,
#     zonder mounts van de server, zonder Docker-socket).
#
# Een registry-token (GITHUB_TOKEN van de workflow, alleen packages:read, verloopt na de job) komt op stdin mee
# en wordt alleen in een tijdelijke DOCKER_CONFIG gebruikt; op de server staat geen blijvend registry-token.
set -euo pipefail
HZ_SCRIPT=dispatch
# lib.sh staat naast dit script (server: /srv/hz-workspace/bin/lib.sh, root, niet schrijfbaar voor de CI-gebruikers).
# shellcheck source=lib.sh
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/lib.sh"

role="${1:-}"
[[ "$role" == test || "$role" == prod || "$role" == preview ]] || die "geen of onbekende rol in authorized_keys: ${role:-<leeg>}"

registry="$(sed -n -E 's/^HZ_REGISTRY=(.*)$/\1/p' "$HZ_ETC/hz.env" | tail -n1)"
[[ "$registry" =~ ^[a-z0-9.-]+(/[a-z0-9._-]+)+$ ]] || die "HZ_REGISTRY ontbreekt of is ongeldig in $HZ_ETC/hz.env"
export HZ_REGISTRY="$registry"

cmdline="${SSH_ORIGINAL_COMMAND:-}"
[[ "$cmdline" =~ ^[a-z0-9\ .-]*$ ]] || die "niet toegestaan"
read -r -a a <<<"$cmdline"
logger -t hz-dispatch "rol $role: $cmdline" 2>/dev/null || true
n=${#a[@]}

# Mag deze rol deze opdracht? (De rol is het doel van de sleutel; zie boven.)
allowed() {
  case "$role:${a[0]:-}:${a[1]:-}" in
    test:deploy:test | test:rollback:test | prod:deploy:prod | prod:rollback:prod) return 0 ;;
    test:status:* | test:check:* | test:voorcheck:* | prod:status:* | prod:check:* | prod:voorcheck:*) return 0 ;;
    preview:preview:up | preview:preview:down) return 0 ;;
  esac
  return 1
}
allowed || die "niet toegestaan voor de sleutel van $role: ${a[0]:-<leeg>} ${a[1]:-}"

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

images="$HZ_ROOT/images"
record() { printf '%s/%s.env\n' "$images" "$1"; }

# Leg de images van een build van main vast (eenmalig per tag; daarna wint het vastgelegde).
write_record() { # tag api worker web
  local f tmp
  f="$(record "$1")"
  mkdir -p "$images"
  tmp="$(mktemp "$images/.rec.XXXXXX")"
  printf '# hz-workspace: images van %s, vastgelegd %s\nHZ_IMAGE_API=%s/hz-api@sha256:%s\nHZ_IMAGE_WORKER=%s/hz-worker@sha256:%s\nHZ_IMAGE_WEB=%s/hz-web@sha256:%s\n' \
    "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$registry" "$2" "$registry" "$3" "$registry" "$4" >"$tmp"
  chmod 0644 "$tmp"
  mv "$tmp" "$f"
}
images_of() { grep -E '^HZ_IMAGE_' "$(record "$1")"; }

# Haal de images van <tag> per digest op en pak de uitrolbundel uit het api-image naar releases/<tag>.
fetch_bundle() {
  local tag="$1" dir="$HZ_ROOT/releases/$1" cid i
  load_images "$tag" # draait in $(...): de HZ_IMAGE_* blijven binnen deze functie
  for i in "$HZ_IMAGE_API" "$HZ_IMAGE_WORKER" "$HZ_IMAGE_WEB"; do
    "$HZ_DOCKER" pull --quiet "$i" >/dev/null || die "image $i niet gevonden"
  done
  if [[ ! -f "$dir/.compleet" ]]; then
    rm -rf "$dir.tmp"
    mkdir -p "$dir.tmp"
    chmod 0755 "$dir.tmp"
    cid="$("$HZ_DOCKER" create "$HZ_IMAGE_API")"
    "$HZ_DOCKER" cp "$cid:/app/bundle/." "$dir.tmp/" || { "$HZ_DOCKER" rm "$cid" >/dev/null; die "bundel uitpakken mislukt"; }
    "$HZ_DOCKER" rm "$cid" >/dev/null
    : >"$dir.tmp/.compleet"
    rm -rf "$dir"
    mv "$dir.tmp" "$dir"
  fi
  printf '%s\n' "$dir"
}

# De bundel die nu op test draait (code van main): daaruit komt preview.sh, nooit uit een PR-image.
trusted_bundle() {
  local b
  b="$(readlink -f "$HZ_ROOT/env/test/bundle" 2>/dev/null || true)"
  [[ -n "$b" && "$(dirname "$b")" == "$(readlink -f "$HZ_ROOT/releases")" ]] || die "nog geen uitrol op test: rol eerst main uit naar test (de preview gebruikt de scripts van test)"
  if ! { valid_tag test "$(basename "$b")" && [[ -f "$b/.compleet" && -x "$b/infra/scripts/preview.sh" ]]; }; then die "bundel van test is onvolledig: $b"; fi
  printf '%s\n' "$b"
}

case "${a[0]}" in
  deploy)
    env="${a[1]}"
    tag="${a[2]:-}"
    if [[ "$env" == test ]]; then
      if ! { valid_tag test "$tag" && ((n == 3 || n == 6)); }; then die "gebruik: deploy test sha-<commit> [<digest api> <digest worker> <digest web>]"; fi
      if ((n == 6)); then
        for d in "${a[@]:3}"; do valid_digest "$d" || die "ongeldige digest: $d"; done
        if [[ -f "$(record "$tag")" ]]; then
          [[ "$(images_of "$tag")" == "$(printf 'HZ_IMAGE_API=%s/hz-api@sha256:%s\nHZ_IMAGE_WORKER=%s/hz-worker@sha256:%s\nHZ_IMAGE_WEB=%s/hz-web@sha256:%s' "$registry" "${a[3]}" "$registry" "${a[4]}" "$registry" "${a[5]}")" ]] ||
            die "$tag is eerder met andere images uitgerold; een tag krijgt nooit nieuwe images (bouw een nieuwe commit)"
        else
          write_record "$tag" "${a[3]}" "${a[4]}" "${a[5]}"
        fi
      fi
      [[ -f "$(record "$tag")" ]] || die "$tag is hier nog nooit uitgerold: alleen een build van main (met digests uit de build-job) komt op test"
    else
      src="${a[3]:-}"
      if ! { valid_tag prod "$tag" && ((n == 3 || n == 4)) && { ((n == 3)) || valid_tag test "$src"; }; }; then die "gebruik: deploy prod v<x.y.z> [sha-<commit> die op test groen was]"; fi
      if [[ -f "$(record "$tag")" ]]; then
        # Opnieuw uitrollen of terugzetten van een release die hier al stond: precies dezelfde images.
        if [[ -n "$src" && "$(images_of "$tag")" != "$(images_of "$src" 2>/dev/null)" ]]; then die "$tag hoort bij andere images dan $src"; fi
      else
        [[ -n "$src" ]] || die "$tag stond hier nog nooit: een nieuwe release komt alleen via de releaseworkflow (met de sha die op test stond)"
        [[ -f "$images/$src.getest" && -f "$(record "$src")" ]] || die "$src is niet groen uitgerold op test; productie draait alleen wat op test stond"
        { printf '# hz-workspace: release %s = %s (op test groen)\n' "$tag" "$src"; images_of "$src"; } >"$images/.rec.$tag"
        chmod 0644 "$images/.rec.$tag"
        mv "$images/.rec.$tag" "$(record "$tag")"
      fi
    fi
    login_from_stdin
    dir="$(fetch_bundle "$tag")"
    "$dir/infra/scripts/deploy.sh" "$env" "$tag"
    # Groen op test: deze images mogen later als release naar productie.
    if [[ "$env" == test ]]; then : >"$images/$tag.getest"; fi
    ;;
  rollback)
    ((n == 2)) || die "gebruik: rollback ${a[1]}"
    prev="$(cat "$HZ_ROOT/env/${a[1]}/previous" 2>/dev/null || true)"
    valid_tag "${a[1]}" "$prev" || die "geen vorige versie bekend voor ${a[1]}"
    [[ -f "$(record "$prev")" && -f "$HZ_ROOT/releases/$prev/.compleet" ]] || die "bundel of images van $prev staan niet meer op de server; rol $prev opnieuw uit via de workflow"
    "$HZ_ROOT/releases/$prev/infra/scripts/deploy.sh" "${a[1]}" "$prev"
    ;;
  preview)
    nr="${a[2]:-}"
    if [[ "${a[1]}" == up ]]; then
      if ! { valid_pr "$nr" && valid_tag preview "${a[3]:-}" "$nr" && ((n == 4)); }; then die "gebruik: preview up <nr> pr-<nr>-<commit>"; fi
      bundle="$(trusted_bundle)"
      login_from_stdin
      # Alleen de images van de PR ophalen (compose pull in preview.sh); geen bundel uitpakken, geen script uit het image.
      "$bundle/infra/scripts/preview.sh" up "$nr" "${a[3]}"
    else
      if ! { valid_pr "$nr" && ((n == 3)); }; then die "gebruik: preview down <nr>"; fi
      bundle="$(trusted_bundle)"
      "$bundle/infra/scripts/preview.sh" down "$nr"
    fi
    ;;
  status)
    ((n == 1)) || die "gebruik: status"
    for e in prod test; do
      printf '%s: %s (vorige: %s)\n' "$e" "$(cat "$HZ_ROOT/env/$e/current" 2>/dev/null || echo -)" "$(cat "$HZ_ROOT/env/$e/previous" 2>/dev/null || echo -)"
    done
    for d in "$HZ_ROOT"/previews/pr-*/; do
      [[ -d "$d" ]] && printf 'preview %s: %s\n' "$(basename "$d")" "$(cat "$d/tag" 2>/dev/null || echo ?)"
    done
    "$HZ_DOCKER" ps --filter label=nl.homezero.workspace=1 --format '{{.Names}}\t{{.Status}}'
    ;;
  check)
    ((n == 1)) || die "gebruik: check"
    # Vaste kopie van root (server-setup.sh), met een sudo-regel voor precies deze opdracht: sshd -T en ufw vragen root.
    sudo -n "$HZ_ROOT/bin/hz-server-check" --markdown
    ;;
  voorcheck)
    ((n == 1)) || die "gebruik: voorcheck"
    "$HZ_ROOT/bin/hz-server-check" --voorcheck --markdown
    ;;
esac
