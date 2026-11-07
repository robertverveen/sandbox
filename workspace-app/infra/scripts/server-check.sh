#!/usr/bin/env bash
# Servercontrole en voorcheck (HZW-002) voor de bestaande server van Robert, waar al andere projecten draaien.
# Kijkt alleen: wijzigt niets, start of stopt niets, schrijft geen bestand (de tests bewijzen dat).
#
#   server-check.sh [--markdown]              alles: tailnet en SSH, firewall, publieke poorten, updates, Docker,
#                                             en de voorcheck hieronder
#   server-check.sh --voorcheck [--markdown]  alleen de voorcheck: botst de workspace met wat er al draait?
#   server-check.sh --extern <host> [--markdown]   van buitenaf: alleen 443 open, SSH dicht
#
# Verwacht (plaat keuze 01, besloten 7 nov): publiek alleen 443 (de bestaande proxy); SSH alleen via het tailnet
# (luistert op het tailnet-adres, of ufw laat de SSH-poort alleen toe op tailscale0) en alleen met een sleutel;
# automatische beveiligingsupdates; de workspace publiceert zelf geen poort buiten 127.0.0.1.
#
# Voorcheck (ook vóór elke uitrol, deploy.sh, en vóór server-setup.sh): niets van de workspace mag botsen met de
# bestaande projecten. Rood bij:
#   - poorten: HZ_ROUTER_PORT/+1 (proxy op de host) of 443 (alleen bij een eigen edge) bezet door iets anders;
#   - de reverse proxy: geen proxy op 443, een ander soort dan HZ_PROXY_KIND, of niet in HZ_PROXY_NETWORK;
#   - Docker-netwerken, compose-projecten/containers en volumes met een hz-workspace-naam die niet van ons zijn
#     (zonder het label nl.homezero.workspace=1);
#   - mappen /srv/hz-workspace of /opt/hz-workspace die al bestaan zonder ons merkbestand;
#   - de gebruiker hz-workspace of systemd-units hz-workspace-* die van iets anders zijn;
#   - onze domeinen in de configuratie van de bestaande proxy (buiten ons eigen blok) of in labels van andere
#     containers.
#
# Instellingen: uit $HZ_ETC/hz.env als die er is, anders uit de omgeving (vóór de eerste installatie):
#   HZ_DOMAIN, HZ_TEST_DOMAIN, HZ_ERRORS_DOMAIN, HZ_PROXY_KIND (caddy|traefik|eigen), HZ_PROXY_NETWORK,
#   HZ_ROUTER_PORT, HZ_PROXY_CONFIG (bestanden of mappen met de config van de proxy, spaties ertussen).
# Voor tests zijn de bronnen te vervangen: HZ_CHECK_ROOT (in plaats van /), HZ_SSHD_T, HZ_SS, HZ_UFW,
# HZ_TAILSCALE_IP, HZ_DOCKER.
set -euo pipefail
HZ_SCRIPT=server-check
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$here/lib.sh"

markdown=0
extern=""
only_pre=0
while (($#)); do
  case "$1" in
    --markdown)
      markdown=1
      shift
      ;;
    --voorcheck)
      only_pre=1
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

# Tailnet-adressen (Tailscale CGNAT 100.64.0.0/10 en fd7a:115c:a1e0::/48) en loopback.
is_tailnet() {
  local a="$1" o2
  if [[ "$a" =~ ^100\.([0-9]+)\. ]]; then
    o2="${BASH_REMATCH[1]}"
    ((o2 >= 64 && o2 <= 127))
    return
  fi
  [[ "${a,,}" == fd7a:115c:a1e0:* ]]
}
is_loopback() { [[ "$1" == 127.* || "$1" == ::1 || "$1" == localhost || "$1" == *%lo ]]; }

# Luisterende sockets als "proto adres poort" (ss -H -tuln).
listeners() {
  local proto local_addr addr port
  while read -r proto _ _ _ local_addr _; do
    [[ -n "${local_addr:-}" ]] || continue
    addr="${local_addr%:*}"
    port="${local_addr##*:}"
    addr="${addr#[}"
    addr="${addr%]}"
    printf '%s %s %s\n' "${proto:0:3}" "$addr" "$port"
  done <<<"$ss_out"
}

# ---------------------------------------------------------------------------------------------------------------
# Van buitenaf (CI-runner of laptop, niet via het tailnet): alleen 443 open.
# ---------------------------------------------------------------------------------------------------------------
if [[ -n "$extern" ]]; then
  [[ "$extern" =~ ^[A-Za-z0-9.:-]+$ ]] || die "ongeldige host"
  port_open() { timeout "${2:-5}" bash -c "exec 3<>/dev/tcp/$extern/$1" 2>/dev/null; }
  if port_open "${HZ_EXTERN_HTTPS_PORT:-443}"; then res OK "poort 443" "open (de proxy, hoort zo)"; else res FOUT "poort 443" "dicht; hoort open"; fi
  if port_open "${HZ_EXTERN_SSH_PORT:-22}" 3; then res FOUT "poort 22" "SSH open van buitenaf; hoort alleen via het tailnet"; else res OK "poort 22" "dicht van buitenaf (SSH alleen via het tailnet)"; fi
  if port_open "${HZ_EXTERN_HTTP_PORT:-80}" 3; then res OK "poort 80" "open: van de bestaande proxy, alleen doorsturen naar https (tls-check.sh)"; else res OK "poort 80" "dicht"; fi
  for p in ${HZ_EXTERN_DICHT:-2019 3000 5432 5555 6379 8000 8080 8081 8082 8700 9000}; do
    if port_open "$p" 3; then res FOUT "poort $p" "open van buitenaf; hoort dicht"; else res OK "poort $p" "dicht"; fi
  done
fi

# ---------------------------------------------------------------------------------------------------------------
# Instellingen en bronnen (alleen lezen)
# ---------------------------------------------------------------------------------------------------------------
if [[ -z "$extern" ]]; then
  if [[ -f "$HZ_ETC/hz.env" && -z "${HZ_CHECK_NO_ENV:-}" ]]; then load_env "$HZ_ETC/hz.env"; fi
  ss_out="$(${HZ_SS:-ss -H -tuln} 2>/dev/null || true)"
  docker_ok=1
  t=$'\t'
  # Per container: naam, compose-project, ons label, image, poorten, netwerken, alle labels (tab ertussen).
  f_ps="{{.Names}}$t{{.Label \"com.docker.compose.project\"}}$t{{.Label \"$HZ_LABEL\"}}$t{{.Image}}$t{{.Ports}}$t{{.Networks}}$t{{.Labels}}"
  containers="$("$HZ_DOCKER" ps -a --format "$f_ps" 2>/dev/null)" || docker_ok=0
  networks="$("$HZ_DOCKER" network ls --format "{{.Name}}$t{{.Label \"$HZ_LABEL\"}}" 2>/dev/null)" || docker_ok=0
  volumes="$("$HZ_DOCKER" volume ls --format "{{.Name}}$t{{.Label \"$HZ_LABEL\"}}" 2>/dev/null)" || docker_ok=0
  # Lege velden (geen compose-project, geen label) moeten blijven staan: tab is voor 'read' witruimte en klapt dan
  # samen, daarom splitsen op het scheidingsteken \x1f.
  S=$'\x1f'
  containers="${containers//$t/$S}"
  networks="${networks//$t/$S}"
  volumes="${volumes//$t/$S}"
fi

# ---------------------------------------------------------------------------------------------------------------
# Server: tailnet, SSH, firewall, publieke poorten, updates, Docker
# ---------------------------------------------------------------------------------------------------------------
if [[ -z "$extern" && "$only_pre" == 0 ]]; then
  # --- Tailscale -------------------------------------------------------------------------------------------------
  ts_ip="$(${HZ_TAILSCALE_IP:-tailscale ip -4} 2>/dev/null | head -n1 || true)"
  if [[ -n "$ts_ip" ]] && is_tailnet "$ts_ip"; then
    res OK tailscale "in het tailnet: $ts_ip"
  else
    res FOUT tailscale "geen tailnet-adres (tailscaled draait niet of is niet aangemeld)"
  fi

  # --- SSH: alleen sleutels, geen wachtwoorden -------------------------------------------------------------------
  sshd_t="$(${HZ_SSHD_T:-sshd -T} 2>/dev/null || true)"
  ssh_port=22
  if [[ -z "$sshd_t" ]]; then
    res FOUT ssh "sshd -T gaf niets (draai als root)"
  else
    for w in "passwordauthentication no" "kbdinteractiveauthentication no" "pubkeyauthentication yes" "permitemptypasswords no"; do
      if grep -qix "$w" <<<"$sshd_t"; then res OK "ssh ${w%% *}" "${w##* }"; else res FOUT "ssh ${w%% *}" "moet '${w##* }' zijn, is '$(grep -i "^${w%% *} " <<<"$sshd_t" | awk '{print $2}')'"; fi
    done
    root_login="$(grep -i '^permitrootlogin ' <<<"$sshd_t" | awk '{print tolower($2)}')"
    case "$root_login" in
      no) res OK "ssh permitrootlogin" no ;;
      prohibit-password | without-password | forced-commands-only) res WAARSCHUWING "ssh permitrootlogin" "$root_login (alleen met sleutel; 'no' is strenger)" ;;
      *) res FOUT "ssh permitrootlogin" "moet 'no' zijn (of alleen met sleutel), is '${root_login:-?}'" ;;
    esac
    p="$(grep -i '^port ' <<<"$sshd_t" | awk 'NR==1 {print $2}')"
    [[ "$p" =~ ^[0-9]+$ ]] && ssh_port="$p"
  fi

  # --- SSH alleen via het tailnet ---------------------------------------------------------------------------------
  ufw_out="$(${HZ_UFW:-ufw status verbose} 2>/dev/null || true)"
  ufw_active=0
  if grep -q '^Status: active' <<<"$ufw_out" && grep -q 'deny (incoming)' <<<"$ufw_out"; then ufw_active=1; fi
  ufw_ssh_tailnet=0
  ufw_ssh_public=0
  if ((ufw_active)); then
    grep -Eq "^${ssh_port}(/tcp)?( \(v6\))? on tailscale0 +ALLOW IN" <<<"$ufw_out" && ufw_ssh_tailnet=1
    grep -Eq "^(${ssh_port}(/tcp)?|OpenSSH)( \(v6\))? +ALLOW IN" <<<"$ufw_out" && ufw_ssh_public=1
  fi
  ssh_public=()
  ssh_seen=0
  while read -r proto addr port; do
    [[ "$proto" == tcp && "$port" == "$ssh_port" ]] || continue
    ssh_seen=1
    is_loopback "$addr" && continue
    is_tailnet "$addr" && continue
    ssh_public+=("$addr")
  done < <(listeners)
  if ((ssh_seen == 0)); then
    res FOUT "ssh via tailnet" "sshd luistert niet op poort $ssh_port"
  elif ((${#ssh_public[@]} == 0)); then
    res OK "ssh via tailnet" "sshd luistert alleen op het tailnet-adres"
  elif ((ufw_ssh_tailnet && !ufw_ssh_public)); then
    res OK "ssh via tailnet" "sshd luistert op ${ssh_public[*]}, ufw laat $ssh_port alleen toe op tailscale0"
  else
    res FOUT "ssh via tailnet" "SSH is publiek bereikbaar (${ssh_public[*]}:$ssh_port); alleen op tailscale0 toestaan"
  fi

  # --- Publieke poorten op de host ------------------------------------------------------------------------------
  # 443 (tcp en udp) is de bestaande proxy; 80 alleen voor doorsturen naar https. De rest is van andere projecten:
  # niet onze zaak om te sluiten, wel om te melden. Docker-poorten gaan langs ufw heen.
  if [[ -z "$ss_out" ]]; then
    res FOUT poorten "ss gaf niets"
  else
    others=()
    https_seen=0
    while read -r proto addr port; do
      is_loopback "$addr" && continue
      is_tailnet "$addr" && continue
      [[ "$proto" == tcp && "$port" == "$ssh_port" ]] && continue
      [[ "$port" == 443 ]] && https_seen=1 && continue
      [[ "$proto" == tcp && "$port" == 80 ]] && continue
      # DHCP-client, systemd-resolved en het WireGuard-poortje van tailscaled zelf zijn geen diensten.
      [[ "$proto" == udp && ("$port" == 68 || "$port" == 546 || "$port" == 41641 || "$addr" == 127.0.0.53*) ]] && continue
      others+=("$proto/$port")
    done < <(listeners)
    if ((https_seen)); then res OK "poort 443" "de proxy luistert op 443"; else res FOUT "poort 443" "niets luistert publiek op 443"; fi
    if ((${#others[@]})); then
      res WAARSCHUWING "andere poorten" "luisteren op alle adressen (niet van de workspace): $(printf '%s\n' "${others[@]}" | sort -u | tr '\n' ' ')"
    else
      res OK "andere poorten" "alleen 443 (en 80 voor doorsturen) publiek"
    fi
  fi

  # --- De workspace zelf publiceert niets buiten 127.0.0.1 (alleen de eigen edge mag 443) ------------------------
  if ((docker_ok)); then
    bad_pub=()
    while IFS="$S" read -r name _ ours _ ports _; do
      [[ "$ours" == 1 && -n "$ports" ]] || continue
      IFS=',' read -r -a maps <<<"$ports"
      for m in "${maps[@]}"; do
        m="${m# }"
        [[ "$m" == *"->"* ]] || continue
        host="${m%%->*}"
        case "$host" in
          127.0.0.1:* | "[::1]:"*) ;;
          *:443) [[ "$name" == hz-workspace-edge-* ]] || bad_pub+=("$name $m") ;;
          *) bad_pub+=("$name $m") ;;
        esac
      done
    done <<<"$containers"
    if ((${#bad_pub[@]})); then res FOUT "workspace-poorten" "publiek gepubliceerd: ${bad_pub[*]}"; else res OK "workspace-poorten" "de workspace publiceert niets buiten 127.0.0.1"; fi
  fi

  # --- Automatische beveiligingsupdates --------------------------------------------------------------------------
  auto="$root/etc/apt/apt.conf.d/20auto-upgrades"
  if [[ -f "$auto" ]] && grep -Eq 'APT::Periodic::Unattended-Upgrade "1"' "$auto" && grep -Eq 'APT::Periodic::Update-Package-Lists "1"' "$auto"; then
    res OK updates "unattended-upgrades staat aan"
  else
    res FOUT updates "unattended-upgrades staat niet aan ($auto)"
  fi
  if [[ -f "$root/var/run/reboot-required" ]]; then res WAARSCHUWING herstart "herstart nodig na updates"; fi

  # --- Docker ----------------------------------------------------------------------------------------------------
  if ((docker_ok)); then res OK docker "draait en is leesbaar"; else res FOUT docker "draait niet of is niet leesbaar"; fi
fi

# ---------------------------------------------------------------------------------------------------------------
# Voorcheck: botst de workspace met de projecten die er al draaien?
# ---------------------------------------------------------------------------------------------------------------
if [[ -z "$extern" ]]; then
  pre() { res "$1" "voorcheck $2" "$3"; }
  kind="${HZ_PROXY_KIND:-}"
  if ! valid_proxy; then
    pre FOUT instellingen "HZ_PROXY_KIND moet caddy, traefik of eigen zijn; bij caddy HZ_PROXY_NETWORK of HZ_ROUTER_PORT, bij traefik HZ_PROXY_NETWORK"
  fi
  if [[ -z "${HZ_DOMAIN:-}" || -z "${HZ_TEST_DOMAIN:-}" ]]; then
    pre FOUT instellingen "HZ_DOMAIN en HZ_TEST_DOMAIN ontbreken (hz.env of omgeving)"
  else
    proxy_env
  fi

  if ((docker_ok == 0)); then
    pre FOUT docker "docker ps/network ls/volume ls niet leesbaar; zonder kan de voorcheck niets uitsluiten"
  else
    # --- De bestaande reverse proxy (wie publiceert 443?) ------------------------------------------------------
    re443='(^|[ ,])(0\.0\.0\.0|\[::\]|::)?:443->'
    proxy_name=""
    proxy_image=""
    proxy_nets=""
    while IFS="$S" read -r name _ ours image ports nets _; do
      [[ "$ours" == 1 ]] && continue
      if [[ "$ports" =~ $re443 ]]; then
        proxy_name="$name"
        proxy_image="$image"
        proxy_nets="$nets"
        break
      fi
    done <<<"$containers"
    host_443=0
    while read -r proto addr port; do
      [[ "$proto" == tcp && "$port" == 443 ]] && ! is_loopback "$addr" && host_443=1
    done < <(listeners)
    ours_443=0
    while IFS="$S" read -r name _ ours _ ports _; do
      [[ "$name" == hz-workspace-edge-* && "$ours" == 1 && "$ports" == *:443-\>* ]] && ours_443=1
    done <<<"$containers"

    case "$kind" in
      eigen)
        if [[ -n "$proxy_name" ]]; then
          pre FOUT proxy "443 is bezet door container $proxy_name ($proxy_image): sluit aan op die proxy (HZ_PROXY_KIND=caddy of traefik), geen eigen edge"
        elif ((host_443 && !ours_443)); then
          pre FOUT proxy "443 is bezet door een proces op de host: sluit daarop aan, geen eigen edge"
        else
          pre OK proxy "443 is vrij (of al van onze eigen edge): eigen edge mogelijk"
        fi
        ;;
      caddy | traefik)
        if [[ -n "$proxy_name" ]]; then
          found=other
          [[ "${proxy_image,,}" == *caddy* ]] && found=caddy
          [[ "${proxy_image,,}" == *traefik* || "${proxy_image,,}" == *coolify-proxy* ]] && found=traefik
          if [[ "$found" != "$kind" ]]; then
            pre FOUT proxy "op 443 draait $proxy_name ($proxy_image), niet $kind: zet HZ_PROXY_KIND goed"
          elif [[ -n "${HZ_PROXY_NETWORK:-}" && ",$proxy_nets," != *",$HZ_PROXY_NETWORK,"* ]]; then
            pre FOUT proxy "proxy $proxy_name zit niet in netwerk $HZ_PROXY_NETWORK (wel: $proxy_nets)"
          elif [[ -z "${HZ_PROXY_NETWORK:-}" ]]; then
            pre FOUT proxy "proxy $proxy_name draait in Docker: zet HZ_PROXY_NETWORK op een van zijn netwerken ($proxy_nets)"
          else
            pre OK proxy "$kind in container $proxy_name ($proxy_image), netwerk $HZ_PROXY_NETWORK"
          fi
        elif ((host_443)); then
          if [[ -n "${HZ_ROUTER_PORT:-}" && -z "${HZ_PROXY_NETWORK:-}" ]]; then
            pre OK proxy "proxy op de host (443); de router luistert op 127.0.0.1:$HZ_ROUTER_PORT"
          else
            pre FOUT proxy "de proxy draait op de host, niet in Docker: gebruik HZ_ROUTER_PORT in plaats van HZ_PROXY_NETWORK"
          fi
        else
          pre FOUT proxy "geen reverse proxy op 443 gevonden"
        fi
        ;;
    esac

    # --- Poorten -----------------------------------------------------------------------------------------------
    want_ports=()
    if [[ -n "${HZ_ROUTER_PORT:-}" && -z "${HZ_PROXY_NETWORK:-}" && "$kind" != eigen ]]; then
      want_ports+=("$HZ_ROUTER_PORT" "$((HZ_ROUTER_PORT + 1))")
    fi
    clash=()
    for p in "${want_ports[@]}"; do
      mine=0
      while IFS="$S" read -r name _ ours _ ports _; do
        [[ "$name" == hz-workspace-router-* && "$ours" == 1 && "$ports" == *127.0.0.1:$p-\>* ]] && mine=1
      done <<<"$containers"
      ((mine)) && continue
      while read -r proto addr port; do
        [[ "$proto" == tcp && "$port" == "$p" ]] && clash+=("$p ($addr)")
      done < <(listeners)
      while IFS="$S" read -r name _ ours _ ports _; do
        [[ "$ours" != 1 && "$ports" == *:$p-\>* ]] && clash+=("$p (container $name)")
      done <<<"$containers"
    done
    if ((${#clash[@]})); then
      pre FOUT poorten "bezet door een ander project: ${clash[*]}"
    elif ((${#want_ports[@]})); then
      pre OK poorten "${want_ports[*]} vrij op 127.0.0.1"
    else
      pre OK poorten "de workspace heeft geen eigen poort nodig (router via het netwerk van de proxy)"
    fi

    # --- Docker-netwerken -----------------------------------------------------------------------------------
    bad=()
    while IFS="$S" read -r name ours; do
      [[ "$name" == hz-workspace* && "$ours" != 1 ]] && bad+=("$name")
    done <<<"$networks"
    if ((${#bad[@]})); then pre FOUT netwerken "naam al in gebruik door iets anders: ${bad[*]}"; else pre OK netwerken "geen netwerk met een hz-workspace-naam van een ander project"; fi
    if [[ -n "${HZ_PROXY_NETWORK:-}" ]]; then
      exists=0
      while IFS="$S" read -r name _; do [[ "$name" == "$HZ_PROXY_NETWORK" ]] && exists=1; done <<<"$networks"
      if ((exists)); then
        pre OK proxynetwerk "$HZ_PROXY_NETWORK bestaat (van de proxy; alleen de router doet erin mee)"
      else
        pre FOUT proxynetwerk "$HZ_PROXY_NETWORK bestaat niet"
      fi
    fi

    # --- Compose-projecten en containers ----------------------------------------------------------------------
    bad=()
    projects=()
    while IFS="$S" read -r name project ours _; do
      [[ -n "$name" ]] || continue
      [[ -n "$project" && "$ours" != 1 ]] && projects+=("$project")
      if [[ ("$project" == hz-workspace* || "$name" == hz-workspace*) && "$ours" != 1 ]]; then bad+=("$name${project:+ (project $project)}"); fi
    done <<<"$containers"
    if ((${#bad[@]})); then
      pre FOUT projecten "hz-workspace-naam al in gebruik: ${bad[*]}"
    else
      pre OK projecten "geen botsing; andere projecten: $(printf '%s\n' "${projects[@]}" | sort -u | tr '\n' ' ')"
    fi

    # --- Volumes ----------------------------------------------------------------------------------------------
    bad=()
    while IFS="$S" read -r name ours; do
      [[ "$name" == hz-workspace* && "$ours" != 1 ]] && bad+=("$name")
    done <<<"$volumes"
    if ((${#bad[@]})); then pre FOUT volumes "naam al in gebruik door iets anders: ${bad[*]}"; else pre OK volumes "geen volume met een hz-workspace-naam van een ander project"; fi
  fi

  # --- Mappen onder /srv en /opt ---------------------------------------------------------------------------------
  bad=()
  for d in "$root/srv/hz-workspace" "$root/opt/hz-workspace"; do
    [[ -e "$d" && ! -f "$d/.hz-workspace" ]] && bad+=("${d#"$root"}")
  done
  other_dirs="$(find "$root/srv" "$root/opt" -mindepth 1 -maxdepth 1 ! -name hz-workspace -printf '%p\n' 2>/dev/null | sed "s#^$root##" | sort | tr '\n' ' ')"
  if ((${#bad[@]})); then
    pre FOUT mappen "bestaat al en is niet van de workspace (geen .hz-workspace): ${bad[*]}"
  else
    pre OK mappen "/srv/hz-workspace is vrij of van ons; andere mappen: ${other_dirs:-geen}"
  fi

  # --- Gebruiker en systemd-units --------------------------------------------------------------------------------
  pw="$(grep -E '^hz-workspace:' "$root/etc/passwd" 2>/dev/null || true)"
  if [[ -n "$pw" && "$(cut -d: -f6 <<<"$pw")" != /srv/hz-workspace ]]; then
    pre FOUT gebruiker "hz-workspace bestaat al met een andere thuismap ($(cut -d: -f6 <<<"$pw"))"
  else
    pre OK gebruiker "hz-workspace ${pw:+bestaat (van ons)}${pw:-is vrij}"
  fi
  bad=()
  for u in "$root"/etc/systemd/system/hz-workspace-*; do
    [[ -f "$u" ]] || continue
    head -n1 "$u" | grep -q '^# hz-workspace' || bad+=("$(basename "$u")")
  done
  if ((${#bad[@]})); then pre FOUT units "systemd-units met onze naam van iets anders: ${bad[*]}"; else pre OK units "geen botsing met systemd-units"; fi

  # --- Domeinen in de configuratie van de bestaande proxy en in labels van andere containers ---------------------
  if [[ -n "${HZ_DOMAIN:-}" && -n "${HZ_TEST_DOMAIN:-}" ]]; then
    cfg_text=""
    cfg_found=()
    for c in ${HZ_PROXY_CONFIG:-/etc/caddy /etc/traefik /data/coolify/proxy}; do
      p="$root$c"
      [[ -e "$p" ]] || continue
      while IFS= read -r f; do
        cfg_found+=("${f#"$root"}")
        [[ "$(basename "$f")" == hz-workspace* ]] && continue
        # Ons eigen blok (tussen de markeringen) telt niet mee.
        cfg_text+="$(awk '/^[[:space:]]*# >>> hz-workspace/{skip=1} !skip{print} /^[[:space:]]*# <<< hz-workspace/{skip=0}' "$f" 2>/dev/null)"$'\n'
      done < <(find "$p" -type f \( -name 'Caddyfile*' -o -name '*.caddy' -o -name '*.yml' -o -name '*.yaml' -o -name '*.toml' -o -name '*.conf' \) 2>/dev/null | sort)
    done
    label_text=""
    if ((docker_ok)); then
      while IFS="$S" read -r name _ ours _ _ _ labels; do
        [[ "$ours" == 1 ]] && continue
        label_text+="$name: $labels"$'\n'
      done <<<"$containers"
    fi
    hit=()
    cover=()
    re_dom() { printf '%s' "${1//./\\.}"; }
    for d in "$HZ_DOMAIN" "$HZ_TEST_DOMAIN" "$HZ_ERRORS_DOMAIN" "*.$HZ_TEST_DOMAIN"; do
      r="$(re_dom "${d#\*.}")"
      if [[ "$d" == \*.* ]]; then r="\\*\\.$r"; fi
      re="(^|[^a-z0-9.*-])$r([^a-z0-9.-]|$)"
      grep -Eiq "$re" <<<"$cfg_text" && hit+=("$d (proxyconfig)")
      if grep -Eiq "$re" <<<"$label_text"; then hit+=("$d (labels van $(grep -Ei "$re" <<<"$label_text" | cut -d: -f1 | head -n1))"); fi
      # Een wildcard van een ander project die ons domein al dekt (bijv. *.verveen.me voor homezero.verveen.me).
      if [[ "$d" != \*.* ]]; then
        parent="${d#*.}"
        if grep -Eiq "(^|[^a-z0-9.-])\\*\\.$(re_dom "$parent")([^a-z0-9.-]|$)" <<<"$cfg_text$label_text"; then cover+=("*.$parent dekt $d"); fi
      fi
    done
    if ((${#hit[@]})); then
      pre FOUT domeinen "al in gebruik bij een ander project: ${hit[*]}"
    else
      pre OK domeinen "$HZ_DOMAIN, $HZ_TEST_DOMAIN, *.$HZ_TEST_DOMAIN en $HZ_ERRORS_DOMAIN komen nergens anders voor"
    fi
    ((${#cover[@]})) && pre WAARSCHUWING wildcard "${cover[*]}: het specifiekere blok van de workspace wint, controleer na het aansluiten"
    if [[ "$kind" == caddy ]]; then
      if ((${#cfg_found[@]} == 0)); then
        pre WAARSCHUWING proxyconfig "configuratie van de proxy niet gevonden of niet leesbaar (HZ_PROXY_CONFIG)"
      else
        if grep -Eq '^[[:space:]]*on_demand_tls' <<<"$cfg_text"; then
          pre WAARSCHUWING on_demand "de proxy heeft al on_demand_tls: voeg de ask van de workspace samen met de bestaande (RUNBOOK.md §2)"
        fi
        if grep -q 'hz-workspace.caddy' <<<"$cfg_text"; then
          pre OK aangesloten "de proxy importeert het site-blok van de workspace"
        else
          pre WAARSCHUWING aangesloten "het site-blok staat nog niet in de proxy (proxy-snippet.sh caddy, RUNBOOK.md §2)"
        fi
      fi
    fi
  fi

  # --- Geheugen --------------------------------------------------------------------------------------------------
  # Som van de limieten in compose/ (prod + test + ops + router); config.test.ts houdt dit getal gelijk aan de bestanden.
  limits_mib=5760
  avail="$(awk '/^MemAvailable:/ {print int($2/1024)}' "$root/proc/meminfo" 2>/dev/null || true)"
  if [[ -n "$avail" ]]; then
    running=0
    while IFS="$S" read -r _ _ ours _; do [[ "$ours" == 1 ]] && running=1; done <<<"${containers:-}"
    if ((running)); then
      pre OK geheugen "${avail} MiB beschikbaar; de workspace draait al (limieten samen ${limits_mib} MiB)"
    elif ((avail < limits_mib)); then
      pre WAARSCHUWING geheugen "${avail} MiB beschikbaar, limieten samen ${limits_mib} MiB: verlaag HZ_MEM_* in hz.env of reken op minder ruimte"
    else
      pre OK geheugen "${avail} MiB beschikbaar, limieten samen ${limits_mib} MiB"
    fi
  fi
fi

if ((markdown)); then
  printf '| Status | Controle | Toelichting |\n|---|---|---|\n'
  for r in "${results[@]}"; do IFS='|' read -r s c t <<<"$r" && printf '| %s | %s | %s |\n' "$s" "$c" "$t"; done
  printf '\n%s\n' "$( ((fails)) && echo "**$fails controle(s) rood**" || echo '**Alles groen**')"
else
  for r in "${results[@]}"; do IFS='|' read -r s c t <<<"$r" && printf '%-13s %-36s %s\n' "$s" "$c" "$t"; done
fi
((fails == 0))
