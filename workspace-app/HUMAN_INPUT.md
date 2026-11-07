# Jouw testronde (gebundeld)

Eén testronde aan het eind, geen losse vragen tussendoor. Het document heeft drie delen:
1. **Wat Claude via Chrome regelt.** Jij bent alleen ingelogd en zegt "ja" bij kosten of rechten.
2. **Wat alleen jij of een ander kan.** Akkoord, beheerdersrechten, een tweede paar ogen.
3. **De testronde zelf.** Acht scenario's van samen ongeveer 40 minuten. Alleen de kritieke dingen, geen instellingenschermen doorlopen.

Status per stap: ⏳ in aanbouw · ✅ klaar om te testen · ✔️ getest. De lead werkt de status bij na elke golf.

Bouwers: zet nieuwe punten in de **Bijlage** onderaan, niet in deel 1-3. De lead verdeelt ze over de delen.

---

## Deel 1 - Claude regelt dit via Chrome

**Voorbereiding (eenmalig, 2 minuten).** Open een sessie in de Claude-desktopapp met Claude in Chrome aan, en wees in Chrome ingelogd op:
- Google met robert@homezero.nl
- Slack HomeZero
- Atlassian
- GitHub
- Hetzner
- de DNS-beheerder van homezero.nl

Zeg dan: "voer deel 1 van HUMAN_INPUT.md uit".

Claude stopt alleen bij een betaalscherm of een toestemmingsscherm en vraagt dan in één zin of het door mag. Secrets gaan direct van het ene scherm naar de secret-opslag op de server. Ze komen nooit in Git of in de chat.

| # | Wat Claude doet | Jij doet | Stories | Status |
|---|---|---|---|---|
| C1 | **Server.** Hetzner Cloud: server CX32 aanmaken met de cloud-init uit `infra/`, firewall, SSH-sleutel. Wachtwoordlogin uit. | "Ja" bij de kosten die Hetzner toont | HZW-002 | ⏳ |
| C2 | **Back-ups.** Hetzner Storage Box bestellen, sub-account voor back-ups, sleutel in de secret-opslag. Daarna één keer back-up en herstel draaien. | "Ja" bij de kosten | HZW-008 | ⏳ |
| C3 | **DNS.** Records voor `workspace.homezero.nl` en `preview.workspace.homezero.nl` naar de server. Controle: beide openen met slotje. | Niets | HZW-003 | ⏳ |
| C4 | **Coolify.** Openen en koppelen aan de GitHub-repo, met productie en preview per PR. Secrets zetten: `HZ_TOKEN_KEY` (Claude maakt hem aan), database-wachtwoorden en de sleutels uit C5-C9. De databaserollen `hz_app` en `hz_app_login` maakt het uitrolscript zelf. | Niets | HZW-004, 005, 006, 020 | ⏳ |
| C5 | **Google Cloud.** Project "HomeZero Workspace" aanmaken. Toestemmingsscherm op **Intern**, zodat alleen @homezero.nl erin kan. Web-client met de redirect-URL's. Agenda-, Taken- en Gmail-API aanzetten. | "Ja" op het toestemmingsscherm. Kun je geen project maken, zie D1. | HZW-010, 030, 031, 032 | ⏳ |
| C6 | **Slack.** Interne app aanmaken uit het manifest in de repo, met user-token-scopes. Installeren in HomeZero. | "Toestaan" klikken. Zijn apps afgeschermd, zie D2. | HZW-033 | ⏳ |
| C7 | **Atlassian.** 3LO-app in de developer console, alleen leesrechten, callback-URL. | Niets | HZW-034 | ⏳ |
| C8 | **GitHub.** GitHub App voor de contextlaag (lezen) en voor de Persoonlijk-repo's (schrijven via de app). | "Install" klikken op de repo's | HZW-036, 060 | ⏳ |
| C9 | **Anthropic.** API-sleutel voor de workspace, met een maandbudget. | Het budgetbedrag noemen | HZW-050 | ⏳ |
| C10 | **Meldingen.** Uptime-melding instellen naar jou, en één testmelding sturen. | Kijken of hij binnenkomt | HZW-007 | ⏳ |
| C11 | **Controle.** GitHub Actions groen, geen secret in Git (secret scanning), release naar productie met één klik. | Niets | HZW-001, 004, 006 | ⏳ |

## Deel 2 - Alleen jij of een ander

| # | Wat | Wie | Stories | Status |
|---|---|---|---|---|
| D1 | Alleen nodig als C5 vastloopt: als Google Workspace-beheerder het interne OAuth-project toestaan (Admin console, Beveiliging, API-beheer) | Beheerder Google Workspace | HZW-010 | ⏳ |
| D2 | Alleen nodig als C6 vastloopt: de Slack-app goedkeuren | Slack-beheerder | HZW-033 | ⏳ |
| D3 | Een collega (niet jij) doorloopt de onboarding zonder uitleg en meldt waar hij of zij twijfelde (5 minuten) | Een collega | HZW-013 | ⏳ |
| D4 | Tweede reviewer tekent af op de beveiligingsstories (checklist in `docs/security-review.md`) | Een tweede reviewer | HZW-080, 081 en de MCP-story | ⏳ |
| D5 | Akkoord vanuit legal op de privacytekst | Rens of Mike | HZW-081 | ⏳ |
| D6 | Twee weken dubbel landen: de nachtroutine schrijft naast de artifact-database ook in de app. Daarna één blik op het verschilrapport. | Niemand (loopt vanzelf); jij leest het rapport | HZW-06x | ⏳ |

## Deel 3 - De testronde (ongeveer 40 minuten)

Doe dit op je laptop in Chrome, met je telefoon erbij. Werkt iets niet, schrijf dan het scenarionummer en één zin in de chat, bijvoorbeeld "T4: gelezen in de app, niet in Slack". Meer is niet nodig: Claude reproduceert het zelf.

### T1 · Inloggen (3 min) ⏳
1. Open een incognitovenster en ga naar `https://workspace.homezero.nl`.
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
| HZW-002 (E0) | Server CX32 met cloud-init uit `infra/` (gebruikers, SSH alleen sleutel, ufw 22/80/443, automatische updates, Docker, timers) | 1. CI-sleutel maken: `ssh-keygen -t ed25519 -N '' -f hz_deploy` (privé naar GitHub-secret `HZ_DEPLOY_SSH_KEY`). 2. `node infra/cloud-init/render.mjs --domain homezero.verveen.me --acme-email robert@homezero.nl --registry ghcr.io/homezerotech --admin-keys ~/.ssh/id_ed25519.pub --deploy-key hz_deploy.pub --out user-data.yaml`. 3. `HCLOUD_TOKEN=… infra/scripts/hetzner-create.sh --user-data user-data.yaml --ssh-key ~/.ssh/id_ed25519.pub --dry-run`, dan zonder `--dry-run`. 4. Actions, `workspace-server-check`, Run: issue `servercontrole` alles groen. 5. `ssh -o PreferredAuthentications=password hz@<IP>` wordt geweigerd. Verwacht: server staat, wachtwoordlogin uit (goedkeuring HZW-002). | Hetzner-project met API-token (lezen/schrijven), "ja" bij de kosten | ja (C1) |
| HZW-002 (E0) | Sleutels van de nieuwe server in de repo | 1. `ssh hz@<IP> sudo cat /var/log/hz/sleutels.txt`. 2. age-regel in `infra/secrets/recipients.txt`; `infra/scripts/secrets.sh rekey prod`, idem `test` en `server`; PR, merge. Verwacht: `secrets.sh check prod` groen op de laptop, uitrol kan ontsleutelen. | Beheerderssleutel (rij HZW-006 hieronder) | ja |
| HZW-003 (E0) | DNS naar de server; TLS doet Caddy zelf | 1. A en AAAA voor `homezero.verveen.me`, `test.homezero.verveen.me`, `*.test.homezero.verveen.me`, `fouten.homezero.verveen.me` naar het IP. 2. `infra/scripts/tls-check.sh homezero.verveen.me test.homezero.verveen.me`: alles OK (http stuurt door, slotje, HSTS). Let op: deel 1 (C3) noemt `workspace.homezero.nl`; de stories en de plaat `homezero.verveen.me`. Het domein is één waarde in de cloud-init (`--domain`), kies er één. | DNS-beheer van het gekozen domein | ja (C3) |
| HZW-004 (E0) | GitHub klaarzetten voor uitrol | 1. Settings, Environments: `test`, `preview`, `production` (production: required reviewer Robert). 2. Variables: `HZ_DEPLOY_HOST=<IP>`, `HZ_DOMAIN`, `HZ_TEST_DOMAIN`. 3. Secrets: `HZ_DEPLOY_SSH_KEY`, `HZ_DEPLOY_KNOWN_HOSTS` (= `ssh-keyscan -t ed25519 <IP>`). 4. Na de eerste build: packages `hz-api`, `hz-worker`, `hz-web`, Manage Actions access, deze repo, Read. 5. Merge naar main: `workspace-deploy` groen tot en met health-check van test. 6. Release `v0.1.0` publiceren, Review deployments, Approve: productie groen. Verwacht: release met één klik (goedkeuring HZW-004). | GitHub-beheerder van de repo | ja (C11) |
| HZW-005 (E0) | Previewwachtwoord | 1. `docker run --rm caddy:2.10.2-alpine caddy hash-password` (wachtwoord in de teamkluis, "Workspace preview"). 2. `printf '%s\n' hz \| infra/scripts/secrets.sh set server HZ_PREVIEW_USER` en de hash als `HZ_PREVIEW_HASH`. 3. PR openen: commentaar met `https://pr-<nr>.test…`, opent met wachtwoord. 4. PR sluiten: de link geeft geen site meer. Verwacht: reviewer kan een story op de preview bekijken (goedkeuring HZW-005; past in de testronde als reviewer-stap, geen eigen scenario). | Teamkluis | ja (C4) |
| HZW-006 (E0) | Secrets met age in plaats van de secret-opslag van Coolify | 1. Robert en Rens: `infra/scripts/secrets.sh keygen ~/.config/hz/age.key`, publieke sleutel in `infra/secrets/recipients.txt`. 2. `secrets.sh gen prod`, `gen test`, `gen server` (databasewachtwoorden, `HZ_TOKEN_KEY`, `HZ_AUTH_SECRET`, GlitchTip). 3. Waarden van mensen (Google, Slack, ... uit C5-C10) met `printf '%s\n' '<waarde>' \| secrets.sh set prod <SLEUTEL>`. 4. `secrets.sh check prod` en `check test` groen. Verwacht: geen secret leesbaar in Git (`infra/test/config.test.ts` en GitHub secret scanning), uitrol weigert bij een ontbrekende sleutel. Vervangt in C4 "Secrets zetten in Coolify". | age op de laptop (`apt install age` of `brew install age`) | ja (C4) |
| HZW-007 (E0) | Uptime-melding en foutregistratie naar Robert | 1. healthchecks.io (of compatibel): checks `workspace` (5 min, grace 10 min), `back-up` (1 dag, grace 2 uur), `hersteltest` (31 dagen); melding per mail of Slack-DM naar Robert. 2. Ping-URL's: `secrets.sh set server HZ_HEARTBEAT_PING_URL`, `HZ_BACKUP_PING_URL`, `HZ_RESTORE_PING_URL`. 3. GlitchTip: `docker exec -it hz-ops-glitchtip-1 ./manage.py createsuperuser`, project `workspace`, DSN als `HZ_ERROR_DSN` in prod en test, alert naar Robert; optioneel SMTP als `HZ_GLITCHTIP_EMAIL_URL`. 4. Test: `docker exec hz-prod-api-1 node dist/ops-cli.js test-error` en in healthchecks "Send test notification". Verwacht: beide meldingen komen bij Robert binnen (goedkeuring HZW-007; hoort bij T8). | Account bij de uptime-dienst; SMTP optioneel | ja (C10) |
| HZW-008 (E0) | Storage Box voor de back-ups | 1. Storage Box BX11 bestellen, sub-account met map `hz`, SSH aan. 2. Publieke sleutel "Storage Box" uit `sleutels.txt` bij het sub-account. 3. `printf '%s\n' 'sftp://<sub>@<box>.your-storagebox.de:23/hz' \| secrets.sh set server HZ_BACKUP_TARGET`, PR, merge, uitrol. 4. `ssh hz@<IP> sudo -u deploy /opt/hz/bin/hz-run backup.sh --label handmatig` en daarna `... hersteltest.sh`: "hersteltest groen". Verwacht: herstelprocedure staat in `infra/RUNBOOK.md` §6 en is één keer gedaan (goedkeuring HZW-008). | Hetzner, "ja" bij de kosten | ja (C2) |
| HZW-082 (E0) | Proefverhuizing op een echte tweede server | Lokaal al groen (`infra/test/image.test.ts`: back-up, nieuwe database met rollen, herstel met rechten, zelfde rijen, API groen op een ander domein). Echt: `infra/RUNBOOK.md` §10 met een tweede CX32 en een tijdelijk domein (bv. `proef.homezero.nl`), `tls-check.sh` groen, daarna server weg. Verwacht: draait op het nieuwe adres zonder codewijziging (goedkeuring HZW-082). | Hetzner (één dag CX32), een DNS-record | ja |
| Keuze 01 / H4 (E0) | Compose + Caddy gekozen in plaats van Coolify (motivatie: `infra/README.md`) | Lead: C4 in deel 1 aanpassen (geen Coolify-UI: uitrol via GitHub Actions, secrets via `secrets.sh`). Robert of de developer bevestigt H4. | Akkoord Robert | nee |
