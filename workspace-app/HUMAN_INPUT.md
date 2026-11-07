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
| HZW-020 | Rollen en logins op de productie-Postgres: runtime-rol `hz_app`, indexer-rol `hz_indexer`, worker-rol `hz_worker`, auth-rol `hz_auth`, de app-login, de auth-login, de indexer-login, de worker-login en de pg-boss-login | 1. Als beheerder `psql -v migrator=<migratierol> -f packages/db/sql/bootstrap-roles.sql` (maakt `hz_app`, `hz_indexer`, `hz_worker`, `hz_auth`; opnieuw draaien mag, ook op een server waar het al eens draaide). Verwacht: geen fout; `select rolname from pg_roles where rolname like 'hz\_%'` toont de vier rollen.<br>1b. `psql -v login=hz_auth_login -v password="$(openssl rand -base64 24)" -f packages/db/sql/auth-login.sql` (HZ_AUTH_DATABASE_URL van de api en van het importscript). Verwacht: geen fout.<br>2. `psql -v login=hz_app_login -v password="$(openssl rand -base64 24)" -f packages/db/sql/app-login.sql` (DATABASE_URL van de api). Verwacht: geen fout.<br>3. `psql -v login=hz_worker_login -v password="$(openssl rand -base64 24)" -f packages/db/sql/worker-login.sql` (DATABASE_URL van de worker). Verwacht: geen fout.<br>4. `psql -v login=hz_indexer_login -v password="$(openssl rand -base64 24)" -f packages/db/sql/indexer-login.sql` (HZ_INDEX_DATABASE_URL van de indexjob en het importscript). Verwacht: geen fout.<br>5. `psql -d <database> -v login=hz_boss -v password="$(openssl rand -base64 24)" -v schema=pgboss -f packages/db/sql/boss-login.sql` (HZ_BOSS_DATABASE_URL van de worker). Verwacht: geen fout. Elk script weigert als de login ergens anders lid of eigenaar van is.<br>6. `pnpm db:migrate` met de migratierol. Verwacht: migraties 0010 t/m 0013 draaien (zonder stap 1 stopt 0010 met "rol hz_worker ontbreekt", 0011 met "rol hz_auth ontbreekt"). 0013 vraagt dat de migratierol eigenaar is van de database; zo niet, dan stopt hij met de melding "PUBLIC mag nog tijdelijke tabellen maken": draai dan als beheerder `REVOKE TEMPORARY ON DATABASE <database> FROM PUBLIC;` en migreer opnieuw.<br>6b. TEMP-controle: stap 1b t/m 4 nog eens, nu met `-d <database> -v db=<database>` erbij. Verwacht per script de melding "TEMP-controle: login … mag geen tijdelijke tabellen maken". Tegenproef als `hz_app_login`: `create temp table weekdoelen (id int);` geeft `permission denied to create temporary tables`.<br>7. api (met `DATABASE_URL`=app-login en `HZ_AUTH_DATABASE_URL`=auth-login) en worker starten met `NODE_ENV=production`. Verwacht: geen `UnsafeAppLoginError` of `UnsafeBossLoginError`; zonder `HZ_AUTH_DATABASE_URL` weigert de api te starten. Tegenproef: de api met de worker-login als DATABASE_URL faalt met "lid van hz_worker"; de worker met de migratierol als HZ_BOSS_DATABASE_URL weigert te starten.<br>8. Als `hz_app_login`: `begin; set local role hz_app; select * from system_active_user_ids();`. Verwacht: `permission denied`. Daarna (nieuwe transactie) `select * from auth_user_by_email('robert@homezero.nl');`. Verwacht: `permission denied for function`. Daarna `select set_config('app.user_id', '<id van Robert, opgezocht als migratierol>', true); select count(*) from tracker_items;`. Verwacht: 0.<br>9. Eenmalig de eerste admin: `psql "<migratie-url>" -v email=robert@homezero.nl -v role=admin -f packages/db/sql/set-role.sql`. Verwacht: één regel bijgewerkt.<br>Lokaal en in CI is dit al gedaan (testwachtwoorden `hz_app_login`, `hz_auth_login`, `hz_worker_login`, `hz_indexer_login`, `hz_boss_test`, alleen voor tests); `pnpm --filter @hz/db test` en `pnpm --filter @hz/worker test` zijn groen | Een databasebeheerder (superuser of CREATEROLE) op de productie-Postgres; de vier wachtwoorden in de secret-opslag | ja (C4, uitrolscript) |
| HZW-020 | Goedkeuring: datamodel-schets klopt met het prototype | README, "Database en rij-beveiliging" en "Import uit het prototype": tabel per collectie van het prototype (commitments, itemstate, briefings, processed, weekdoelen, contextcollecties) en waar die heen gaat; `packages/db/src/schema.ts` | Robert (en de developer) leest het na; 15 minuten | nee (Robert leest, 15 min) |
| HZW-020 | Goedkeuring auth-functies samen met het auth-stuk (E1) | README, "Inloggen en de auth-bibliotheek": de adapter van Better Auth/Auth.js roept `auth_*`-functies aan, geen SELECT op users/sessions. **Sinds 0011:** die functies zijn alleen van `hz_auth`; de adapter krijgt de verbinding van `createAuthDb()` (`HZ_AUTH_DATABASE_URL`, `hz_auth_login`), nooit die van de requests. De sessie-middleware van E1 draait de rest van de request in `runWithSession(hashToken(token), …)` (in de api `store.asSession(token, next)`), anders ziet de api-login niemand: `app.user_id` alleen telt niet meer voor de api-login. Let op voor E1: `auth_upsert_user(email, naam)` heeft geen rol meer (altijd `member`, alleen domeinen uit `auth_domains`); `upsertUser(db, email, naam)` idem; admin via `sql/set-role.sql`. Sessies duren hoogstens 30 dagen (`auth_create_session`/`auth_touch_session` kappen op now() + 30 dagen; Better Auth `session.expiresIn` dus niet hoger). **Sinds 0013:** een ingetrokken sessie wordt nooit weer geldig (trigger `sessions_guard`, ook niet via de adapter); de app zelf mag een sessie niet meer wijzigen, alleen een eigen sessie intrekken via `auth_revoke_own_session(id)` (`revokeOwnSession`, voor "andere apparaten uitloggen"). `system_active_user_ids()` is alleen voor de worker (`hz_worker`). `pnpm --filter @hz/db test` (auth.test.ts) | Afstemming met de bouwer van E1 bij het samenvoegen | nee (lead bij samenvoegen) |
| HZW-021 | Export maken van de artifact-opslag van het prototype, met minstens één toezegging die aan een Google Taak gekoppeld is | 1. Open het prototype-artifact van Robert in claude.ai (live, met connectors). Kies in de Tracker bij Ik beloofde een open toezegging zonder Google Taak en plan hem met 2 (morgen). Verwacht: toast over Google Taken; de toezegging verdwijnt uit Ik beloofde en staat als taak in Planning.<br>2. Zet bij een andere toezegging (of een voornemen) de knop "In Google Taken". Verwacht: toast "In Google Taken gezet".<br>3. Laat in Claude (artifact-tools) alle documenten van de collecties `commitments`, `itemstate` en `briefings` (en `processed`/`weekdoelen` als die bestaan; de contextcollecties mogen mee) lezen en wegschrijven als `{"collections": {…}}` naar een map buiten de repo (vorm: README, "Import uit het prototype"). Verwacht: één JSON-bestand; nooit in Git.<br>4. Zoek in het bestand de twee toezeggingen uit stap 1 en 2. Verwacht: bij de eerste `"gtask": {"id": "…", "tasklist": "…"}`, bij de tweede `"gtask": "gtask:…"`. Noteer hun doc-id's en de taak-id's.<br>5. Zoek een itemstate met `handledBy` (een Slack-bericht waar een collega al op reageerde). Verwacht: minstens één, als Robert zulke berichten had; noteer de sleutel | Toegang tot het prototype-artifact van Robert, met Google Taken gekoppeld | ja (Claude in claude.ai) |
| HZW-021 | Import draaien voor Robert en zijn tracker terugzien (goedkeuring) | 1. `DATABASE_URL=<worker-login-url> HZ_AUTH_DATABASE_URL=<auth-login-url> HZ_INDEX_DATABASE_URL=<indexer-login-url> pnpm --filter @hz/db import:prototype -- --export <pad> --email robert@homezero.nl --proef` (`<pad>` absoluut, of relatief aan de map waar je het commando typt). Verwacht: "proefdraai, niets opgeslagen", per collectie docs = gebruikt + overgeslagen, onderaan "Aantallen kloppen", exitcode 0. Bestond Robert nog niet: een waarschuwing dat zijn tabellen berekend zijn, en `select count(*) from users` (als migratierol) is na de proefdraai gelijk. Tegenproef: met `DATABASE_URL=<app-login-url>` stopt het script met exitcode 2 ("hz_worker"). Lees de waarschuwingen: elke regel "past niet in zijn kolom, bewaard in extra" noemt een veld dat niet in zijn kolom paste (niets is weg).<br>2. Zelfde opdracht zonder `--proef`. Verwacht: "Aantallen kloppen"; de kolom nieuw gelijk aan verwacht.<br>3. Nog een keer. Verwacht: overal 0 nieuw en 0 bijgewerkt.<br>4. `HZ_STORE=db DATABASE_URL=<app-login-url> HZ_AUTH_DATABASE_URL=<auth-login-url> pnpm dev`, inloggen als Robert, `GET /api/items`. Verwacht: de twee toezeggingen uit de export-stap 1 en 2 staan er **niet** als `cm:<doc-id>`; de Google Taak zelf staat er één keer (als taak, zodra Google Taken live gekoppeld is). Zoek op de taaktitel: precies één item.<br>5. In de database (als migratierol): `select legacy_id, gtask, extra->'gtask' from tracker_items where legacy_id in ('<doc-id 1>', '<doc-id 2>')`. Verwacht: `gtask` = de taak-id's uit export-stap 4; bij de eerste `{"tasklist": "…"}` in extra.<br>6. `select item_key, answered_by from item_state where item_key = '<sleutel uit export-stap 5>'`. Verwacht: answered_by = de naam uit `handledBy`.<br>7. In Dagstart: de briefing van de laatste dag en de weekdoelen. Verwacht: zelfde titels als in het prototype. `GET /api/tracker`: weekdoelen met gezondheid en laatste check; `GET /api/pins`: de vastgezette zoekopdrachten.<br>8. Pas in de app een weekdoel aan (PATCH /api/weekdoelen/:id) en importeer opnieuw met dezelfde of een nieuwere export. Verwacht: kolom "in app gewijzigd" telt 1, het weekdoel blijft zoals in de app.<br>9. Contextindex: importeer een nieuwere export waarin een partner of meeting niet meer staat. Verwacht: regel "Contextindex opgeruimd: …" met dat pad; zoeken in de app vindt hem niet meer. Zou meer dan de helft verdwijnen, dan staat er "niet opgeruimd" en blijft de index staan.<br>Het Tracker-scherm zelf is nog een lege plek: die weergave keurt Robert goed bij de Tracker-story (HZW-044) | De export hierboven; een database met de migraties (lokaal of server) en de logins uit HZW-020 | ja (script); goedkeuring in T5 |
| HZW-040/041 | Schil en Dagstart naast de lat | `pnpm bar`/`pnpm shot` met `--modes demo,context`, `node tools/compare.mjs --blind` | Export contextlaag (runtime) | n.v.t. (T3) |
