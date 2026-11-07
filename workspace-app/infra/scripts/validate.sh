#!/usr/bin/env bash
# Alle statische controles van de infra in één keer (HZW-001..008), lokaal en in de workflow workspace-infra.
# Wat ontbreekt aan gereedschap wordt gemeld; met HZ_VALIDATE_STRICT=1 (CI) is een ontbrekend programma een fout.
#
#   bash -n + shellcheck   alle scripts
#   actionlint             de workflows in <git-root>/.github/workflows/workspace-*.yml
#   caddy validate         router, site-blok in een bestaande Caddy, eigen edge en web-Caddyfile (CSP uit index.html)
#   docker compose config  app, ops, router (met elke proxyvariant) en edge met voorbeeldwaarden
#   systemd-analyze        kalenders van de timers
#   cloud-init             renderen met voorbeeldwaarden (het schema controleert de vitest-test)
#   prettier --check       de hele app (zelfde stap als pnpm format:check in workspace-app.yml)
set -uo pipefail
infra="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app="$(dirname "$infra")"
root="$(dirname "$app")"; [ -d "$app/.github/workflows" ] && root="$app"   # eigen repo: de app is de git-root
strict="${HZ_VALIDATE_STRICT:-0}"
# Gereedschap uit 'go install' (actionlint, caddy) staat vaak niet in PATH.
if command -v go >/dev/null 2>&1; then PATH="$PATH:$(go env GOPATH)/bin"; fi
fails=0
ok() { printf 'OK    %s\n' "$*"; }
bad() {
  printf 'FOUT  %s\n' "$*"
  fails=$((fails + 1))
}
missing() {
  if [[ "$strict" == 1 ]]; then bad "$1 ontbreekt"; else printf 'OVER  %s ontbreekt (installeer voor de volledige controle)\n' "$1"; fi
}
have() { command -v "$1" >/dev/null 2>&1; }

mapfile -t scripts < <(find "$infra/scripts" "$infra/postgres" "$infra/docker" -name '*.sh' | sort)

for s in "${scripts[@]}"; do bash -n "$s" || bad "bash -n $s"; done
ok "bash -n: ${#scripts[@]} scripts"

if have shellcheck; then
  if (cd "$infra/scripts" && shellcheck -x -- *.sh) && shellcheck -x "$infra/postgres/"*.sh "$infra/docker/"*.sh; then ok shellcheck; else bad shellcheck; fi
else missing shellcheck; fi

if have actionlint; then
  mapfile -t wfs < <(find "$root/.github/workflows" -name 'workspace-*.yml' | sort)
  if (cd "$root" && actionlint "${wfs[@]}"); then ok "actionlint: ${#wfs[@]} workflows"; else bad actionlint; fi
else missing actionlint; fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Zelfde opmaakcontrole als workspace-app.yml (pnpm format:check): rood daar = rood hier.
if [[ -x "$app/node_modules/.bin/prettier" ]]; then
  if (cd "$app" && node_modules/.bin/prettier --check . >"$tmp/prettier.log" 2>&1); then ok "prettier --check (format:check)"; else
    bad "prettier --check (format:check): draai pnpm format of zet een map van anderen in .prettierignore"
    grep -E '^\[warn\]' "$tmp/prettier.log" | head -n 10
  fi
else missing prettier; fi

if have caddy; then
  # shellcheck disable=SC2016 # een bcrypt-hash bevat letterlijke $-tekens
  export HZ_DOMAIN=homezero.verveen.me HZ_TEST_DOMAIN=test.homezero.verveen.me HZ_ERRORS_DOMAIN=fouten.homezero.verveen.me \
    HZ_ACME_EMAIL=ops@example.nl HZ_PREVIEW_USER=hz HZ_PREVIEW_HASH='$2a$14$Zkx19XLiW6VYouLHR5NmfOFU0z2GTNmpkT/5qqR7hx4IjWJPDhjvG'
  cvalidate() { # naam config
    if caddy validate --adapter caddyfile --config "$2" >"$tmp/caddy.log" 2>&1; then ok "caddy: $1"; else
      bad "caddy: $1"
      tail -n 5 "$tmp/caddy.log"
    fi
  }
  cvalidate router "$infra/caddy/router/Caddyfile"
  # Site-blok in een bestaande Caddy (zoals op de server van Robert): andere sites blijven, wij importeren erbij.
  mkdir -p "$tmp/proxy"
  HZ_PROXY_NETWORK=caddy bash "$infra/scripts/proxy-snippet.sh" caddy --out "$tmp/proxy" 2>/dev/null
  printf '{\n\temail ops@example.nl\n\timport %s/hz-workspace.global.caddy\n}\n\nblog.example.nl {\n\trespond "blog"\n}\n\nimport %s/hz-workspace.caddy\n' \
    "$tmp/proxy" "$tmp/proxy" >"$tmp/bestaand.Caddyfile"
  cvalidate "site-blok in een bestaande Caddy" "$tmp/bestaand.Caddyfile"
  sed "s#/etc/caddy/#$tmp/proxy/#" "$infra/caddy/edge/Caddyfile" >"$tmp/edge.Caddyfile"
  cvalidate "eigen edge (HZW-082)" "$tmp/edge.Caddyfile"
  html="$app/apps/web/dist/index.html"
  [[ -f "$html" ]] || html="$app/apps/web/index.html"
  mkdir -p "$tmp/etc/caddy"
  node "$infra/docker/web-csp.mjs" "$html" "$tmp/etc/caddy/csp.caddy" >/dev/null
  sed "s#/etc/caddy/csp.caddy#$tmp/etc/caddy/csp.caddy#" "$infra/docker/web.Caddyfile" >"$tmp/web.Caddyfile"
  if caddy validate --adapter caddyfile --config "$tmp/web.Caddyfile" >"$tmp/web.log" 2>&1; then ok "caddy: web"; else
    bad "caddy: web"
    tail -n 5 "$tmp/web.log"
  fi
  if caddy fmt "$infra/caddy/router/Caddyfile" | diff -q - "$infra/caddy/router/Caddyfile" >/dev/null &&
    caddy fmt "$infra/caddy/edge/Caddyfile" | diff -q - "$infra/caddy/edge/Caddyfile" >/dev/null &&
    caddy fmt "$tmp/proxy/hz-workspace.caddy" | diff -q - "$tmp/proxy/hz-workspace.caddy" >/dev/null &&
    caddy fmt "$infra/docker/web.Caddyfile" | diff -q - "$infra/docker/web.Caddyfile" >/dev/null; then
    ok "caddy fmt"
  else bad "caddy fmt: draai caddy fmt --overwrite"; fi
else missing caddy; fi

if have docker && docker compose version >/dev/null 2>&1; then
  c="$infra/compose"
  d64="$(printf '0%.0s' {1..64})"
  for files in "app.yaml" "ops.yaml" "router.yaml router-network.yaml" "router.yaml router-loopback.yaml" \
    "router.yaml router-network.yaml router-traefik.yaml" "edge.yaml"; do
    args=()
    for f in $files; do args+=(-f "$c/$f"); done
    if env HZ_INSTANCE=hz-workspace-prod HZ_PG_SUPERUSER_PASSWORD=x HZ_PG_MIGRATOR_PASSWORD=x HZ_PG_APP_PASSWORD=x HZ_PG_BACKUP_PASSWORD=x \
      HZ_PG_AUTH_PASSWORD=x HZ_PG_WORKER_PASSWORD=x HZ_PG_INDEXER_PASSWORD=x HZ_PG_BOSS_PASSWORD=x \
      HZ_REGISTRY=ghcr.io/homezerotech HZ_TAG=sha-0000000 HZ_IMAGE_API=ghcr.io/homezerotech/hz-api@sha256:"$d64" \
      HZ_IMAGE_WORKER=ghcr.io/homezerotech/hz-worker@sha256:"$d64" HZ_IMAGE_WEB=ghcr.io/homezerotech/hz-web:pr-1-abcdef1 HZ_APP_ENV_FILE=/dev/null HZ_ENVIRONMENT=production \
      HZ_PUBLIC_URL=https://homezero.verveen.me HZ_DOMAIN=homezero.verveen.me HZ_TEST_DOMAIN=test.homezero.verveen.me \
      HZ_ERRORS_DOMAIN=fouten.homezero.verveen.me HZ_ACME_EMAIL=ops@example.nl HZ_PREVIEW_HASH=x \
      HZ_GLITCHTIP_DB_PASSWORD=x HZ_GLITCHTIP_SECRET_KEY=x HZ_PROXY_NETWORK=caddy HZ_ROUTER_PORT=18780 \
      HZ_ROUTER_ASK_PORT=18781 'HZ_TEST_DOMAIN_RE=test\.homezero\.verveen\.me' \
      docker compose "${args[@]}" config -q 2>"$tmp/compose.log"; then
      ok "compose: $files"
    else
      bad "compose: $files"
      cat "$tmp/compose.log"
    fi
  done
else missing "docker compose"; fi

if have systemd-analyze; then
  for t in "$infra"/systemd/*.timer; do
    cal="$(sed -n 's/^OnCalendar=//p' "$t")"
    [[ -z "$cal" ]] && continue
    if systemd-analyze calendar "$cal" >/dev/null 2>&1; then ok "timer $(basename "$t")"; else bad "timer $(basename "$t"): $cal"; fi
  done
else missing systemd-analyze; fi

key="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBWwSuA/u/NZjfs+ajxeAO7ufsfPxULK4QoUEeQcdmjs voorbeeld"
printf '%s\n' "$key" >"$tmp/k.pub"
printf 'tskey-auth-voorbeeldvoorbeeld\n' >"$tmp/ts.key"
if node "$infra/cloud-init/render.mjs" --domain homezero.verveen.me --acme-email ops@example.nl \
  --registry ghcr.io/homezerotech --admin-keys "$tmp/k.pub" --deploy-key "$tmp/k.pub" \
  --tailscale-authkey-file "$tmp/ts.key" --out "$tmp/ud.yaml" &&
  head -n1 "$tmp/ud.yaml" | grep -qx '#cloud-config' && (($(wc -c <"$tmp/ud.yaml") < 32768)); then
  ok "cloud-init (optie HZW-082) rendert, onder 32 KiB"
else bad "cloud-init"; fi


if ((fails)); then
  printf '\n%d controle(s) rood\n' "$fails"
  exit 1
fi
printf '\nalle infra-controles groen\n'
