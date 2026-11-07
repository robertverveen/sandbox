#!/usr/bin/env bash
# Alle statische controles van de infra in één keer (HZW-001..008), lokaal en in de workflow workspace-infra.
# Wat ontbreekt aan gereedschap wordt gemeld; met HZ_VALIDATE_STRICT=1 (CI) is een ontbrekend programma een fout.
#
#   bash -n + shellcheck   alle scripts
#   actionlint             de workflows in <git-root>/.github/workflows/workspace-*.yml
#   caddy validate         edge-Caddyfile en web-Caddyfile (met een CSP uit de echte index.html)
#   docker compose config  app, edge en ops met voorbeeldwaarden
#   systemd-analyze        kalenders van de timers
#   cloud-init             renderen met voorbeeldwaarden (het schema controleert de vitest-test)
set -uo pipefail
infra="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app="$(dirname "$infra")"
root="$(dirname "$app")"
strict="${HZ_VALIDATE_STRICT:-0}"
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

if have caddy; then
  # shellcheck disable=SC2016 # een bcrypt-hash bevat letterlijke $-tekens
  if HZ_DOMAIN=homezero.verveen.me HZ_TEST_DOMAIN=test.homezero.verveen.me HZ_ERRORS_DOMAIN=fouten.homezero.verveen.me \
    HZ_ACME_EMAIL=ops@example.nl HZ_PREVIEW_USER=hz HZ_PREVIEW_HASH='$2a$14$Zkx19XLiW6VYouLHR5NmfOFU0z2GTNmpkT/5qqR7hx4IjWJPDhjvG' \
    caddy validate --adapter caddyfile --config "$infra/caddy/Caddyfile" >"$tmp/edge.log" 2>&1; then
    ok "caddy: edge"
  else
    bad "caddy: edge"
    tail -n 5 "$tmp/edge.log"
  fi
  html="$app/apps/web/dist/index.html"
  [[ -f "$html" ]] || html="$app/apps/web/index.html"
  mkdir -p "$tmp/etc/caddy"
  node "$infra/docker/web-csp.mjs" "$html" "$tmp/etc/caddy/csp.caddy" >/dev/null
  sed "s#/etc/caddy/csp.caddy#$tmp/etc/caddy/csp.caddy#" "$infra/docker/web.Caddyfile" >"$tmp/web.Caddyfile"
  if caddy validate --adapter caddyfile --config "$tmp/web.Caddyfile" >"$tmp/web.log" 2>&1; then ok "caddy: web"; else
    bad "caddy: web"
    tail -n 5 "$tmp/web.log"
  fi
  if caddy fmt "$infra/caddy/Caddyfile" | diff -q - "$infra/caddy/Caddyfile" >/dev/null &&
    caddy fmt "$infra/docker/web.Caddyfile" | diff -q - "$infra/docker/web.Caddyfile" >/dev/null; then
    ok "caddy fmt"
  else bad "caddy fmt: draai caddy fmt --overwrite"; fi
else missing caddy; fi

if have docker && docker compose version >/dev/null 2>&1; then
  for f in app edge ops; do
    if env HZ_INSTANCE=hz-prod HZ_PG_SUPERUSER_PASSWORD=x HZ_PG_MIGRATOR_PASSWORD=x HZ_PG_APP_PASSWORD=x HZ_PG_BACKUP_PASSWORD=x \
      HZ_REGISTRY=ghcr.io/homezerotech HZ_TAG=sha-0000000 HZ_APP_ENV_FILE=/dev/null HZ_ENVIRONMENT=production \
      HZ_PUBLIC_URL=https://homezero.verveen.me HZ_DOMAIN=homezero.verveen.me HZ_TEST_DOMAIN=test.homezero.verveen.me \
      HZ_ERRORS_DOMAIN=fouten.homezero.verveen.me HZ_ACME_EMAIL=ops@example.nl HZ_PREVIEW_HASH=x \
      HZ_GLITCHTIP_DB_PASSWORD=x HZ_GLITCHTIP_SECRET_KEY=x \
      docker compose -f "$infra/compose/$f.yaml" config -q 2>"$tmp/compose.log"; then
      ok "compose: $f"
    else
      bad "compose: $f"
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
if node "$infra/cloud-init/render.mjs" --domain homezero.verveen.me --acme-email ops@example.nl \
  --registry ghcr.io/homezerotech --admin-keys "$tmp/k.pub" --deploy-key "$tmp/k.pub" --out "$tmp/ud.yaml" &&
  head -n1 "$tmp/ud.yaml" | grep -qx '#cloud-config'; then
  ok "cloud-init rendert"
else bad "cloud-init"; fi

if ((fails)); then
  printf '\n%d controle(s) rood\n' "$fails"
  exit 1
fi
printf '\nalle infra-controles groen\n'
