# Server en uitrol als code (stuk E0)

Alles om de HomeZero Workspace op één Hetzner Cloud-server te draaien, als code in deze map: cloud-init, Docker-images,
Compose, Caddy, GitHub Actions, back-ups, secrets, monitoring en een runbook. Lokaal gevalideerd (zonder Docker);
het echte aanmaken van server, DNS, Storage Box en secrets is mensenwerk met exacte stappen in
[`RUNBOOK.md`](RUNBOOK.md) en de bijlage van `../HUMAN_INPUT.md`.

Stories: HZW-002 (server), 003 (DNS en TLS), 004 (CI/CD), 005 (preview per PR), 006 (secrets), 007 (monitoring),
008 (back-ups), 082 (verhuizen). HZW-001 (repo en CI) stond al; E0 voegt de infra-workflows toe.

## Keuze: Compose + Caddy, niet Coolify (plaat, keuze 01, open vraag H4)

De plaat stelt Coolify voor, met Compose + Caddy als alternatief, en laat de keuze open (H4: "Coolify, of Docker
Compose + Caddy met previews via GitHub Actions?"). Gekozen: **Compose + Caddy, uitgerold door GitHub Actions**.

| | Coolify | Compose + Caddy (gekozen) |
|---|---|---|
| Alles in Git | Nee: projecten, omgevingen en secrets staan in de database van Coolify | Ja: compose, Caddyfile, scripts en versleutelde secrets |
| Lokaal te testen | Nee (alleen in een draaiende Coolify) | Ja: schema's, Caddy, scripts met nep-docker, back-up tegen Postgres |
| Stories | HZW-004 vraagt images in GHCR en uitrol vanuit Actions; Coolify bouwt zelf | Past precies: Actions bouwt, de server haalt op |
| Onderhoud | Coolify zelf moet updates krijgen (de plaat noemt dat als nadeel) | Alleen Ubuntu (automatisch), Docker en Caddy (images, Dependabot) |
| Verhuizen (HZW-082) | Coolify-database meeverhuizen | Cloud-init opnieuw draaien en de back-up terugzetten |
| Previews per PR | Ingebouwd | Gebouwd: `preview.sh` en workflow `workspace-preview` (on-demand TLS) |

De plaat zegt het zelf: "Kent je developer Coolify niet, dan is Compose + Caddy het eenvoudigere alternatief", en de
briefing vraagt "alles als script in de repo". De bouwers zijn hier AI-agents zonder draaiende Coolify, dus wat
Coolify extra geeft (een UI) is niet te testen, en wat het kost (state buiten Git) botst met de werkwijze. De
compose-bestanden zijn gewone Compose: overstappen naar Coolify later kan met dezelfde bestanden
(Docker Compose-buildpack), als het team dat toch wil.

## Op de server

```
Hetzner Cloud CX32 (Ubuntu 24.04, Neurenberg)          firewall: 22, 80, 443 (Hetzner + ufw)
├── hz-edge     Caddy: TLS (Let's Encrypt), http->https, routering per domein; on-demand TLS voor previews
├── hz-prod     db (Postgres 16), migrate, api, worker, web     https://{HZ_DOMAIN}
├── hz-test     idem, eigen database                            https://{HZ_TEST_DOMAIN}
├── hz-pr-<nr>  idem, demodata, achter wachtwoord               https://pr-<nr>.{HZ_TEST_DOMAIN}
├── hz-ops      GlitchTip (foutregistratie)                     https://{HZ_ERRORS_DOMAIN}
└── systemd     hz-backup (02:30), hz-hersteltest (maandelijks), hz-heartbeat (elke 5 min)
```

- Per instantie serveert de web-container (Caddy) de SPA en zet `/api` door naar zijn eigen api; de edge kent per
  instantie één adres (`<instantie>-web`). Domeinen staan alleen in `/etc/hz/hz.env`: een ander domein of een
  tweede server is geen codewijziging.
- De database heeft geen open poort. Rollen (`postgres/hz-roles.sh`): `hz_migrator` (eigenaar, migraties en
  pg-boss), `hz_app` (runtime, RLS), `hz_app_login` (DATABASE_URL van api en worker, alleen lid van hz_app),
  `hz_backup` (BYPASSRLS, alleen lezen: een dump als eigenaar faalt door FORCE RLS).
- GitHub Actions komt binnen als gebruiker `deploy` met een SSH-sleutel die alleen `hz-ssh-dispatch` mag draaien
  (deploy, rollback, preview up/down, status, check). Het registry-token is de GITHUB_TOKEN van die run.
- De uitrolbundel (deze map plus de rollen-SQL) reist mee in het api-image; compose, Caddyfile en scripts horen dus
  altijd bij dezelfde versie van de app.

## Mappen

| Pad | Wat |
|---|---|
| `cloud-init/render.mjs` | user-data voor een nieuwe server (gebruikers, SSH, ufw, updates, Docker, timers, vaste scripts) |
| `docker/*.Dockerfile`, `docker/build-app.sh` | images voor api, worker en web; `build-app.sh` is wat de Dockerfiles draaien |
| `docker/web.Caddyfile`, `docker/web-csp.mjs` | web-container: SPA, `/api`, CSP met de hash van het inline thema-script |
| `compose/app.yaml`, `edge.yaml`, `ops.yaml` | een instantie, de edge-proxy, GlitchTip |
| `caddy/Caddyfile` | edge: TLS, routering, previews, logs zonder persoonsgegevens |
| `postgres/hz-roles.sh` | databaserollen (eerste start van de db-container, en bij een verhuizing) |
| `scripts/deploy.sh`, `preview.sh`, `hz-ssh-dispatch.sh` | uitrol met health-check en rollback, previews, forced command |
| `scripts/backup.sh`, `restore.sh`, `hersteltest.sh` | back-up (age) naar de Storage Box, herstel, hersteltest met rijen tellen |
| `scripts/secrets.sh`, `secrets/` | secrets met age: versleuteld in Git, `.keys` zegt welke er moeten zijn |
| `scripts/heartbeat.sh`, `server-check.sh`, `tls-check.sh` | uptime-hartslag, servercontrole, TLS-controle |
| `scripts/verhuis-proef.sh`, `hetzner-create.sh` | proefverhuizing, server aanmaken met hcloud |
| `systemd/` | timers voor back-up, hersteltest en hartslag |
| `test/` | vitest: schema's, parsers, scripts met nep-docker, back-up en verhuizing tegen Postgres |

Workflows (in `../../.github/workflows`): `workspace-deploy` (test bij merge, productie bij release),
`workspace-preview` (per PR), `workspace-infra` (statische controles, images echt bouwen, rooktest web-container),
`workspace-server-check` (wekelijks, uitkomst in een issue). De bestaande `workspace-app` installeert nu ook `age`
voor de infra-tests.

## Lokaal controleren

```bash
pnpm --filter @hz/infra test          # alle infra-tests (Postgres op localhost:5432 nodig, zie hieronder)
bash infra/scripts/validate.sh        # shellcheck, actionlint, caddy validate, compose config, timers, cloud-init
node infra/scripts/web-smoke.mjs      # web-container (Caddy + CSP) in een echte browser; vereist caddy en apps/web/dist
```

De back-up- en verhuistests maken rollen met BYPASSRLS en hebben dus een superuser nodig: `HZ_PG_ADMIN_URL`, of in CI
`postgres` met `PGPASSWORD`, of lokaal als root via `su postgres` (maakt `hz_e0_admin`). Testdatabases en -rollen
beginnen met `hz_e0_`.

## Wat er in de app veranderde (klein, toevoegend)

- `packages/ops` (nieuw): foutregistratie (Sentry-envelope naar GlitchTip, zonder SDK), JSON-logs zonder
  persoonsgegevens, access-log met gemaskeerde paden, hartslag voor de worker.
- `apps/api/src/index.ts`: `installOps`, access-log rond `app.fetch`, en `HZ_API_HOST` (container: `0.0.0.0`).
- `apps/worker/src/index.ts`: `installOps` en de hartslag, onderaan.

Nieuwe omgevingsvariabelen (alle optioneel; lokaal staat alles uit, de images zetten de productiewaarden):
`HZ_API_HOST` (container `0.0.0.0`), `HZ_ERROR_DSN` (GlitchTip), `HZ_LOG_FORMAT=json`, `HZ_ENVIRONMENT`,
`HZ_RELEASE` (image-tag) en `HZ_WORKER_HEARTBEAT` (pad van het hartslagbestand).

Na het samenvoegen met E2 (eigen pg-boss-login `HZ_BOSS_DATABASE_URL`) en E1 (Google-inloggen) klopt `compose/app.yaml`
al: de worker krijgt `HZ_BOSS_DATABASE_URL` (migratierol) naast `DATABASE_URL` (app-login), en de E1-secrets staan in
`secrets/prod.keys`.
