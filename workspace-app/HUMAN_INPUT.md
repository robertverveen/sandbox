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
