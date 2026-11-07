#!/usr/bin/env bash
# TLS- en doorstuurtest (HZW-003) voor één of meer domeinen:
#   1. http://<domein>/ stuurt door (301/308) naar https://<domein>/;
#   2. https://<domein>/api/health antwoordt 200 met een geldig certificaat (curl controleert keten en naam);
#   3. het certificaat is nog minstens HZ_TLS_MIN_DAYS (standaard 14) dagen geldig;
#   4. HSTS staat aan.
# Met --auth: het domein hoort een wachtwoord te vragen (401), zoals een preview.
#
#   tls-check.sh homezero.verveen.me test.homezero.verveen.me
#   tls-check.sh --auth pr-12.test.homezero.verveen.me
#
# Voor tests (lokale TLS-server): HZ_TLS_CONNECT=127.0.0.1, HZ_TLS_HTTPS_PORT, HZ_TLS_HTTP_PORT, HZ_TLS_CAFILE.
set -euo pipefail
HZ_SCRIPT=tls-check
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$here/lib.sh"
need openssl

expect_auth=0
domains=()
for a in "$@"; do
  case "$a" in
    --auth) expect_auth=1 ;;
    *) domains+=("$a") ;;
  esac
done
((${#domains[@]})) || die "gebruik: tls-check.sh [--auth] <domein>..."

https_port="${HZ_TLS_HTTPS_PORT:-443}"
http_port="${HZ_TLS_HTTP_PORT:-80}"
min_days="${HZ_TLS_MIN_DAYS:-14}"
fails=0
ok() { printf 'OK    %s\n' "$*"; }
bad() {
  printf 'FOUT  %s\n' "$*"
  fails=$((fails + 1))
}

for d in "${domains[@]}"; do
  [[ "$d" =~ ^[a-z0-9.-]+$ ]] || die "ongeldig domein: $d"
  curl_args=(-sS -m 15)
  if [[ -n "${HZ_TLS_CONNECT:-}" ]]; then
    curl_args+=(--connect-to "$d:$https_port:$HZ_TLS_CONNECT:$https_port" --connect-to "$d:$http_port:$HZ_TLS_CONNECT:$http_port")
  fi
  [[ -n "${HZ_TLS_CAFILE:-}" ]] && curl_args+=(--cacert "$HZ_TLS_CAFILE")
  hport=""
  [[ "$http_port" != 80 ]] && hport=":$http_port"
  sport=""
  [[ "$https_port" != 443 ]] && sport=":$https_port"

  # 1. http -> https
  read -r code loc < <("$HZ_CURL" "${curl_args[@]}" -o /dev/null -w '%{http_code} %{redirect_url}\n' "http://$d$hport/" || echo "000 -")
  if [[ "$code" =~ ^30[178]$ && "$loc" == "https://$d"* ]]; then
    ok "$d: http stuurt door naar https ($code)"
  else
    bad "$d: http stuurt niet door naar https (status $code, naar ${loc:--})"
  fi

  # 2. https met geldig certificaat (+ 4. HSTS)
  path=/api/health
  headers="$("$HZ_CURL" "${curl_args[@]}" -o /dev/null -D - "https://$d$sport$path" 2>&1)" || {
    bad "$d: https faalt: $(head -n1 <<<"$headers")"
    continue
  }
  status="$(awk 'NR==1 {print $2}' <<<"$headers")"
  if ((expect_auth)); then
    if [[ "$status" == 401 ]]; then ok "$d: vraagt om een wachtwoord (401)"; else bad "$d: verwacht 401, kreeg $status"; fi
  else
    if [[ "$status" == 200 ]]; then ok "$d: https $path geeft 200 met geldig certificaat"; else bad "$d: https $path geeft $status"; fi
  fi
  if grep -qi '^strict-transport-security:' <<<"$headers"; then ok "$d: HSTS staat aan"; else bad "$d: geen HSTS-header"; fi

  # 3. Geldigheid van het certificaat
  s_client=(-connect "${HZ_TLS_CONNECT:-$d}:$https_port" -servername "$d")
  [[ -n "${HZ_TLS_CAFILE:-}" ]] && s_client+=(-CAfile "$HZ_TLS_CAFILE")
  cert="$(openssl s_client "${s_client[@]}" </dev/null 2>/dev/null | openssl x509 2>/dev/null || true)"
  if [[ -z "$cert" ]]; then
    bad "$d: geen certificaat te lezen"
  elif openssl x509 -noout -checkend $((min_days * 86400)) <<<"$cert" >/dev/null; then
    ok "$d: certificaat geldig tot $(openssl x509 -noout -enddate <<<"$cert" | cut -d= -f2), uitgever $(openssl x509 -noout -issuer <<<"$cert" | sed 's/.*CN *= *//')"
  else
    bad "$d: certificaat verloopt binnen $min_days dagen ($(openssl x509 -noout -enddate <<<"$cert" | cut -d= -f2))"
  fi
done

if ((fails)); then
  printf '\n%d controle(s) rood\n' "$fails"
  exit 1
fi
printf '\nalles groen\n'
