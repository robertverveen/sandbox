#!/usr/bin/env bash
# Workspace klaarzetten op een server (HZW-002): de bestaande server van Robert (in zijn tailnet, met andere
# projecten erop), of een eigen server bij een verhuizing (HZW-082, vanuit cloud-init). Als root, via Tailscale.
# Raakt alleen wat van de workspace is; de andere projecten, sshd, ufw en de bestaande proxy blijven ongemoeid.
#
#   sudo infra/scripts/server-setup.sh --domain homezero.verveen.me --acme-email robert@homezero.nl \
#     --registry ghcr.io/homezerotech --proxy caddy --proxy-network <netwerk van de proxy> \
#     [--proxy-config /etc/caddy] [--router-port 18780] [--test-domain ...] [--errors-domain ...] \
#     --deploy-key-test hz_ci_test.pub --deploy-key-prod hz_ci_prod.pub --preview-key hz_ci_preview.pub [--dry-run]
#
# Drie CI-sleutels, elk met één doel (HZW-004/005): test (environment 'test'), prod (environment 'production', na
# goedkeuring) en preview (environment 'preview', voor pull requests). Minstens één is nodig; ze moeten verschillen.
#
# Stappen (met --dry-run alleen tonen, niets wijzigen):
#   0. voorcheck (server-check.sh --voorcheck): rood = stoppen, er verandert niets
#   1. gebruikers hz-workspace (uitrol; lid van docker, leest de age-sleutel) en hz-preview (previews; lid van docker,
#      niet van hz-workspace, dus geen toegang tot etc/age.key). Systeemgebruikers zonder wachtwoord.
#   2. map /srv/hz-workspace (root, met merkbestand .hz-workspace) met etc/, bin/ (root), releases/, env/, images/,
#      log/, proxy/, router/, edge/ (van hz-workspace) en previews/ (van hz-preview, ook zijn thuismap)
#   3. vaste scripts in bin/ (hz-ssh-dispatch, hz-run, hz-server-check), hz.env, sudo-regel voor de servercontrole
#   4. CI-sleutels: test en prod bij hz-workspace, preview bij hz-preview; elk alleen hz-ssh-dispatch met een vaste
#      rol (restrict + forced command "hz-ssh-dispatch test|prod|preview");
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
key_test=""
key_prod=""
key_preview=""
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
    --deploy-key-test) key_test="${2:?}"; shift 2 ;;
    --deploy-key-prod) key_prod="${2:?}"; shift 2 ;;
    --preview-key) key_preview="${2:?}"; shift 2 ;;
    --deploy-key) die "--deploy-key is vervangen door --deploy-key-test, --deploy-key-prod en --preview-key (een sleutel per doel)" ;;
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
[[ -n "$key_test$key_prod$key_preview" ]] || die "geen CI-sleutel: --deploy-key-test, --deploy-key-prod en/of --preview-key (publieke sleutels)"
# Lees een publieke sleutel; print "type base64" (zonder commentaar) of stop.
pubkey() {
  local f="$1" k
  [[ -f "$f" ]] || die "sleutelbestand niet gevonden: $f"
  k="$(head -n1 "$f")"
  [[ "$k" =~ ^(ssh-ed25519|ecdsa-sha2-nistp256)\ [A-Za-z0-9+/=]+(\ [^[:cntrl:]]*)?$ ]] || die "geen geldige publieke SSH-sleutel in $f"
  printf '%s\n' "$k"
}
declare -A ci_key=()
for r in test prod preview; do
  v="key_$r"
  [[ -n "${!v}" ]] && ci_key[$r]="$(pubkey "${!v}")"
done
# Eén sleutel per doel: dezelfde sleutel voor twee rollen zou de scheiding (preview mag niet naar productie) opheffen.
if [[ "$(for r in "${!ci_key[@]}"; do cut -d' ' -f1,2 <<<"${ci_key[$r]}"; done | sort | uniq -d)" != "" ]]; then
  die "dezelfde sleutel voor twee rollen; maak per doel een eigen sleutel (RUNBOOK.md §2 stap 2)"
fi
export HZ_DOMAIN="$domain" HZ_TEST_DOMAIN="$test_domain" HZ_ERRORS_DOMAIN="$errors_domain" HZ_PROXY_KIND="$proxy" \
  HZ_PROXY_NETWORK="$proxy_network" HZ_ROUTER_PORT="$router_port"
[[ -n "$proxy_config" ]] && export HZ_PROXY_CONFIG="$proxy_config"
valid_proxy || die "--proxy caddy|traefik|eigen; bij caddy --proxy-network of --router-port, bij traefik --proxy-network"

home=/srv/hz-workspace
user=hz-workspace
puser=hz-preview

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

# 1. Gebruikers. hz-preview is bewust geen lid van de groep hz-workspace: previews draaien code van pull requests
# (als containers) en mogen niet bij etc/age.key, waarmee de secrets van productie open gaan.
if grep -Eq "^$user:" "$P/etc/passwd" 2>/dev/null; then
  log "gebruiker $user bestaat al"
else
  run "${HZ_USERADD:-useradd}" --system --home-dir "$home" --no-create-home --shell /bin/bash --groups docker \
    --comment "HomeZero Workspace (hz-workspace)" "$user"
fi
if grep -Eq "^$puser:" "$P/etc/passwd" 2>/dev/null; then
  log "gebruiker $puser bestaat al"
else
  run "${HZ_USERADD:-useradd}" --system --home-dir "$home/previews" --no-create-home --shell /bin/bash --groups docker \
    --comment "HomeZero Workspace previews (hz-preview)" "$puser"
fi

# 2. Mappen: de map zelf en bin/ zijn van root (de CI-sleutel en de sudo-regel wijzen erheen), de rest van hz-workspace.
mkd 0755 root:root "$home" "$home/bin"
# etc: hz-preview mag erdoor (hz.env is niet geheim), maar de map niet lezen; age.key is alleen voor hz-workspace.
mkd 0751 "root:$user" "$home/etc"
mkd 0750 "$user:$user" "$home/log"
# releases/env/images: leesbaar voor hz-preview, dat preview.sh uit de bundel van test start (geen geheimen: de
# secrets in een bundel zijn met age versleuteld).
mkd 0755 "$user:$user" "$home/releases" "$home/env" "$home/images"
# Leesbaar voor de containers van de router, de eigen edge en een bestaande proxy (alleen configuratie, geen geheimen).
mkd 0755 "$user:$user" "$home/router" "$home/proxy" "$home/edge"
mkd 0755 "$puser:$puser" "$home/previews" "$home/previews/allow"
mkd 0700 "$user:$user" "$home/.ssh"
mkd 0700 "$puser:$puser" "$home/previews/.ssh"
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
} | put "$home/etc/hz.env" 0644 root:root
not_foreign /etc/sudoers.d/hz-workspace
printf '# hz-workspace: servercontrole vanuit GitHub Actions (sshd -T en ufw vragen root); verder niets.\n%s ALL=(root) NOPASSWD: %s/bin/hz-server-check --markdown\n' "$user" "$home" |
  put /etc/sudoers.d/hz-workspace 0440 root:root
((dry)) || "${HZ_VISUDO:-visudo}" -cf "$P/etc/sudoers.d/hz-workspace" >/dev/null || die "sudo-regel ongeldig"

# 4. CI-sleutels: elk alleen hz-ssh-dispatch met een vaste rol, geen shell, geen doorsturen. Een sleutel die bij deze
# run niet is meegegeven blijft zoals hij was (opnieuw draaien met één nieuwe sleutel kan).
ak_line() { printf 'restrict,command="%s/bin/hz-ssh-dispatch %s" %s\n' "$home" "$1" "$2"; }
keep_line() { grep -E "^restrict,command=\"$home/bin/hz-ssh-dispatch $2\" " "$P$1" 2>/dev/null || true; }
{
  printf '# hz-workspace: GitHub Actions via een tijdelijke Tailscale-node (tag:ci); per sleutel een vaste rol.\n'
  for r in test prod; do
    if [[ -n "${ci_key[$r]:-}" ]]; then ak_line "$r" "${ci_key[$r]}"; else keep_line "$home/.ssh/authorized_keys" "$r"; fi
  done
} | put "$home/.ssh/authorized_keys" 0600 "$user:$user"
{
  printf '# hz-workspace: previews van pull requests (environment preview); alleen preview up/down.\n'
  if [[ -n "${ci_key[preview]:-}" ]]; then ak_line preview "${ci_key[preview]}"; else keep_line "$home/previews/.ssh/authorized_keys" preview; fi
} | put "$home/previews/.ssh/authorized_keys" 0600 "$puser:$puser"
allow="$(${HZ_SSHD_T:-sshd -T} 2>/dev/null | awk 'tolower($1)=="allowusers" {for (i=2;i<=NF;i++) print $i}' || true)"
for u in "$user" "$puser"; do
  if [[ -n "$allow" ]] && ! grep -qx "$u" <<<"$allow"; then
    log "LET OP: sshd heeft AllowUsers zonder $u; voeg $u toe in de sshd-config (dit script wijzigt sshd niet)"
  fi
done

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
