# Jouw testronde (gebundeld)

Eén testronde aan het eind, geen losse vragen tussendoor. Het document heeft drie delen:
1. **Wat Claude via Chrome regelt.** Jij bent alleen ingelogd en zegt "ja" bij kosten of rechten.
2. **Wat alleen jij of een ander kan.** Akkoord, beheerdersrechten, een tweede paar ogen.
3. **De testronde zelf.** Acht scenario's van samen ongeveer 40 minuten. Alleen de kritieke dingen, geen instellingenschermen doorlopen.

Status per stap: ⏳ in aanbouw · ✅ klaar om te testen · ✔️ getest. De lead werkt de status bij na elke golf.

Bouwers: zet nieuwe punten in de **Bijlage** onderaan, niet in deel 1-3. De lead verdeelt ze over de delen.

## Overstappen naar je laptop en een eigen repo

Zie **`OVERDRACHT.md`**: wanneer je overstapt, welke downloads je nodig hebt, en de startopdracht voor Claude Code. Die opdracht laat de bouw doorlopen en doet deel 1 hieronder in dezelfde sessie.

---

## Deel 1 - Claude regelt dit via Chrome

### Zo start je deel 1

Deel 1 draai je lokaal in Claude Code, met Claude in Chrome en Tailscale aan, na de overstap uit `OVERDRACHT.md`. De startopdracht in stap 4 daarvan bevat deel 1 al. Daarvoor heb je klaar:
- Claude in Chrome verbonden en Tailscale aan;
- ingelogd in Chrome op: Google (robert@homezero.nl), Slack HomeZero (jij keurt als admin goed), Atlassian, GitHub, Hetzner, Tailscale en de DNS-beheerder van verveen.me;
- de map met je notities over Tailscale en de server, die je in de startopdracht invult.

Claude stopt alleen bij een betaalscherm of een toestemmingsscherm. Secrets gaan rechtstreeks naar de secret-opslag op de server, nooit in Git of in de chat. Na elke stap werkt Claude de status hieronder bij.

**Waar staat wat** (de lead werkt dit bij als golf A is samengevoegd)

| Wat | Waar in de repo | Status |
|---|---|---|
| Dit stappenplan | `workspace-app/HUMAN_INPUT.md` (na de overstap: `HUMAN_INPUT.md`) | ✅ |
| Overstap, downloads, startopdracht | `workspace-app/OVERDRACHT.md` | ✅ |
| Runbook (server, uitrol, back-up, herstel, verhuizen) | `workspace-app/infra/` (exacte bestand volgt uit E0) | ⏳ |
| Cloud-init en Tailscale-aanmelding van de server | `workspace-app/infra/` | ⏳ |
| Coolify- of Compose-config, Caddy | `workspace-app/infra/` | ⏳ |
| Slack-app-manifest | volgt uit E3 | ⏳ |
| Redirect-URL's voor Google, Slack en Atlassian | volgt uit E1 | ⏳ |
| GitHub Actions | `.github/workflows/` (hoofdmap van de repo) | ✅ CI · ⏳ uitrol |
| Lijst van secrets met naam en bron | volgt uit E0 | ⏳ |

| # | Wat Claude doet | Jij doet | Stories | Status |
|---|---|---|---|---|
| C0 | **Eerst kijken, niets wijzigen.** Je notities op je laptop over Tailscale en de Hetzner-server lezen. Via Tailscale op de server kijken wat er draait: reverse proxy, poorten, Docker-netwerken, mappen, vrij geheugen en schijf. Daarna een kort plan: waar de workspace naast je andere projecten komt en wat er niet mag botsen. | Akkoord op dat plan (één zin) | HZW-002 | ⏳ |
| C1 | **Server klaarmaken.** Op je bestaande server: eigen gebruiker en map, eigen compose-project, netwerk, Postgres en limieten. Aansluiten op de reverse proxy die er al draait. Eerst de voorcheck (droog), pas dan uitrollen. Je andere projecten blijven ongemoeid. Beheer alleen via Tailscale, publiek alleen 443. | Niets | HZW-002 | ⏳ |
| C2 | **Back-ups.** Aansluiten op de back-up die je server al heeft. Is die er niet, dan een Hetzner Storage Box met eigen sub-account. Daarna één keer back-up en herstel van de workspace-database draaien. | "Ja" bij de kosten, alleen als er een Storage Box bij moet | HZW-008 | ⏳ |
| C3 | **DNS.** Records voor `homezero.verveen.me` en `*.test.homezero.verveen.me` (previews) naar de server, bij de DNS-beheerder van verveen.me. Controle: beide openen met slotje. | Niets | HZW-003 | ⏳ |
| C4 | **Uitrol.** Productie en preview per PR inrichten op de manier die bij je server past: Coolify als dat er al draait, anders Compose met de proxy die er staat. Secrets zetten: `HZ_TOKEN_KEY` (Claude maakt hem aan), database-wachtwoorden en de sleutels uit C5-C9. De databaserollen `hz_app` en `hz_app_login` maakt het uitrolscript zelf. | Niets | HZW-004, 005, 006, 020 | ⏳ |
| C5 | **Google Cloud.** Project "HomeZero Workspace" aanmaken. Toestemmingsscherm op **Intern**, zodat alleen @homezero.nl erin kan. Web-client met de redirect-URL's. Agenda-, Taken- en Gmail-API aanzetten. | "Ja" op het toestemmingsscherm. Kun je geen project maken, zie D1. | HZW-010, 030, 031, 032 | ⏳ |
| C6 | **Slack.** Interne app aanmaken uit het manifest in de repo, met user-token-scopes. Installeren en als admin goedkeuren in HomeZero, met jouw account. | "Toestaan" klikken | HZW-033 | ⏳ |
| C7 | **Atlassian.** 3LO-app in de developer console, alleen leesrechten, callback-URL. | Niets | HZW-034 | ⏳ |
| C8 | **GitHub.** GitHub App voor de contextlaag (lezen) en voor de Persoonlijk-repo's (schrijven via de app). | "Install" klikken op de repo's | HZW-036, 060 | ⏳ |
| C9 | **Anthropic.** API-sleutel voor de workspace, met een maandbudget. | Het budgetbedrag noemen | HZW-050 | ⏳ |
| C10 | **Meldingen.** Uptime-melding instellen naar jou, en één testmelding sturen. | Kijken of hij binnenkomt | HZW-007 | ⏳ |
| C11 | **Controle.** GitHub Actions groen, geen secret in Git (secret scanning), release naar productie met één klik. | Niets | HZW-001, 004, 006 | ⏳ |

## Deel 2 - Alleen jij of een ander

| # | Wat | Wie | Stories | Status |
|---|---|---|---|---|
| D1 | Alleen nodig als C5 vastloopt: als Google Workspace-beheerder het interne OAuth-project toestaan (Admin console, Beveiliging, API-beheer) | Beheerder Google Workspace | HZW-010 | ⏳ |
| D2 | Een collega (niet jij) doorloopt de onboarding zonder uitleg en meldt waar hij of zij twijfelde (5 minuten) | Een collega | HZW-013 | ⏳ |
| D3 | Tweede reviewer tekent af op de beveiligingsstories (checklist in `docs/security-review.md`) | Een tweede reviewer | HZW-080, 081 en de MCP-story | ⏳ |
| D4 | Twee weken dubbel landen: de nachtroutine schrijft naast de artifact-database ook in de app. Daarna één blik op het verschilrapport. | Niemand (loopt vanzelf); jij leest het rapport | HZW-06x | ⏳ |

## Deel 3 - De testronde (ongeveer 40 minuten)

Doe dit op je laptop in Chrome, met je telefoon erbij. Werkt iets niet, schrijf dan het scenarionummer en één zin in de chat, bijvoorbeeld "T4: gelezen in de app, niet in Slack". Meer is niet nodig: Claude reproduceert het zelf.

### T1 · Inloggen (3 min) ⏳
1. Open een incognitovenster en ga naar `https://homezero.verveen.me`.
2. Klik **Inloggen met Google** en kies robert@homezero.nl. ✔ Je komt op Dagstart.
3. Nieuw incognitovenster, nu met een privé-Gmailadres. ✔ Je wordt geweigerd met een duidelijke melding.
4. Log in op je telefoon. Klik op je laptop bij je profiel op **Overal uitloggen**. ✔ De telefoon vraagt bij de volgende klik opnieuw om in te loggen.

Dekt: HZW-010, 011.

### T2 · Koppelen, alleen het nodige (4 min) ⏳
1. Bij de eerste keer inloggen zie je de koppelingen als kaarten. Koppel alleen **Google (Agenda en Taken)** en **Slack**. Twee keer "Toestaan", meer niet.
2. Gmail, Jira en GitHub sla je over. ✔ De app werkt zonder, en de kaart zegt wat je mist.
3. ✔ Binnen een minuut verschijnen je agenda, taken en Slack in Dagstart.

Dekt: HZW-012, 030, 031, 033.

### T3 · Dagstart klopt met je echte dag (5 min) ⏳
1. Leg Dagstart naast Google Agenda en de Google Taken-app.
2. ✔ Alle meetings van vandaag staan erin, ook van gedeelde privé-agenda's (Lou, vakanties), met de juiste kleur en tijd.
3. ✔ Je open taken staan erin, en de partnerkaarten tonen de stand uit de contextlaag.
4. Druk `g p` voor Planning, met de Sprint-tab. ✔ De sprint klopt met Jira. Gebruikt de context van vannacht, plus wat er vandaag veranderde.
5. Vergelijk kort met het prototype-artifact. ✔ Zo rustig of rustiger, en sneller.

Dekt: HZW-040 t/m 043, 031, 034.

### T4 · Inhalen en gelezen-status (8 min) ⏳
1. Druk `s` voor Inhalen.
2. Lees een paar berichten en druk telkens `→`. Op een bericht waar jij als laatste reageerde druk je `w`.
3. Pak je telefoon en open Slack. ✔ Die berichten zijn daar ook gelezen.
4. Druk `z` op het laatste bericht. ✔ Het is weer ongelezen, ook in Slack.
5. ✔ Het `w`-bericht staat in Tracker, Wachten op, met de juiste persoon.
6. Druk op één bericht `r` en laat Claude een antwoord maken. ✔ Er verschijnt een **concept** en er gaat niets weg. Pas na jouw klik op Versturen staat het in Slack.
7. ✔ Je hele ochtendinhaal kost minder dan 10 minuten.

Dekt: HZW-033, 045, 046, 050.

### T5 · Taak en tracker (5 min) ⏳
1. Maak in Inhalen met `1` een taak van een bericht.
2. ✔ Binnen een minuut staat hij in de Google Taken-app op je telefoon.
3. Vink hem af op je telefoon. ✔ Hij verdwijnt in de app naar Afgerond.
4. Zet in de Tracker iets op Wachten op.
5. ✔ Er staat een commit in je Persoonlijk-repo (`wachten-op.md`, juiste regelvorm). De check `contextcheck.py` draaide eerst.

Dekt: HZW-032, 044, 064.

### T6 · Zoeken en partnerpagina (4 min) ⏳
1. Druk `⌘K` en typ `Solarwatt, berekening, timeline`.
2. ✔ Je krijgt het juiste beeld uit Slack, de meetings en de contextlaag, met tijdlijn.
3. Open de partner. ✔ Stand, acties en meetings kloppen met de repo. Nergens staat iets uit `admin.md` dat naar buiten kan.

Dekt: HZW-048, 061, 062.

### T7 · Claude en skills vanuit de app (5 min) ⏳
1. Start `/klant-recap` vanuit het palet, voor een sessie van deze week.
2. ✔ Concepten voor #04-klanten en de partner staan klaar, en er is niets verstuurd. Na jouw klik komen ze aan zoals nu.
3. Vraag in Claude Code via de MCP-server van de workspace "wat staat er vandaag op mijn tracker". ✔ Het antwoord klopt en noemt de bron.

Dekt: HZW-051, 052, 053.

### T8 · Telefoon en meldingen (4 min) ⏳
1. Open de app op je iPhone in Safari, kies Deel, **Zet op beginscherm**, en sta meldingen toe.
2. Laat een collega je taggen in Slack, of laat Claude een testmelding sturen. ✔ De melding komt op tijd binnen.
3. ✔ Inhalen en Dagstart werken prettig met je duim.

Dekt: HZW-070, 071.

**Klaar.** Wat je in deze acht scenario's niet ziet, is met geautomatiseerde tests gedekt. Dat zijn bijvoorbeeld rij-beveiliging tussen collega's, ontkoppelen dat tokens intrekt, en de banner bij een gemiste nacht. De criticus heeft ze per stuk nagelopen.

---

## Bijlage - ruwe lijst per story (bouwers vullen aan)

Per rij: story, wat, hoe testen (stappen), nodig, en **via Chrome?** (ja: Claude kan het in de browser met jouw login / nee: echt mensenwerk). De lead verwerkt deze rijen in deel 1-3.

| Story | Wat | Hoe testen | Nodig | Via Chrome? |
|---|---|---|---|---|
| HZW-001 | Repo-structuur en README; Actions groen na push | Actions-tab: workflow `workspace-app` groen; README lezen | Niets | ja (C11) |
| HZW-006 | Hoofdsleutel tokenversleuteling als secret | `openssl rand -base64 32` als `HZ_TOKEN_KEY`; API weigert in productie zonder | Secret-opslag | ja (C4) |
| HZW-020 | Rollen `hz_app` en `hz_app_login` op productie-Postgres | `packages/db/sql/bootstrap-roles.sql` in het uitrolscript; controle `rolsuper, rolbypassrls = f, f` | Uitrolscript (E0) | ja (C4, automatisch) |
| HZW-040/041 | Schil en Dagstart naast de lat | `pnpm bar`/`pnpm shot` met `--modes demo,context`, `node tools/compare.mjs --blind` | Export contextlaag (runtime) | n.v.t. (T3) |
| HZW-002 (E0) | Workspace op de **bestaande** server (in het tailnet, naast de andere projecten). Vervangt "Server CX32 aanmaken": de oude C1 (nieuwe CX32, Hetzner-kosten) vervalt; dit is de nieuwe C1 uit deel 1. Geen Hetzner-account of kosten nodig. | `infra/RUNBOOK.md` §2, stap 1-4, via Tailscale vanaf de laptop. 1. **Voorcheck droog**: `scp -r workspace-app/infra <jij>@<server>:/tmp/hz-workspace-setup`, dan `ssh <jij>@<server> sudo env HZ_DOMAIN=homezero.verveen.me HZ_TEST_DOMAIN=test.homezero.verveen.me HZ_PROXY_KIND=<caddy\|traefik> HZ_PROXY_NETWORK=<netwerk van de proxy> HZ_PROXY_CONFIG=<config van de proxy> bash /tmp/hz-workspace-setup/scripts/server-check.sh`. Verwacht: niets rood; de regel `voorcheck proxy` noemt de proxy en zijn netwerk (Caddy op de host: `HZ_ROUTER_PORT=18780` in plaats van een netwerk). Er verandert niets. 2. **CI-sleutels, één per doel**: `for r in test prod preview; do ssh-keygen -t ed25519 -N '' -C hz-workspace-ci-$r -f hz_ci_$r; done`. 3. **Aparte gebruikers en map**: `server-setup.sh` met dezelfde waarden en `--deploy-key-test hz_ci_test.pub --deploy-key-prod hz_ci_prod.pub --preview-key hz_ci_preview.pub --dry-run`, dan zonder `--dry-run`. Verwacht: gebruikers `hz-workspace` en `hz-preview` (die laatste niet in de groep `hz-workspace`), `/srv/hz-workspace`, in `/srv/hz-workspace/.ssh/authorized_keys` twee regels (`hz-ssh-dispatch test` en `prod`) en in `/srv/hz-workspace/previews/.ssh/authorized_keys` één (`hz-ssh-dispatch preview`), units `hz-workspace-*`, netwerk `hz-workspace-net`; de andere projecten, sshd, ufw en de proxy ongemoeid. Controle: `sudo -u hz-preview cat /srv/hz-workspace/etc/age.key` geeft "Permission denied". 4. `sudo cat /srv/hz-workspace/log/sleutels.txt`: age-regel in `infra/secrets/recipients.txt`, `secrets.sh rekey prod`, `test`, `server`; PR, merge. Verwacht (goedkeuring HZW-002): de workspace draait naast de andere projecten, die ongemoeid blijven; de servercontrole (Actions, `workspace-server-check`) is groen: SSH alleen via het tailnet met sleutel, publiek alleen 443, updates aan, voorcheck groen. | Tailscale aan op de laptop, sudo op de server; Robert zegt "akkoord" op de uitkomst van de voorcheck (C0) | ja (C0, C1; Claude via Tailscale) |
| HZW-002/003 (E0) | Site-blok aan de reverse proxy die al draait | `infra/RUNBOOK.md` §2, stap 9, na de eerste uitrol naar test. **Caddy**: in de Caddyfile van de proxy `import /srv/hz-workspace/proxy/hz-workspace.caddy` (onderaan) en `import /srv/hz-workspace/proxy/hz-workspace.global.caddy` (in het globale blok); in Docker de map read-only mounten (rustig moment: de container van de proxy wordt opnieuw gemaakt). `caddy validate`, `caddy reload`. **Traefik/Coolify**: niets aan Traefik; entrypoint en resolver in `hz.env`. Verwacht: `voorcheck aangesloten` OK; `tls-check.sh homezero.verveen.me test.homezero.verveen.me` groen; de sites van de andere projecten werken nog (één keer openen). | Toegang tot de config van de proxy | ja (C1, C4) |
| HZW-003 (E0) | DNS naar de server (zelfde publieke adres als de andere projecten); TLS doet de bestaande proxy | 1. A en AAAA voor `homezero.verveen.me`, `test.homezero.verveen.me`, `*.test.homezero.verveen.me`, `fouten.homezero.verveen.me`. 2. Na het site-blok: `infra/scripts/tls-check.sh homezero.verveen.me test.homezero.verveen.me`: slotje, HSTS; http stuurt door of poort 80 is dicht. Verwacht: beide adressen openen met slotje (goedkeuring HZW-003). | DNS-beheer van verveen.me | ja (C3) |
| HZW-004 (E0) | Tailscale-ACL en OAuth-client voor CI; GitHub klaarzetten voor uitrol (nooit publieke SSH) | 1. Tailscale admin, Access controls: fragment uit `infra/tailscale/acl.hujson` samenvoegen (host `hz-server` = tailnet-adres van de server); staat er nog `src: ["*"]`, vervang door `autogroup:member`. Opslaan: Tailscale draait de `tests` mee (verwacht: geaccepteerd). 2. Settings, OAuth clients: scope Auth Keys (write), tag `tag:ci`. 3. GitHub, Settings (`infra/RUNBOOK.md` §2 stap 6). Repo-niveau alleen: Variables `HZ_DEPLOY_HOST=<tailnet-naam>`, `HZ_DOMAIN`, `HZ_TEST_DOMAIN` en Secret `HZ_DEPLOY_KNOWN_HOSTS` (= `ssh-keyscan -t ed25519 <server>` vanaf een tailnet-apparaat). Environment `production`: required reviewer Robert, deployment branches en tags `main` en `v*`, secrets `HZ_DEPLOY_SSH_KEY_PROD` (privé uit `hz_ci_prod`), `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`. Environment `test`: deployment branch alleen `main`, secrets `HZ_DEPLOY_SSH_KEY_TEST` (privé uit `hz_ci_test`), `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`. Environment `preview`: secrets `HZ_PREVIEW_SSH_KEY` (privé uit `hz_ci_preview`), `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET`. Nooit een SSH-sleutel of `TS_OAUTH_*` als repo-secret (die kan elke PR-workflow lezen); het tabblad Repository secrets toont alleen `HZ_DEPLOY_KNOWN_HOSTS`. Daarna de privésleutels van de laptop weg. 4. Na de eerste build: packages `hz-api`, `hz-worker`, `hz-web`, Manage Actions access, deze repo, Read. 5. Merge naar main: `workspace-deploy` groen tot en met health-check van test; in de log "Tailscale" vóór "Uitrol op de server via het tailnet". 6. Release `v0.1.0` op een commit die al op test stond, Review deployments, Approve: productie groen. 7. Weigertest (optioneel, 2 min): Actions, `workspace-deploy`, Run workflow, omgeving `production`, tag `v9.9.9` (bestaat niet): de job stopt met "stond hier nog nooit". Verwacht: release met één klik (goedkeuring HZW-004); productie draait alleen wat op test groen was; in Tailscale verschijnt per run een tijdelijke `tag:ci`-node die daarna weg is. | Tailscale-admin, GitHub-beheerder van de repo | ja (C11) |
| HZW-005 (E0) | Previewwachtwoord | 1. `docker run --rm caddy:2.10.2-alpine caddy hash-password` (wachtwoord in de teamkluis, "Workspace preview"). 2. `printf '%s\n' hz \| infra/scripts/secrets.sh set server HZ_PREVIEW_USER` en de hash als `HZ_PREVIEW_HASH`. 3. PR openen: commentaar met `https://pr-<nr>.test…`, opent met wachtwoord. 4. PR sluiten: de link geeft geen site meer. Verwacht: reviewer kan een story op de preview bekijken (goedkeuring HZW-005; past in de testronde als reviewer-stap, geen eigen scenario). Bij Traefik: previews pas met een resolver met DNS-challenge. | Teamkluis | ja (C4) |
| HZW-006 (E0) | Secrets met age in plaats van de secret-opslag van Coolify | 1. Robert en Rens: `infra/scripts/secrets.sh keygen ~/.config/hz/age.key`, publieke sleutel in `infra/secrets/recipients.txt`. 2. `secrets.sh gen prod`, `gen test`, `gen server` (databasewachtwoorden, `HZ_TOKEN_KEY`, `HZ_AUTH_SECRET`, GlitchTip). 3. Waarden van mensen (Google, Slack, ... uit C5-C10) met `printf '%s\n' '<waarde>' \| secrets.sh set prod <SLEUTEL>`. 4. `secrets.sh check prod` en `check test` groen. Verwacht: geen secret leesbaar in Git (`infra/test/config.test.ts` en GitHub secret scanning), uitrol weigert bij een ontbrekende sleutel. Vervangt in C4 "Secrets zetten in Coolify". | age op de laptop (`apt install age` of `brew install age`) | ja (C4) |
| HZW-007 (E0) | Uptime-melding en foutregistratie naar Robert | 1. healthchecks.io (of compatibel): checks `workspace` (5 min, grace 10 min), `back-up` (1 dag, grace 2 uur), `hersteltest` (31 dagen); melding per mail of Slack-DM naar Robert. 2. Ping-URL's: `secrets.sh set server HZ_HEARTBEAT_PING_URL`, `HZ_BACKUP_PING_URL`, `HZ_RESTORE_PING_URL`. 3. GlitchTip: `docker exec -it hz-workspace-ops-glitchtip-1 ./manage.py createsuperuser`, project `workspace`, DSN als `HZ_ERROR_DSN` in prod en test, alert naar Robert; optioneel SMTP als `HZ_GLITCHTIP_EMAIL_URL`. 4. Test: `docker exec hz-workspace-prod-api-1 node dist/ops-cli.js test-error` en in healthchecks "Send test notification". Verwacht: beide meldingen komen bij Robert binnen (goedkeuring HZW-007; hoort bij T8). | Account bij de uptime-dienst; SMTP optioneel | ja (C10) |
| HZW-008 (E0) | Back-updoel: de back-up die de server al heeft, of een Storage Box | 1. Heeft de server al een back-up van een map: `HZ_BACKUP_TARGET=<die map>/hz-workspace` (bestanden zijn al versleuteld). Anders: Storage Box BX11, sub-account met map `hz-workspace`, SSH aan, publieke sleutel "Storage Box" uit `sleutels.txt` erbij, `HZ_BACKUP_TARGET=sftp://<sub>@<box>.your-storagebox.de:23/hz-workspace`. 2. `printf '%s\n' '<doel>' \| secrets.sh set server HZ_BACKUP_TARGET`, PR, merge, uitrol. 3. Op de server `sudo -u hz-workspace /srv/hz-workspace/bin/hz-run backup.sh --label handmatig` en daarna `... hersteltest.sh`: "hersteltest groen". Verwacht: herstelprocedure staat in `infra/RUNBOOK.md` §6 en is één keer gedaan (goedkeuring HZW-008). | Alleen bij een Storage Box: "ja" bij de kosten | ja (C2) |
| HZW-082 (E0) | Proefverhuizing naar een eigen server (optie; cloud-init is hiervoor, niet voor de hoofdroute) | Lokaal al groen (`infra/test/image.test.ts`: back-up, nieuwe database met rollen, herstel met rechten, zelfde rijen, API groen op een ander domein). Echt: `infra/RUNBOOK.md` §10: eenmalige getagde Tailscale-auth-key in een bestand, `render.mjs ... --tailscale-authkey-file ts.key`, `hetzner-create.sh --dry-run` en dan echt (CX32 één dag), tijdelijk domein (bv. `proef.homezero.nl`), herstel uit de back-up, `tls-check.sh` groen, daarna server weg. Verwacht: draait op het nieuwe adres zonder codewijziging (goedkeuring HZW-082). | Hetzner (één dag CX32), een DNS-record, Tailscale-auth-key | ja |
| Keuze 01 / H4 (E0) | Compose + router achter de bestaande proxy, geen Coolify erbij (motivatie: `infra/README.md`). Draait er al Coolify, dan gebruikt de router de Traefik van Coolify via labels. | Lead: C4 in deel 1 aanpassen (geen Coolify-UI: uitrol via GitHub Actions en Tailscale, secrets via `secrets.sh`). Robert of de developer bevestigt H4. | Akkoord Robert | nee |
