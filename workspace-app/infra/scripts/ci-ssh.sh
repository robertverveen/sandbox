#!/usr/bin/env bash
# SSH vanuit GitHub Actions naar de server, alleen over het tailnet (HZW-004: nooit via publieke SSH).
# De job is eerst een tijdelijke, getagde Tailscale-node geworden (tailscale/github-action, tag:ci, ephemeral; de
# ACL laat tag:ci alleen bij poort 22 van de server, infra/tailscale/acl.hujson). Dit script weigert elk doel dat
# niet naar een tailnet-adres wijst (100.64.0.0/10 of fd7a:115c:a1e0::/48), en verbindt met dat adres zelf, met
# een vaste host-sleutel (known_hosts) en een CI-sleutel die op de server alleen hz-ssh-dispatch met één vaste rol
# mag draaien (test, prod of preview; zie hz-ssh-dispatch.sh).
#
#   ci-ssh.sh <host> <opdracht...>        bijv. ci-ssh.sh "$HZ_DEPLOY_HOST" deploy test sha-abc1234 <digests>
#
# stdin gaat door (het registry-token voor hz-ssh-dispatch). Omgeving: HZ_SSH_KEY (standaard ~/.ssh/hz_deploy),
# HZ_SSH_KNOWN_HOSTS (standaard ~/.ssh/known_hosts), HZ_SSH_USER (standaard hz-workspace; previews: hz-preview).
# Voor tests: HZ_SSH (in plaats van ssh) en HZ_RESOLVE (in plaats van getent ahosts).
set -euo pipefail
HZ_SCRIPT=ci-ssh
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$here/lib.sh"

host="${1:-}"
shift || true
(($#)) || die "gebruik: ci-ssh.sh <host> <opdracht...>"
[[ "$host" =~ ^[A-Za-z0-9.:-]+$ ]] || die "ongeldige host: ${host:-<leeg>}"
[[ "${HZ_SSH_USER:-hz-workspace}" == hz-workspace || "${HZ_SSH_USER:-}" == hz-preview ]] || die "ongeldige gebruiker: $HZ_SSH_USER"

tailnet() {
  local a="$1" o2
  if [[ "$a" =~ ^100\.([0-9]+)\.[0-9]+\.[0-9]+$ ]]; then
    o2="${BASH_REMATCH[1]}"
    ((o2 >= 64 && o2 <= 127))
    return
  fi
  [[ "${a,,}" == fd7a:115c:a1e0:* ]]
}

mapfile -t addrs < <(${HZ_RESOLVE:-getent ahosts} "$host" 2>/dev/null | awk '{print $1}' | sort -u)
((${#addrs[@]})) || die "$host is niet te vinden (is de Tailscale-stap gedraaid? MagicDNS-naam of 100.x-adres)"
for a in "${addrs[@]}"; do
  tailnet "$a" || die "$host wijst naar $a: geen tailnet-adres. Publieke SSH is uitgesloten (HZW-004); gebruik de tailnet-naam van de server"
done
target="${addrs[0]}"

"${HZ_SSH:-ssh}" -i "${HZ_SSH_KEY:-$HOME/.ssh/hz_deploy}" \
  -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=${HZ_SSH_KNOWN_HOSTS:-$HOME/.ssh/known_hosts}" \
  -o "HostKeyAlias=$host" -o ConnectTimeout=20 \
  "${HZ_SSH_USER:-hz-workspace}@$target" "$*"
