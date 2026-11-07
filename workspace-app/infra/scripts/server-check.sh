#!/usr/bin/env bash
# Servercontrole (HZW-002): open poorten, SSH-instellingen, firewall, automatische updates en Docker.
# Op de server: `hz-ssh-dispatch check` (vanuit de workflow workspace-server-check) of als beheerder met sudo.
# Met --markdown komt er een tabel uit om in het issue of de job-samenvatting te zetten.
# Met --extern <host> wordt van buitenaf gekeken welke poorten open staan (vanaf een CI-runner of laptop).
#
#   server-check.sh [--markdown]
#   server-check.sh --extern <host> [--markdown]
#
# Toegestaan van buiten: tcp 22, 80, 443 en udp 443 (HTTP/3). De rest hoort alleen op 127.0.0.1 of in Docker.
# Voor tests zijn de bronnen te vervangen: HZ_CHECK_ROOT (in plaats van /), HZ_SSHD_T, HZ_SS, HZ_UFW, HZ_DOCKER_INFO.
set -euo pipefail
HZ_SCRIPT=server-check
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$here/lib.sh"

markdown=0
extern=""
while (($#)); do
  case "$1" in
    --markdown)
      markdown=1
      shift
      ;;
    --extern)
      extern="${2:?host}"
      shift 2
      ;;
    *) die "onbekende optie: $1" ;;
  esac
done

root="${HZ_CHECK_ROOT:-}"
results=()
fails=0
res() { # status, controle, toelichting
  results+=("$1|$2|$3")
  [[ "$1" == FOUT ]] && fails=$((fails + 1))
  return 0
}

allowed_tcp=" 22 80 443 "
allowed_udp=" 443 "

if [[ -n "$extern" ]]; then
  [[ "$extern" =~ ^[A-Za-z0-9.:-]+$ ]] || die "ongeldige host"
  for p in 22 80 443; do
    if timeout 5 bash -c "exec 3<>/dev/tcp/$extern/$p" 2>/dev/null; then res OK "poort $p" "open (hoort zo)"; else res FOUT "poort $p" "dicht; hoort open"; fi
  done
  for p in 21 25 2019 3000 5432 5555 6379 8000 8080 8081 8700 9000; do
    if timeout 3 bash -c "exec 3<>/dev/tcp/$extern/$p" 2>/dev/null; then res FOUT "poort $p" "open van buitenaf; hoort dicht"; else res OK "poort $p" "dicht"; fi
  done
else
  # --- SSH: alleen sleutels, geen root, geen wachtwoorden ----------------------------------------------------
  sshd_t="$(${HZ_SSHD_T:-sshd -T} 2>/dev/null || true)"
  if [[ -z "$sshd_t" ]]; then
    res FOUT ssh "sshd -T gaf niets (draai als root)"
  else
    want=("passwordauthentication no" "kbdinteractiveauthentication no" "permitrootlogin no" "pubkeyauthentication yes" "permitemptypasswords no")
    for w in "${want[@]}"; do
      if grep -qix "$w" <<<"$sshd_t"; then res OK "ssh ${w%% *}" "${w##* }"; else res FOUT "ssh ${w%% *}" "moet '${w##* }' zijn, is '$(grep -i "^${w%% *} " <<<"$sshd_t" | awk '{print $2}')'"; fi
    done
  fi

  # --- Luisterende poorten (ss): alles buiten loopback moet op de lijst staan ---------------------------------
  ss_out="$(${HZ_SS:-ss -H -tuln} 2>/dev/null || true)"
  bad_ports=()
  while read -r proto _ _ _ local _; do
    [[ -n "${local:-}" ]] || continue
    addr="${local%:*}"
    port="${local##*:}"
    addr="${addr#[}"
    addr="${addr%]}"
    case "$addr" in 127.* | ::1 | localhost) continue ;; esac
    if [[ "$addr" == *%lo ]]; then continue; fi
    if [[ "$proto" == tcp* ]]; then
      [[ "$allowed_tcp" == *" $port "* ]] || bad_ports+=("tcp/$port")
    elif [[ "$proto" == udp* ]]; then
      # DHCP-client en systemd-resolved luisteren op udp; alleen 443 hoort publiek.
      [[ "$allowed_udp" == *" $port "* || "$port" == 68 || "$port" == 546 || "$addr" == 127.0.0.53* ]] || bad_ports+=("udp/$port")
    fi
  done <<<"$ss_out"
  if [[ -z "$ss_out" ]]; then
    res FOUT poorten "ss gaf niets"
  elif ((${#bad_ports[@]})); then
    res FOUT poorten "luistert publiek op: $(printf '%s ' "$(printf '%s\n' "${bad_ports[@]}" | sort -u)" | tr '\n' ' ')"
  else
    res OK poorten "alleen 22, 80, 443 publiek"
  fi

  # --- Firewall (ufw) ------------------------------------------------------------------------------------------
  ufw_out="$(${HZ_UFW:-ufw status verbose} 2>/dev/null || true)"
  if grep -q '^Status: active' <<<"$ufw_out" && grep -q 'deny (incoming)' <<<"$ufw_out"; then
    missing=()
    for p in 22/tcp 80/tcp 443/tcp; do grep -Eq "^$p +ALLOW IN" <<<"$ufw_out" || missing+=("$p"); done
    if ((${#missing[@]})); then res FOUT firewall "regels ontbreken: ${missing[*]}"; else res OK firewall "actief, standaard dicht, 22/80/443 open"; fi
  else
    res FOUT firewall "ufw niet actief of niet standaard dicht"
  fi

  # --- Automatische beveiligingsupdates ------------------------------------------------------------------------
  auto="$root/etc/apt/apt.conf.d/20auto-upgrades"
  if [[ -f "$auto" ]] && grep -Eq 'APT::Periodic::Unattended-Upgrade "1"' "$auto" && grep -Eq 'APT::Periodic::Update-Package-Lists "1"' "$auto"; then
    res OK updates "unattended-upgrades staat aan"
  else
    res FOUT updates "unattended-upgrades staat niet aan ($auto)"
  fi
  if [[ -f "$root/etc/apt/apt.conf.d/52unattended-upgrades-hz" ]] && grep -q 'Automatic-Reboot "true"' "$root/etc/apt/apt.conf.d/52unattended-upgrades-hz"; then
    res OK herstart "automatisch herstarten na kernel-updates (04:00)"
  else
    res WAARSCHUWING herstart "geen automatische herstart na updates"
  fi
  if [[ -f "$root/var/run/reboot-required" ]]; then res WAARSCHUWING herstart "herstart nodig (wacht op 04:00)"; fi

  # --- Docker ---------------------------------------------------------------------------------------------------
  if ${HZ_DOCKER_INFO:-docker info --format '{{.ServerVersion}}'} >/dev/null 2>&1; then
    res OK docker "draait"
  else
    res FOUT docker "draait niet"
  fi
fi

if ((markdown)); then
  printf '| Status | Controle | Toelichting |\n|---|---|---|\n'
  for r in "${results[@]}"; do IFS='|' read -r s c t <<<"$r" && printf '| %s | %s | %s |\n' "$s" "$c" "$t"; done
  printf '\n%s\n' "$( ((fails)) && echo "**$fails controle(s) rood**" || echo '**Alles groen**')"
else
  for r in "${results[@]}"; do IFS='|' read -r s c t <<<"$r" && printf '%-12s %-36s %s\n' "$s" "$c" "$t"; done
fi
((fails == 0))
