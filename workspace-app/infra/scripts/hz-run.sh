#!/usr/bin/env bash
# Start een beheerscript uit de uitrolbundel van productie, met de server-secrets in de omgeving (alleen voor dit
# proces). Voor de systemd-timers (back-up, hersteltest, hartslag), en voor beheerders:
#
#   /opt/hz/bin/hz-run backup.sh --label handmatig
#   /opt/hz/bin/hz-run hersteltest.sh
#   /opt/hz/bin/hz-run heartbeat.sh
#
# Wordt door cloud-init op /opt/hz/bin/hz-run gezet (root, niet schrijfbaar voor deploy).
set -euo pipefail
HZ_SCRIPT=hz-run
HZ_ROOT="${HZ_ROOT:-/opt/hz}"
HZ_ETC="${HZ_ETC:-/etc/hz}"
HZ_RUN="${HZ_RUN:-/run/hz}"
# shellcheck source=lib.sh
source "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/lib.sh"

script="${1:-}"
shift || true
[[ "$script" =~ ^(backup|hersteltest|heartbeat|restore)\.sh$ ]] || die "niet toegestaan: ${script:-<leeg>} (backup.sh, hersteltest.sh, heartbeat.sh, restore.sh)"

bundle=""
for e in prod test; do
  if [[ -d "$HZ_ROOT/env/$e/bundle/infra/scripts" ]]; then
    bundle="$(readlink -f "$HZ_ROOT/env/$e/bundle")"
    break
  fi
done
[[ -n "$bundle" ]] || die "nog geen uitrol op deze server"

load_env "$HZ_ETC/hz.env"
mkdir -p "$HZ_RUN"
umask 077
server_env="$(mktemp "$HZ_RUN/server-run.XXXXXX")"
trap 'rm -f "$server_env"' EXIT
if [[ -f "$bundle/infra/secrets/server.env.age" ]]; then
  "$HZ_AGE" -d -i "$HZ_AGE_IDENTITY" -o "$server_env" "$bundle/infra/secrets/server.env.age" || die "server-secrets ontsleutelen mislukt"
  load_env "$server_env"
fi
"$bundle/infra/scripts/$script" "$@"
