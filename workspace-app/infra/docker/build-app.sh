#!/usr/bin/env bash
# Bouwt de productiemap van de api of de worker (HZW-004): gebundelde code in dist/ en alleen de
# productie-node_modules. De Dockerfiles roepen dit script aan; de lokale test (infra/test) draait precies
# hetzelfde script, zodat de inhoud van een image ook zonder Docker te controleren is.
#
#   infra/docker/build-app.sh api /out      ->  /out/dist/index.js, /out/dist/migrate.js, /out/dist/ops-cli.js,
#                                               /out/drizzle/, /out/node_modules/, /out/bundle/ (alleen api)
#   infra/docker/build-app.sh worker /out
set -euo pipefail

app="${1:-}"
out="${2:-}"
case "$app" in
  api | worker) ;;
  *)
    echo "gebruik: build-app.sh api|worker <uitmap>" >&2
    exit 2
    ;;
esac
[[ -n "$out" ]] || { echo "uitmap ontbreekt" >&2; exit 2; }

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

pnpm --filter "@hz/$app" build
# Extra bundels naast dist/index.js: migraties (migrate.js) en beheeropdrachten (ops-cli.js).
pnpm --filter "@hz/$app" exec tsup --config "$root/infra/docker/tsup.extra.config.ts"

rm -rf "$out"
pnpm --filter "@hz/$app" deploy --legacy --prod "$out" >/dev/null
# Bron, tests en bouwconfig horen niet in het image; de bundels in dist/ zijn genoeg.
rm -rf "$out/src" "$out/test" "$out/tsconfig.json" "$out/tsup.config.ts"
# migrate.js zoekt de SQL-migraties in ../drizzle (packages/db/src/migrate.ts: MIGRATIONS_DIR).
mkdir -p "$out/drizzle"
cp -R packages/db/drizzle/. "$out/drizzle/"

if [[ "$app" == api ]]; then
  # De uitrolbundel reist mee in het api-image: deploy.sh op de server haalt hem eruit, zodat compose, Caddy,
  # scripts en de rollen-SQL altijd bij dezelfde versie van de app horen.
  mkdir -p "$out/bundle/infra" "$out/bundle/packages/db"
  tar -C infra --exclude=./test --exclude=./node_modules --exclude=./package.json --exclude=./tsconfig.json -cf - . |
    tar -C "$out/bundle/infra" -xf -
  cp -R packages/db/sql "$out/bundle/packages/db/sql"
fi
echo "klaar: $out"
