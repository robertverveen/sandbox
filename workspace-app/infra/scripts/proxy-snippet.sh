#!/usr/bin/env bash
# Het stukje configuratie voor de reverse proxy die al op de server draait (HZW-003, plaat keuze 01).
# De workspace krijgt geen eigen proxy op 80/443: de bestaande proxy doet TLS voor onze domeinen en stuurt ze naar
# de router van de workspace (compose/router.yaml). Dit script maakt dat stukje uit hz.env, zodat er nooit een
# domein met de hand in komt. Wat de voorcheck aantreft, bepaalt de vorm:
#
#   proxy-snippet.sh caddy [--out <map>]     site-blokken (hz-workspace.caddy) en het stukje voor de globale opties
#                                            (hz-workspace.global.caddy, toestemming voor on-demand TLS van previews)
#   proxy-snippet.sh traefik                 niets aan Traefik zelf: de labels staan op de router
#                                            (compose/router-traefik.yaml); print ter controle de regels
#
# Bij een bestaande Caddy: beide bestanden in /srv/hz-workspace/proxy (deploy.sh houdt ze bij), en in de Caddyfile
# van de proxy één regel `import /srv/hz-workspace/proxy/hz-workspace.caddy` en in het globale blok
# `import /srv/hz-workspace/proxy/hz-workspace.global.caddy` (draait Caddy in Docker: de map read-only erbij
# mounten). Daarna `caddy validate` en `caddy reload` van die proxy; zie RUNBOOK.md §2.
# Alles staat tussen de markeringen '# >>> hz-workspace' en '# <<< hz-workspace': de voorcheck herkent zo wat van
# ons is, en weghalen is die regels weghalen.
#
# Omgeving: HZ_DOMAIN, HZ_TEST_DOMAIN, HZ_ERRORS_DOMAIN, en HZ_PROXY_NETWORK (proxy in Docker) of HZ_ROUTER_PORT
# (proxy op de host). Zonder die waarden in de omgeving: uit $HZ_ETC/hz.env.
set -euo pipefail
HZ_SCRIPT=proxy-snippet
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$here/lib.sh"

kind="${1:-}"
shift || true
out=""
while (($#)); do
  case "$1" in
    --out)
      out="${2:?map}"
      shift 2
      ;;
    *) die "onbekende optie: $1" ;;
  esac
done

if [[ -z "${HZ_DOMAIN:-}" ]]; then load_env "$HZ_ETC/hz.env"; fi
: "${HZ_DOMAIN:?}" "${HZ_TEST_DOMAIN:?}"
proxy_env
for d in "$HZ_DOMAIN" "$HZ_TEST_DOMAIN" "$HZ_ERRORS_DOMAIN"; do
  [[ "$d" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || die "ongeldig domein: $d"
done

# Waar de proxy de router vindt: via het gedeelde Docker-netwerk, of op 127.0.0.1 als de proxy op de host draait.
if [[ -n "${HZ_ROUTER_PORT:-}" && -z "${HZ_PROXY_NETWORK:-}" ]]; then
  upstream="127.0.0.1:$HZ_ROUTER_PORT"
  ask="http://127.0.0.1:$HZ_ROUTER_ASK_PORT/ask"
else
  upstream="hz-workspace-router:8080"
  ask="http://hz-workspace-router:8081/ask"
fi

begin='# >>> hz-workspace (infra/scripts/proxy-snippet.sh; niet met de hand aanpassen)'
end='# <<< hz-workspace'

caddy_sites() {
  cat <<EOF
$begin
# HomeZero Workspace: TLS hier, de rest (routering, previewwachtwoord, headers, logs) in de router.
$HZ_DOMAIN, $HZ_TEST_DOMAIN, $HZ_ERRORS_DOMAIN {
	reverse_proxy $upstream
}

# Previews per pull request: certificaat pas bij het eerste bezoek, alleen als de router zegt dat de preview bestaat.
*.$HZ_TEST_DOMAIN {
	tls {
		on_demand
	}
	reverse_proxy $upstream
}
$end
EOF
}

caddy_global() {
  cat <<EOF
$begin
on_demand_tls {
	ask $ask
}
$end
EOF
}

case "$kind" in
  caddy)
    if [[ -n "$out" ]]; then
      mkdir -p "$out"
      caddy_sites >"$out/hz-workspace.caddy.tmp" && mv "$out/hz-workspace.caddy.tmp" "$out/hz-workspace.caddy"
      caddy_global >"$out/hz-workspace.global.caddy.tmp" && mv "$out/hz-workspace.global.caddy.tmp" "$out/hz-workspace.global.caddy"
      chmod 644 "$out/hz-workspace.caddy" "$out/hz-workspace.global.caddy"
      log "site-blokken in $out/hz-workspace.caddy, globale opties in $out/hz-workspace.global.caddy"
    else
      caddy_sites
      printf '\n# In het globale blok van de proxy:\n'
      caddy_global
    fi
    ;;
  traefik)
    [[ -n "${HZ_PROXY_NETWORK:-}" ]] || die "Traefik vindt de router alleen via een Docker-netwerk: HZ_PROXY_NETWORK ontbreekt"
    cat <<EOF
$begin
# Traefik leest de labels van de router zelf (compose/router-traefik.yaml); aan Traefik verandert niets.
# Netwerk: $HZ_PROXY_NETWORK
# Host(\`$HZ_DOMAIN\`) || Host(\`$HZ_TEST_DOMAIN\`) || Host(\`$HZ_ERRORS_DOMAIN\`)  -> hz-workspace-router:8080
# HostRegexp(\`^pr-[0-9]{1,6}\\.$HZ_TEST_DOMAIN_RE$\`) (wildcard *.$HZ_TEST_DOMAIN, resolver met DNS-challenge) -> idem
$end
EOF
    ;;
  *)
    sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
