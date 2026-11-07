# Jouw testronde (gebundeld)

Alles wat een mens moet doen of goedkeuren, per story. Bouwers vullen dit aan; de lead bundelt het tot één testronde.

| Story | Wat | Hoe testen | Nodig |
|---|---|---|---|
| HZW-001 | Goedkeuring repo-structuur en README (fundament) | `pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e`; README lezen. Na push: Actions-tab, workflow `workspace-app` moet groen zijn | Niets; de workflow staat in de git-root (`.github/workflows/workspace-app.yml`) en draait pas na push (de lead pusht) |
| HZW-006 | Hoofdsleutel voor tokenversleuteling aanmaken en als secret zetten | `openssl rand -base64 32` als `HZ_TOKEN_KEY` in de server-secrets; de API weigert in productie te starten zonder (`apps/api/test/api.test.ts`, configuratie) | Toegang tot de secret-opslag (Coolify of sops/age) |
| HZW-020 | Rollen op de productie-Postgres: runtime-rol `hz_app` en een aparte login voor de app | Als beheerder: `psql -v migrator=<migratierol> -f packages/db/sql/bootstrap-roles.sql`; daarna `CREATE ROLE hz_app_login LOGIN PASSWORD '…' NOINHERIT IN ROLE hz_app` (lid van alleen `hz_app`, eigenaar van niets) en die als `DATABASE_URL` van de api (de worker maakt met pg-boss een eigen schema aan en draait daarom met de migratierol; zijn queries op app-tabellen lopen via withUser als `hz_app`). Controle: `select rolsuper, rolbypassrls from pg_roles where rolname = current_user` geeft `f, f` en `pnpm --filter @hz/db test` is groen. Lokaal is dit al gedaan (hz_dev lid van hz_app) | Een databasebeheerder (superuser of CREATEROLE) op de productie-Postgres |
| HZW-040/041 | Goedkeuring schil en Dagstart naast de lat | `HZ_CONTEXT_EXPORT=<export> pnpm bar -- --modes demo,context && HZ_CONTEXT_EXPORT=<export> pnpm shot -- --modes demo,context && node tools/compare.mjs --blind`, open `.local/compare/index.html` | Een export van de contextlaag (alleen runtime) |
