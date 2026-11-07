#!/usr/bin/env bash
# Eenmalig per nieuwe Claude-cloudsessie (verse container): Postgres-rollen en afhankelijkheden klaarzetten.
# Idempotent: twee keer draaien kan geen kwaad. Gebruik vanuit de hoofdmap van de repo:
#   bash tools/lead/cloud-setup.sh
# Verwacht Postgres 16 op localhost:5432 met superuser 'postgres' (zo is de cloudomgeving 'Default').
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
APP=.; [ -d workspace-app ] && APP=workspace-app   # werkt in de sandbox en in de eigen repo

as_pg() { if command -v sudo >/dev/null && sudo -n -u postgres true 2>/dev/null; then sudo -n -u postgres psql -v ON_ERROR_STOP=1 "$@"; else psql -h localhost -U postgres -v ON_ERROR_STOP=1 "$@"; fi; }

if ! pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
  (command -v service >/dev/null && service postgresql start) || { echo "Postgres draait niet op localhost:5432" >&2; exit 1; }
fi
as_pg -tAc "select 1 from pg_roles where rolname='hz_dev'" | grep -q 1 \
  || as_pg -c "create role hz_dev login password 'hz_dev' createdb nosuperuser nocreaterole nobypassrls"
as_pg -v migrator=hz_dev -f "$APP/packages/db/sql/bootstrap-roles.sql" >/dev/null
(cd "$APP" && pnpm install --frozen-lockfile >/dev/null)
echo "Klaar: rollen hz_dev en hz_app staan, afhankelijkheden geïnstalleerd. Controle: (cd $APP && pnpm -r test)"
