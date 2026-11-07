# Server en uitrol als code (stuk E0)

Alles om de HomeZero Workspace te draaien op **de bestaande Hetzner-server van Robert**, die al in zijn tailnet zit
en waar andere projecten op draaien (plaat, keuze 01, besloten 7 nov). Als code in deze map: voorcheck,
serverinrichting, Docker-images, Compose, de router en het site-blok voor de proxy die er al draait, GitHub Actions
via Tailscale, back-ups, secrets, monitoring en een runbook. Lokaal gevalideerd (zonder Docker-daemon en zonder
server); wat op de echte server en in de consoles moet, staat met exacte stappen in [`RUNBOOK.md`](RUNBOOK.md) en de
bijlage van `../HUMAN_INPUT.md`.

Stories: HZW-002 (server), 003 (DNS en TLS), 004 (CI/CD), 005 (preview per PR), 006 (secrets), 007 (monitoring),
008 (back-ups), 082 (verhuizen). HZW-001 (repo en CI) stond al; E0 voegt de infra-workflows toe.

## Het servermodel: naast de andere projecten, niets van hen raken

| Eis (HZW-002, 004, plaat 01) | Hoe |
|---|---|
| Geen nieuwe server | Geen cloud-init in de hoofdroute. `scripts/server-setup.sh` zet de workspace op de bestaande server, als root via Tailscale. Cloud-init en `hetzner-create.sh` zijn alleen een optie voor HZW-082. |
| Voorcheck op botsingen, droog | `scripts/server-check.sh --voorcheck` kijkt alleen: poorten, de reverse proxy op 443, Docker-netwerken, compose-projecten en containers, volumes, mappen onder `/srv` en `/opt`, gebruiker, systemd-units en onze domeinen in de config van de proxy en in labels van andere containers. Rood = stoppen. Draait vóór `server-setup.sh` en vóór elke uitrol (`deploy.sh`). |
| Eigen geïsoleerde stack | Gebruiker `hz-workspace`, map `/srv/hz-workspace` (met merkbestand `.hz-workspace`), compose-projecten `hz-workspace-prod`, `-test`, `-pr-<nr>`, `-ops`, `-router`, netwerken `hz-workspace-net` en `<project>-net`, eigen Postgres-volume per instantie, units `hz-workspace-*`. Alles draagt het label `nl.homezero.workspace=1`, zo herkent de voorcheck wat van ons is. |
| Geheugen- en CPU-limieten | `mem_limit` en `cpus` op elke service (instelbaar met `HZ_MEM_*`/`HZ_CPUS_*` in `hz.env`; previews kleiner, maximaal 3). Samen hooguit 5760 MiB voor productie, test, GlitchTip en router; de voorcheck vergelijkt dat met het vrije geheugen. |
| Aansluiten op de proxy die er al draait | Geen eigen proxy op 80/443. Eén **router** (Caddy, zonder TLS, zonder publieke poort) verdeelt onze domeinen over de instanties. De bestaande proxy krijgt alleen een site-blok (Caddy, `scripts/proxy-snippet.sh caddy`) of leest labels van de router (Traefik, ook de proxy van Coolify). Alleen de router doet mee in het netwerk van de proxy (of luistert op 127.0.0.1 als de proxy op de host draait). |
| Beheer alleen via Tailscale, publiek alleen 443 | De servercontrole eist dat sshd alleen op het tailnet-adres luistert (of dat ufw 22 alleen op `tailscale0` toelaat), alleen met sleutel. Publiek alleen 443 (de proxy; 80 mag alleen doorsturen). De workspace publiceert zelf niets buiten 127.0.0.1. |
| Uitrol nooit via publieke SSH | GitHub Actions wordt een tijdelijke, getagde Tailscale-node (`tailscale/github-action`, `tag:ci`, ephemeral, OAuth-client). `scripts/ci-ssh.sh` weigert elk doel dat niet naar een tailnet-adres wijst. De ACL (`tailscale/acl.hujson`) laat `tag:ci` alleen bij poort 22 van de server; op de server mag elke sleutel alleen `hz-ssh-dispatch` met zijn eigen rol. |
| Productie alleen na goedkeuring, ook niet via een pull request (HZW-004) | Drie CI-sleutels, elk een environment-secret (nooit repo-secret, die kan elke PR-workflow lezen): `test` (alleen `main`), `production` (required reviewer), `preview`. Op de server een vaste rol per sleutel in `authorized_keys`: `deploy prod` alleen een v-tag, met de images (per digest) die bij die commit op test groen waren; `deploy test` alleen een sha-tag; PR-tags alleen voor `preview up`. Zie `scripts/hz-ssh-dispatch.sh`. |
| Tags in de registry zijn overschrijfbaar | Een PR-workflow mag packages schrijven (voor zijn preview) en kan dus elke tag overschrijven. De server draait daarom test en productie per digest: de digests komen uit de build-job van de run op `main` en liggen daarna vast (`/srv/hz-workspace/images/<tag>.env`); een tag met andere digests wordt geweigerd. |
| Previews raken de secrets van productie niet | `preview.sh` komt uit de bundel die op test draait (main), nooit uit het PR-image, en draait als gebruiker `hz-preview` (alleen `docker`, niet de groep `hz-workspace`, dus `etc/age.key` is onleesbaar). Van de PR draaien alleen de containers: read-only, `cap_drop: ALL`, geen mounts van de server, geen Docker-socket. |
| Automatische beveiligingsupdates | De servercontrole eist `unattended-upgrades` aan. |

## Keuze: Compose + router achter de bestaande proxy, niet Coolify (plaat keuze 01, H4)

De plaat stelt Coolify voor, met Compose + Caddy als alternatief; sinds 7 nov staat vast dat het de bestaande server
wordt, "aangesloten op de reverse proxy die er al draait (Caddy, Traefik of Coolify, wat het onderzoek vindt)".
Gekozen: **Compose, uitgerold door GitHub Actions via Tailscale, met een eigen router achter die proxy**.

| | Coolify erbij installeren | Compose + router (gekozen) |
|---|---|---|
| Op een server met andere projecten | Nieuw beheerplatform met eigen proxy (Traefik op 80/443): botst met de proxy die er al draait | Alleen een router zonder poort; de bestaande proxy blijft de baas |
| Alles in Git | Nee: projecten, omgevingen en secrets in de database van Coolify | Ja: compose, router, scripts, versleutelde secrets |
| Lokaal te testen | Nee | Ja: schema's, Caddy echt gestart, scripts met nep-docker en een nep-server met andere projecten |
| Draait er al Coolify? | - | Dan is de proxy Traefik op netwerk `coolify`: `HZ_PROXY_KIND=traefik`, de router krijgt labels; geen Coolify-project nodig |
| Previews per PR | Ingebouwd | `preview.sh` en workflow `workspace-preview`; de router routeert `pr-<nr>`, de proxy vraagt het certificaat on-demand |

## Op de server

```
Bestaande Hetzner-server (in Roberts tailnet)          publiek alleen 443 (de proxy); SSH alleen via tailscale0
├── bestaande proxy (Caddy/Traefik, van de andere projecten)  TLS voor onze domeinen -> hz-workspace-router
├── andere projecten                                     ongemoeid; de voorcheck bewaakt dat
└── /srv/hz-workspace (gebruiker hz-workspace)
    ├── hz-workspace-router   Caddy zonder TLS: domein -> instantie, previewwachtwoord, headers, logs zonder PII
    ├── hz-workspace-prod     db (Postgres 16), migrate, api, worker, web     https://{HZ_DOMAIN}
    ├── hz-workspace-test     idem, eigen database                            https://{HZ_TEST_DOMAIN}
    ├── hz-workspace-pr-<nr>  idem, demodata, achter wachtwoord               https://pr-<nr>.{HZ_TEST_DOMAIN}
    ├── hz-workspace-ops      GlitchTip (foutregistratie)                     https://{HZ_ERRORS_DOMAIN}
    └── systemd               hz-workspace-backup (02:30), -hersteltest (maandelijks), -heartbeat (elke 5 min)
```

- Per instantie serveert de web-container (Caddy) de SPA en zet `/api` door naar zijn eigen api; de router kent per
  instantie één adres (`<instantie>-web` op `hz-workspace-net`). Domeinen staan alleen in `/srv/hz-workspace/etc/hz.env`:
  een ander domein of een andere server is geen codewijziging.
- De database heeft geen open poort. Rollen (`postgres/hz-roles.sh`): `hz_migrator` (eigenaar, migraties en
  pg-boss), `hz_app` (runtime, RLS), `hz_app_login` (DATABASE_URL van api en worker, alleen lid van hz_app),
  `hz_backup` (BYPASSRLS, alleen lezen: een dump als eigenaar faalt door FORCE RLS).
- De uitrolbundel (deze map plus de rollen-SQL) reist mee in het api-image; compose, router, scripts en voorcheck
  horen dus altijd bij dezelfde versie van de app.
- `hz-workspace` en `hz-preview` zitten in de groep `docker` (nodig voor Compose). Docker-toegang is op elke server
  root-gelijk; daarom kan elke CI-sleutel alleen `hz-ssh-dispatch` met een vaste rol draaien, staan de vaste scripts
  in een map van root, en voert de server nooit een script uit een PR-image uit. Wie de previewsleutel heeft, kan dus
  alleen previews starten en opruimen.

## Mappen

| Pad | Wat |
|---|---|
| `scripts/server-check.sh` | servercontrole en voorcheck (alleen lezen) |
| `scripts/server-setup.sh` | workspace klaarzetten op een server, na een groene voorcheck; `--dry-run` wijzigt niets |
| `scripts/proxy-snippet.sh` | site-blok voor een bestaande Caddy (of de eigen edge), controle-uitvoer voor Traefik |
| `compose/app.yaml`, `ops.yaml` | een instantie, GlitchTip |
| `compose/router.yaml` + `router-network.yaml`, `router-loopback.yaml`, `router-traefik.yaml` | de router en hoe de proxy hem bereikt |
| `compose/edge.yaml`, `caddy/edge/Caddyfile` | eigen edge op 443, **alleen** voor een server zonder proxy (HZW-082) |
| `caddy/router/Caddyfile` | routering, previews (wachtwoord, toestemming voor on-demand TLS), headers, logs zonder PII |
| `docker/*.Dockerfile`, `docker/build-app.sh`, `docker/web.Caddyfile`, `docker/web-csp.mjs` | images voor api, worker en web |
| `postgres/hz-roles.sh` | databaserollen (eerste start van de db-container, elke uitrol, verhuizing) |
| `scripts/deploy.sh`, `preview.sh`, `hz-ssh-dispatch.sh`, `ci-ssh.sh` | uitrol met voorcheck, health-check en rollback; previews; forced command; SSH alleen via het tailnet |
| `scripts/backup.sh`, `restore.sh`, `hersteltest.sh` | back-up (age) naar de Storage Box, herstel, hersteltest met rijen tellen |
| `scripts/secrets.sh`, `secrets/` | secrets met age: versleuteld in Git, `.keys` zegt welke er moeten zijn |
| `scripts/heartbeat.sh`, `tls-check.sh` | uptime-hartslag (alleen containers van de workspace), TLS-controle |
| `tailscale/acl.hujson` | fragment voor de tailnet-policy: `tag:ci` alleen naar poort 22 van de server, met policytests |
| `cloud-init/render.mjs`, `scripts/hetzner-create.sh`, `scripts/verhuis-proef.sh` | **optie voor HZW-082**: eigen server (Tailscale, ufw alleen 443, daarna `server-setup.sh`), proefverhuizing |
| `systemd/` | timers voor back-up, hersteltest en hartslag (`hz-workspace-*`) |
| `test/` | vitest: schema's, parsers, router echt in Caddy, scripts met nep-docker, nep-server met andere projecten, back-up en verhuizing tegen Postgres |

Workflows (in `../../.github/workflows`): `workspace-deploy` (test bij merge, productie bij release),
`workspace-preview` (per PR), `workspace-infra` (statische controles, images echt bouwen, rooktest web-container),
`workspace-server-check` (wekelijks, van buiten en via het tailnet; uitkomst in een issue). De bestaande
`workspace-app` installeert nu ook `age`, `shellcheck` en `caddy` voor de infra-tests.

## Lokaal controleren

```bash
pnpm --filter @hz/infra test          # alle infra-tests (Postgres op localhost:5432 nodig, zie hieronder)
bash infra/scripts/validate.sh        # shellcheck, actionlint, caddy validate (router, site-blok, edge), compose config, timers, cloud-init
node infra/scripts/web-smoke.mjs      # web-container (Caddy + CSP) in een echte browser; vereist caddy en apps/web/dist
```

De back-up- en verhuistests maken rollen met BYPASSRLS en hebben dus een superuser nodig: `HZ_PG_ADMIN_URL`, of in CI
`postgres` met `PGPASSWORD`, of lokaal als root via `su postgres` een tijdelijke `hz_e0_admin` met een willekeurig
wachtwoord. Na de run ruimt `test/global-setup.ts` alle rollen `hz_e0_*` op, ook die beheerder. Testdatabases
beginnen met `hz_e0_`.

## Wat er in de app veranderde (klein, toevoegend)

- `packages/ops` (nieuw): foutregistratie (Sentry-envelope naar GlitchTip, zonder SDK), JSON-logs zonder
  persoonsgegevens, access-log met gemaskeerde paden, hartslag voor de worker.
- `apps/api/src/index.ts`: `installOps`, access-log rond `app.fetch`, en `HZ_API_HOST` (container: `0.0.0.0`).
- `apps/worker/src/index.ts`: `installOps` en de hartslag, onderaan.
- `eslint.config.js` en `.prettierignore`: `tools/lead/` (workflow-scripts van de lead) overgeslagen.

Nieuwe omgevingsvariabelen (alle optioneel; lokaal staat alles uit, de images zetten de productiewaarden):
`HZ_API_HOST` (container `0.0.0.0`), `HZ_ERROR_DSN` (GlitchTip), `HZ_LOG_FORMAT=json`, `HZ_ENVIRONMENT`,
`HZ_RELEASE` (image-tag) en `HZ_WORKER_HEARTBEAT` (pad van het hartslagbestand).

Na het samenvoegen met E2 (eigen pg-boss-login `HZ_BOSS_DATABASE_URL`) en E1 (Google-inloggen) klopt `compose/app.yaml`
al: de worker krijgt `HZ_BOSS_DATABASE_URL` (migratierol) naast `DATABASE_URL` (app-login), en de E1-secrets staan in
`secrets/prod.keys`.
