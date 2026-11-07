#!/usr/bin/env bash
# Uptime-hartslag (HZW-007). Elke 5 minuten via systemd (hz-workspace-heartbeat.timer):
#   - /api/health van productie via https (dus ook DNS, TLS, de bestaande proxy en de router);
#   - geen container van de workspace 'unhealthy' (andere projecten op de server tellen niet mee);
#   - schijf niet voller dan 85 %.
# Alles goed: ping naar HZ_HEARTBEAT_PING_URL. Iets mis: ping naar .../fail met de reden (zonder persoonsgegevens).
# Ligt de hele server plat, dan komt er géén ping, en meldt de uptime-dienst (healthchecks.io of compatibel) dat na
# de afgesproken wachttijd aan Robert (mail of Slack-DM). Zo werkt de melding ook als de server zelf niets meer kan.
#
# Omgeving: HZ_HEARTBEAT_PING_URL (verplicht), HZ_HEARTBEAT_CHECK_URL (standaard https://$HZ_DOMAIN/api/health),
#           HZ_HEARTBEAT_DISK_MAX (standaard 85), HZ_HEARTBEAT_DISK_PATH (standaard /).
set -euo pipefail
HZ_SCRIPT=heartbeat
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$here/lib.sh"

ping="${HZ_HEARTBEAT_PING_URL:?HZ_HEARTBEAT_PING_URL ontbreekt}"
check="${HZ_HEARTBEAT_CHECK_URL:-https://${HZ_DOMAIN:?HZ_DOMAIN ontbreekt}/api/health}"
disk_max="${HZ_HEARTBEAT_DISK_MAX:-85}"
problems=()

if body="$("$HZ_CURL" -fsS -m 15 "$check" 2>&1)"; then
  [[ "$body" == *'"ok":true'* ]] || problems+=("health zonder ok")
  [[ "$body" != *'"db":"error"'* ]] || problems+=("database onbereikbaar")
else
  problems+=("health niet bereikbaar: $(head -c 120 <<<"$body" | tr '\n' ' ')")
fi

if unhealthy="$("$HZ_DOCKER" ps --filter health=unhealthy --filter "label=$HZ_LABEL=1" --format '{{.Names}}' 2>/dev/null)"; then
  [[ -z "$unhealthy" ]] || problems+=("unhealthy: $(tr '\n' ' ' <<<"$unhealthy")")
else
  problems+=("docker reageert niet")
fi

used="$(df -P "${HZ_HEARTBEAT_DISK_PATH:-/}" | awk 'NR==2 {gsub("%","",$5); print $5}')"
((used <= disk_max)) || problems+=("schijf ${used}% vol")

if ((${#problems[@]})); then
  msg="$(printf '%s; ' "${problems[@]}")"
  log "ROOD: $msg"
  ping_url "${ping%/}/fail" "$msg"
  exit 1
fi
log "groen"
ping_url "$ping" "groen"
