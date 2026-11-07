#!/usr/bin/env bash
# Maak de server in Hetzner Cloud (HZW-002), of een tweede server voor een verhuizing (HZW-082), met de hcloud-CLI.
# Eerst altijd --dry-run: dan zie je precies welke opdrachten er komen, zonder iets aan te maken of te betalen.
#
#   HCLOUD_TOKEN=... infra/scripts/hetzner-create.sh --name hz-workspace --location nbg1 \
#     --user-data user-data.yaml --ssh-key ~/.ssh/id_ed25519.pub [--dry-run]
#
# Maakt: SSH-sleutel (als die er nog niet is), firewall "hz-web" (in: 22/tcp, 80/tcp, 443/tcp, 443/udp, ICMP),
# server CX32 met Ubuntu 24.04 en de cloud-init. Geen Hetzner-back-ups: we maken onze eigen (HZW-008).
# Daarna: DNS naar het IPv4/IPv6-adres (RUNBOOK.md, 'Nieuwe server').
set -euo pipefail
HZ_SCRIPT=hetzner
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$here/lib.sh"

name=hz-workspace
location=nbg1
type="${HZ_SERVER_TYPE:-cx32}"
image=ubuntu-24.04
user_data=""
ssh_key=""
dry=0
while (($#)); do
  case "$1" in
    --name) name="${2:?}"; shift 2 ;;
    --location) location="${2:?}"; shift 2 ;;
    --user-data) user_data="${2:?}"; shift 2 ;;
    --ssh-key) ssh_key="${2:?}"; shift 2 ;;
    --dry-run) dry=1; shift ;;
    *) die "onbekende optie: $1" ;;
  esac
done
[[ "$name" =~ ^[a-z0-9-]{3,40}$ ]] || die "ongeldige servernaam"
[[ "$location" == nbg1 || "$location" == fsn1 ]] || die "locatie moet nbg1 (Neurenberg) of fsn1 (Falkenstein) zijn"
[[ -f "$user_data" ]] || die "--user-data ontbreekt (node infra/cloud-init/render.mjs ... --out user-data.yaml)"
head -n1 "$user_data" | grep -qx '#cloud-config' || die "$user_data is geen cloud-config"
[[ -f "$ssh_key" ]] || die "--ssh-key ontbreekt (publieke sleutel van een beheerder)"

run() {
  printf '+ %s\n' "$*"
  ((dry)) || "$@"
}
((dry)) || need hcloud
((dry)) || [[ -n "${HCLOUD_TOKEN:-}" ]] || die "HCLOUD_TOKEN ontbreekt (Hetzner Console, project, Security, API tokens: lezen en schrijven)"

key_name="$name-beheer"
if ((dry)) || ! hcloud ssh-key describe "$key_name" >/dev/null 2>&1; then
  run hcloud ssh-key create --name "$key_name" --public-key-from-file "$ssh_key"
fi

fw=hz-web
if ((dry)) || ! hcloud firewall describe "$fw" >/dev/null 2>&1; then
  run hcloud firewall create --name "$fw"
  for rule in "tcp 22" "tcp 80" "tcp 443" "udp 443"; do
    read -r proto port <<<"$rule"
    run hcloud firewall add-rule "$fw" --direction in --protocol "$proto" --port "$port" --source-ips 0.0.0.0/0 --source-ips ::/0 --description "hz $proto/$port"
  done
  run hcloud firewall add-rule "$fw" --direction in --protocol icmp --source-ips 0.0.0.0/0 --source-ips ::/0 --description "hz ping"
fi

run hcloud server create --name "$name" --type "$type" --image "$image" --location "$location" \
  --ssh-key "$key_name" --firewall "$fw" --user-data-from-file "$user_data" --label app=hz-workspace

if ((dry == 0)); then
  ip4="$(hcloud server ip "$name")"
  ip6="$(hcloud server ip -6 "$name")"
  printf '\nServer %s staat aan: IPv4 %s, IPv6 %s\n' "$name" "$ip4" "$ip6"
  printf 'Volgende stap: DNS (A en AAAA) voor HZ_DOMAIN, HZ_TEST_DOMAIN, *.HZ_TEST_DOMAIN en HZ_ERRORS_DOMAIN naar dit adres.\n'
  printf 'Na ~5 minuten: ssh hz@%s sudo cat /var/log/hz/sleutels.txt\n' "$ip4"
fi
