#!/usr/bin/env bash
# Workspace klaarzetten op een server (HZW-002): de bestaande server van Robert (in zijn tailnet, met andere
# projecten erop), of een eigen server bij een verhuizing (HZW-082, vanuit cloud-init). Als root, via Tailscale.
# Raakt alleen wat van de workspace is; de andere projecten, sshd, ufw en de bestaande proxy blijven ongemoeid.
#
#   sudo infra/scripts/server-setup.sh --domain homezero.verveen.me --acme-email robert@homezero.nl \
#     --registry ghcr.io/homezerotech --proxy caddy --proxy-network <netwerk van de proxy> \
#     [--proxy-config /etc/caddy] [--router-port 18780] [--test-domain ...] [--errors-domain ...] \
#     --deploy-key hz_deploy.pub [--dry-run]
#
# Stappen (met --dry-run alleen tonen, niets wijzigen):
#   0. voorcheck (server-check.sh --voorcheck): rood = stoppen, er verandert niets
#   1. gebruiker hz-workspace (systeemgebruiker, lid van docker, geen wachtwoord)
#   2. map /srv/hz-workspace (root, met merkbestand .hz-workspace) met etc/, bin/ (root), releases/, env/, previews/,
#      log/, proxy/, router/, edge/ (van hz-workspace)
#   3. vaste scripts in bin/ (hz-ssh-dispatch, hz-run, hz-server-check), hz.env, sudo-regel voor de servercontrole
#   4. SSH-sleutel van GitHub Actions bij hz-workspace, alleen voor hz-ssh-dispatch (restrict + forced command);
#      sshd luistert alleen op het tailnet (of ufw laat 22 alleen toe op tailscale0): CI komt via een tijdelijke
#      Tailscale-node binnen, nooit via publieke SSH
#   5. systemd-units hz-workspace-backup/-heartbeat/-hersteltest en tmpfiles voor /run/hz-workspace
#   6. age-sleutel van de server (secrets) en SSH-sleutel voor de back-ups; alleen de publieke helften naar buiten
#   7. Docker-netwerk hz-workspace-net (met ons label)
#
# Voor tests: HZ_SETUP_PREFIX (alles onder deze map in plaats van /), HZ_USERADD, HZ_SYSTEMCTL, HZ_CHOWN, HZ_VISUDO,
# HZ_SSH_KEYGEN, HZ_AGE_KEYGEN, HZ_DOCKER, en de bronnen van server-check.sh.
set -euo pipefail
HZ_SCRIPT=server-setup
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$here/lib.sh"
infra="$(dirname "$here")"

P="${HZ_SETUP_PREFIX:-}"
dry=0
domain=""
test_domain=""
errors_domain=""
acme=""
registry=""
deploy_key=""
proxy=""
proxy_network=""
proxy_config=""
router_port=""
while (($#)); do
  case "$1" in
    --domain) domain="${2:?}"; shift 2 ;;
    --test-domain) test_domain="${2:?}"; shift 2 ;;
    --errors-domain) errors_domain="${2:?}"; shift 2 ;;
    --acme-email) acme="${2:?}"; shift 2 ;;
    --registry) registry="${2:?}"; shift 2 ;;
    --deploy-key) deploy_key="${2:?}"; shift 2 ;;
    --proxy) proxy="${2:?}"; shift 2 ;;
    --proxy-network) proxy_network="${2:?}"; shift 2 ;;
    --proxy-config) proxy_config="${2:?}"; shift 2 ;;
    --router-port) router_port="${2:?}"; shift 2 ;;
    --dry-run) dry=1; shift ;;
    *) die "onbekende optie: $1" ;;
  esac
done

domain_re='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
test_domain="${test_domain:-test.$domain}"
errors_domain="${errors_domain:-fouten.$domain}"
for d in "$domain" "$test_domain" "$errors_domain"; do [[ "$d" =~ $domain_re ]] || die "ongeldig domein: ${d:-<leeg>}"; done
[[ "$acme" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$ ]] || die "ongeldig e-mailadres voor ACME"
[[ "$registry" =~ ^[a-z0-9.-]+(/[a-z0-9._-]+)+$ ]] || die "ongeldige registry (bv. ghcr.io/homezerotech)"
[[ -f "$deploy_key" ]] || die "--deploy-key ontbreekt (publieke sleutel van GitHub Actions)"
key="$(head -n1 "$deploy_key")"
[[ "$key" =~ ^(ssh-ed25519|ecdsa-sha2-nistp256)\ [A-Za-z0-9+/=]+(\ [^[:cntrl:]]*)?$ ]] || die "geen geldige publieke SSH-sleutel in $deploy_key"
export HZ_DOMAIN="$domain" HZ_TEST_DOMAIN="$test_domain" HZ_ERRORS_DOMAIN="$errors_domain" HZ_PROXY_KIND="$proxy" \
  HZ_PROXY_NETWORK="$proxy_network" HZ_ROUTER_PORT="$router_port"
[[ -n "$proxy_config" ]] && export HZ_PROXY_CONFIG="$proxy_config"
valid_proxy || die "--proxy caddy|traefik|eigen; bij caddy --proxy-network of --router-port, bij traefik --proxy-network"

home=/srv/hz-workspace
user=hz-workspace

# 0. Voorcheck: zonder groen geen enkele wijziging.
log "voorcheck"
HZ_CHECK_NO_ENV=1 HZ_CHECK_ROOT="${HZ_CHECK_ROOT:-$P}" "$here/server-check.sh" --voorcheck ||
  die "voorcheck rood: er is niets gewijzigd (zie hierboven; RUNBOOK.md §2)"

run() {
  printf '+ %s\n' "$*"
  ((dry)) || "$@"
}
# Schrijf een bestand (inhoud op stdin) met eigenaar en rechten; bij --dry-run alleen tonen.
put() { # pad modus eigenaar
  local path="$P$1" content
  content="$(cat)"
  printf '+ schrijf %s (%s %s)\n' "$1" "$2" "$3"
  ((dry)) && return 0
  mkdir -p "$(dirname "$path")"
  printf '%s\n' "$content" >"$path.tmp"
  chmod "$2" "$path.tmp"
  "${HZ_CHOWN:-chown}" "$3" "$path.tmp"
  mv "$path.tmp" "$path"
}
# Mappen met modus en eigenaar; bij --dry-run alleen tonen.
mkd() { # modus eigenaar map...
  local mode="$1" owner="$2" d
  shift 2
  for d in "$@"; do
    printf '+ map %s (%s %s)\n' "$d" "$mode" "$owner"
    ((dry)) && continue
    mkdir -p "$P$d"
    chmod "$mode" "$P$d"
    "${HZ_CHOWN:-chown}" "$owner" "$P$d"
  done
}
# Een bestaand bestand van iets anders nooit overschrijven.
not_foreign() {
  local path="$P$1"
  [[ ! -e "$path" ]] || head -n1 "$path" | grep -q 'hz-workspace' || die "$1 bestaat al en is niet van de workspace; niets overschreven"
}

# 1. Gebruiker
if grep -Eq "^$user:" "$P/etc/passwd" 2>/dev/null; then
  log "gebruiker $user bestaat al"
else
  run "${HZ_USERADD:-useradd}" --system --home-dir "$home" --no-create-home --shell /bin/bash --groups docker \
    --comment "HomeZero Workspace (hz-workspace)" "$user"
fi

# 2. Mappen: de map zelf en bin/ zijn van root (de CI-sleutel en de sudo-regel wijzen erheen), de rest van hz-workspace.
mkd 0755 root:root "$home" "$home/bin"
mkd 0750 "root:$user" "$home/etc"
mkd 0750 "$user:$user" "$home/releases" "$home/env" "$home/previews" "$home/log"
# Leesbaar voor de containers van de router, de eigen edge en een bestaande proxy (alleen configuratie, geen geheimen).
mkd 0755 "$user:$user" "$home/router" "$home/proxy" "$home/edge" "$home/previews/allow"
mkd 0700 "$user:$user" "$home/.ssh"
printf '# hz-workspace: van de HomeZero Workspace (server-setup.sh). Niet weghalen: de voorcheck herkent de map hieraan.\n' |
  put "$home/.hz-workspace" 0644 root:root

# 3. Vaste scripts, instellingen, sudo-regel
put "$home/bin/lib.sh" 0644 root:root <"$here/lib.sh"
for s in hz-ssh-dispatch.sh:hz-ssh-dispatch hz-run.sh:hz-run server-check.sh:hz-server-check; do
  put "$home/bin/${s#*:}" 0755 root:root <"$here/${s%%:*}"
done
{
  printf '# hz-workspace: niet-geheime instellingen van deze server (server-setup.sh). Geheimen: infra/secrets (age).\n'
  printf 'HZ_DOMAIN=%s\nHZ_TEST_DOMAIN=%s\nHZ_ERRORS_DOMAIN=%s\nHZ_ACME_EMAIL=%s\nHZ_REGISTRY=%s\n' \
    "$domain" "$test_domain" "$errors_domain" "$acme" "$registry"
  printf '# Hoe de bestaande reverse proxy de router van de workspace bereikt (voorcheck, proxy-snippet.sh).\n'
  printf 'HZ_PROXY_KIND=%s\n' "$proxy"
  [[ -n "$proxy_network" ]] && printf 'HZ_PROXY_NETWORK=%s\n' "$proxy_network"
  [[ -n "$router_port" ]] && printf 'HZ_ROUTER_PORT=%s\n' "$router_port"
  [[ -n "$proxy_config" ]] && printf 'HZ_PROXY_CONFIG=%s\n' "$proxy_config"
  printf '# Back-up en herstel via de db-container (de database heeft geen open poort).\n'
  printf 'HZ_BACKUP_PREFIX=hz-workspace-prod\nHZ_PG_EXEC=docker exec -i hz-workspace-prod-db-1\n'
  printf 'HZ_RESTORE_ADMIN_DSN=postgresql:///postgres?user=postgres\n'
} | put "$home/etc/hz.env" 0640 "root:$user"
not_foreign /etc/sudoers.d/hz-workspace
printf '# hz-workspace: servercontrole vanuit GitHub Actions (sshd -T en ufw vragen root); verder niets.\n%s ALL=(root) NOPASSWD: %s/bin/hz-server-check --markdown\n' "$user" "$home" |
  put /etc/sudoers.d/hz-workspace 0440 root:root
((dry)) || "${HZ_VISUDO:-visudo}" -cf "$P/etc/sudoers.d/hz-workspace" >/dev/null || die "sudo-regel ongeldig"

# 4. SSH-sleutel van GitHub Actions: alleen hz-ssh-dispatch, geen shell, geen doorsturen.
printf '# hz-workspace: GitHub Actions via een tijdelijke Tailscale-node (tag:ci); alleen hz-ssh-dispatch.\nrestrict,command="%s/bin/hz-ssh-dispatch" %s\n' "$home" "$key" |
  put "$home/.ssh/authorized_keys" 0600 "$user:$user"
allow="$(${HZ_SSHD_T:-sshd -T} 2>/dev/null | awk 'tolower($1)=="allowusers" {for (i=2;i<=NF;i++) print $i}' || true)"
if [[ -n "$allow" ]] && ! grep -qx "$user" <<<"$allow"; then
  log "LET OP: sshd heeft AllowUsers zonder $user; voeg $user toe in de sshd-config (dit script wijzigt sshd niet)"
fi

# 5. systemd-units (eigen namen) en /run/hz-workspace
for u in "$infra"/systemd/hz-workspace-*; do
  unit="/etc/systemd/system/$(basename "$u")"
  not_foreign "$unit"
  put "$unit" 0644 root:root <"$u"
done
printf '# hz-workspace\nd /run/hz-workspace 0700 %s %s -\n' "$user" "$user" | put /etc/tmpfiles.d/hz-workspace.conf 0644 root:root
run "${HZ_SYSTEMD_TMPFILES:-systemd-tmpfiles}" --create "$P/etc/tmpfiles.d/hz-workspace.conf"
run "${HZ_SYSTEMCTL:-systemctl}" daemon-reload
run "${HZ_SYSTEMCTL:-systemctl}" enable --now hz-workspace-backup.timer hz-workspace-heartbeat.timer hz-workspace-hersteltest.timer

# 6. Sleutels: de geheime helften verlaten de server nooit.
if [[ ! -f "$P$home/etc/age.key" ]]; then
  run "${HZ_AGE_KEYGEN:-age-keygen}" -o "$P$home/etc/age.key"
fi
if ((dry == 0)); then
  "${HZ_CHOWN:-chown}" "root:$user" "$P$home/etc/age.key"
  chmod 0640 "$P$home/etc/age.key"
  "${HZ_AGE_KEYGEN:-age-keygen}" -y "$P$home/etc/age.key" >"$P$home/etc/age.pub"
fi
if [[ ! -f "$P$home/.ssh/hz_backup_ed25519" ]]; then
  run "${HZ_SSH_KEYGEN:-ssh-keygen}" -q -t ed25519 -N '' -C hz-workspace-backup -f "$P$home/.ssh/hz_backup_ed25519"
  ((dry)) || "${HZ_CHOWN:-chown}" "$user:$user" "$P$home/.ssh/hz_backup_ed25519" "$P$home/.ssh/hz_backup_ed25519.pub"
fi

# 7. Gedeeld netwerk van de workspace
if ((dry)); then
  printf '+ %s network create --label %s=1 %s (als hij nog niet bestaat)\n' "$HZ_DOCKER" "$HZ_LABEL" "$HZ_NET"
else
  ensure_net
fi

if ((dry)); then
  log "droog gedraaid: er is niets gewijzigd"
  exit 0
fi
{
  echo "age (secrets, zet in infra/secrets/recipients.txt):"
  cat "$P$home/etc/age.pub"
  echo "Storage Box (back-ups):"
  cat "$P$home/.ssh/hz_backup_ed25519.pub"
} | tee "$P$home/log/sleutels.txt"
log "klaar. Volgende stap: site-blok in de proxy (proxy-snippet.sh $proxy) en de eerste uitrol (RUNBOOK.md §2)"
