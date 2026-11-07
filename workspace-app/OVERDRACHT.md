# Overdracht: van de cloud-sandbox naar een eigen repo, lokaal verder bouwen

Dit document regelt de overstap. Nu wordt de Workspace gebouwd in een cloudsessie, in de map `workspace-app/` van de repo `robertverveen/sandbox`. Daarna gaat het verder in een eigen GitHub-repo, vanuit een map op je laptop. Daar zijn Claude in Chrome en Tailscale beschikbaar.

## In het kort

| Vraag | Antwoord |
|---|---|
| Wanneer overstappen? | **Na golf A**, als die samengevoegd en groen is. Dan bestaan het runbook, de servervoorcheck, het inloggen en de koppelingen, en kan deel 1 (inrichten via Chrome) starten. Midden in een golf overstappen kost werk: de werkkopieën van de bouwers staan in de cloudcontainer. |
| Welke repo? | Nieuw en privé: **`robertverveen/homezero-workspace`**. Later naar de HomeZeroTech-organisatie verhuizen kan met één klik (GitHub: Settings, Transfer); de geschiedenis gaat mee. Wil je hem meteen in de organisatie of een andere naam, zeg het vóór stap 2. |
| Wie doet wat? | Stap 1-2: Claude, in de cloudsessie. Stap 3: jij, ongeveer 20 minuten, eenmalig. Stap 4-6: Claude Code (lokaal, of bouwen in de cloud en deel 1 lokaal), samen met jou. |
| Claude Code of gewone chat? | Zie de tabel hieronder. Kort: bouwen en inrichten in **Claude Code lokaal**, meekijken en beslissen mag in de gewone chat. |

### Waar doe je wat

| Wat | Waar | Waarom |
|---|---|---|
| Bouwen: de golven, builder en criticus (gauntlet loop) | **Claude Code**: lokaal (aanbevolen) of in de cloud, zie stap 4 | Heeft bestanden, terminal, Postgres, Playwright en workflows nodig; in de cloud loopt het door als je laptop dicht is |
| Deel 1: inrichten via Chrome | **Claude Code lokaal**, met Claude in Chrome aan; in optie 1 dezelfde sessie als het bouwen | Heeft je browser met jouw logins nodig, plus Tailscale-SSH en bestanden uit de repo (runbook, Slack-manifest, redirect-URL's) |
| Deel 3: jouw testronde | Jij, in de browser en op je telefoon. Bevindingen zet je in die Claude Code-sessie (één regel per scenario). | Het gaat om jouw ervaring met je echte data |
| Meekijken, keuzes maken, vragen stellen | Gewone chat of de Claude-app op je telefoon: de voortgangspagina en de architectuurplaat, met opmerkingen erop | Hiervoor is geen code nodig |
| Ochtendbriefing-routine | Blijft zoals hij is, in de cloud | Verandert pas als HZW-06x (de routine schrijft in de app) live gaat |

## Stappenplan

### Stap 1 · Golf A afmaken (Claude, cloud) ⏳
Golf A loopt: datamodel, inloggen, koppelingen, server en uitrol. Als alles gewonnen en samengevoegd is, pusht Claude naar de branch `claude/gracious-franklin-igzxj0` van de sandbox. De voortgangspagina wordt bijgewerkt.

### Stap 2 · Overzetten naar de eigen repo (Claude, cloud, ongeveer 10 minuten) ⏳
1. Claude maakt de privé-repo `robertverveen/homezero-workspace` aan via GitHub.
2. Claude draait `workspace-app/tools/lead/naar-eigen-repo.sh` (proef gedaan op 7 nov). Dat doet het volgende:
   - het haalt `workspace-app/` met zijn geschiedenis los;
   - het zet de CI in de hoofdmap;
   - het zet het prototype en de plaat in `docs/prototype/`;
   - het vervangt de cloudpaden door paden in de repo.
3. Claude pusht naar `main` en controleert dat GitHub Actions groen is.
4. In de sandbox komt een verwijzing naar de nieuwe repo. `workspace-app/` blijft daar staan als archief.
5. De voortgangspagina en de plaat houden dezelfde links.

Jij hoeft niets te doen. Kan ik de nieuwe repo niet bereiken, dan vraag ik je de vier stappen onder "De repo koppelen" in stap 4 te doen (twee minuten). Lukt aanmaken vanuit de cloud niet, dan doe je het lokaal in stap 3 met:
`gh repo create robertverveen/homezero-workspace --private` en
`git clone https://github.com/robertverveen/sandbox.git && cd sandbox && git checkout claude/gracious-franklin-igzxj0 && workspace-app/tools/lead/naar-eigen-repo.sh ../homezero-workspace https://github.com/robertverveen/homezero-workspace.git`

### Stap 3 · Downloads en klaarzetten (jij, ongeveer 20 minuten, eenmalig)
Uitgaande van een Mac. Werk je op Windows, zeg het, dan past Claude dit aan.

| Wat | Hoe | Controle |
|---|---|---|
| Claude-desktopapp met Claude Code | Downloaden via `https://claude.ai/download`, inloggen met robert@homezero.nl | Er is een tab **Code** |
| Claude in Chrome | De extensie "Claude" van Anthropic uit de Chrome Web Store, inloggen met hetzelfde account, verbinden met de desktopapp | In Claude Code werkt "open homezero.verveen.me in Chrome" |
| Homebrew | Zie `https://brew.sh` (één commando in Terminal) | `brew --version` |
| Git en GitHub CLI | `brew install git gh` en dan `gh auth login` | `gh auth status` |
| Node 22 en pnpm 10 | `brew install node@22 pnpm` | `node -v` geeft v22, `pnpm -v` geeft 10 |
| Postgres 16 | `brew install postgresql@16 && brew services start postgresql@16` | `psql postgres -c 'select version()'` |
| Python 3 | Staat meestal al op je Mac; anders `xcode-select --install` | `python3 --version` |
| Tailscale | Heb je al. Zet hem aan zoals je gewend bent. | Je server is bereikbaar via Tailscale |

Daarna in Terminal. De map `~/code` is een voorstel; heb je de context-repo's al ergens staan, gebruik dan die.

```bash
mkdir -p ~/code && cd ~/code
gh repo clone robertverveen/homezero-workspace
[ -d homezero-context ] || gh repo clone HomeZeroTech/homezero-context
[ -d context-prive ]    || gh repo clone robertverveen/context-prive
cd homezero-workspace
psql postgres -c "create role hz_dev login password 'hz_dev' createdb"
psql postgres -v migrator=hz_dev -f packages/db/sql/bootstrap-roles.sql
pnpm install && pnpm exec playwright install chromium
cp .env.example .env    # zet daarin HZ_CONTEXT_REPO=~/code/homezero-context en HZ_PERSOONLIJK_REPO=~/code/context-prive (volledige paden)
pnpm -r typecheck && pnpm -r test
```

Alles groen? Dan is je laptop klaar. Iets rood: plak de laatste regels van de fout in de startsessie van stap 4, Claude lost het op.

### Stap 4 · Kies waar Claude Code draait en koppel de repo

Claude Code kan op twee plekken draaien. Beide kies je in de Claude-desktopapp of de Claude-app, tab **Code**, bij het starten van een nieuwe sessie.

| | **Lokaal** (een map op je laptop) | **Cloud** (een Claude-cloudomgeving, zoals nu) |
|---|---|---|
| Claude in Chrome en Tailscale | Ja | Nee: de cloud kan niet bij je browser of je tailnet |
| Laptop dicht | De sessie stopt. Houd hem wakker met `caffeinate -dims` in een Terminal. | Loopt gewoon door |
| Snelheid | Meer stukken tegelijk (meer processorkernen) | 4 kernen, ongeveer 2 stukken tegelijk |
| Echte contextdata voor de vergelijking | Je eigen clones | De twee context-repo's koppel je aan de sessie |
| Repo koppelen | Via git op je laptop | Via de Claude GitHub-app |

**Advies: begin lokaal, met alles in één sessie** (optie 1). Wil je dat het lange bouwen doorloopt terwijl je laptop dicht is, kies dan optie 2: bouwen in de cloud, deel 1 lokaal.

#### De repo koppelen

- **Lokaal:** alleen git op je laptop. Na `gh auth login` (stap 3) en `gh repo clone robertverveen/homezero-workspace` is de map de repo. Claude Code pusht met jouw eigen GitHub-login. Verder hoef je niets te koppelen.
- **Cloud:** dit loopt via de pagina **GitHub Integration** bij je connectors in claude.ai (instellingen, Connectors, GitHub). Die staat al goed: je GitHub-account is gekoppeld en de Claude GitHub-app is geïnstalleerd op **robertverveen** en op **HomeZeroTech**. Bij een nieuwe repo hoef je hooguit één ding te doen:

  1. Open de pagina **GitHub Integration**.
  2. Kies onderaan bij **Check repository status** de repo `robertverveen/homezero-workspace`.
  3. Groen? Dan ben je klaar.
  4. Niet groen? Dan staat de app op "alleen gekozen repo's":
     - klik op **robertverveen** (onder Claude GitHub App); je komt dan bij GitHub;
     - kies bij **Repository access** de optie **Only select repositories**;
     - kies daar **homezero-workspace** erbij en klik **Save**;
     - doe stap 2 opnieuw, nu moet hij groen zijn.

  Claude controleert dit in stap 2 zelf, en vraagt het je alleen als de repo niet bereikbaar is.

#### Optie 1 · Alles lokaal, één sessie (aanbevolen)

1. Claude-desktopapp, tab **Code**, nieuwe sessie, kies **lokaal**, en kies de map `~/code/homezero-workspace`.
2. Toestemmingsniveau: **Auto**, zodat de bouwers niet bij elke stap wachten.
3. Claude in Chrome verbonden, Tailscale aan, laptop aan de stroom, en in een Terminal `caffeinate -dims` (stoppen met Ctrl-C).
4. Vul in de opdracht hieronder de map met je Tailscale- en servernotities in, en plak hem.

**Startopdracht optie 1 (gauntlet loop en deel 1 in één sessie):**

```
Ga verder met de bouw van de HomeZero Workspace in deze repo. Lees eerst OVERDRACHT.md, BRIEF.md, tools/lead/progress.json en tools/lead/golven.json, en controleer of stap 3 van OVERDRACHT.md klopt op deze laptop.

De lat is het artifact-prototype docs/prototype/index.html (gepubliceerd: https://claude.ai/artifact/4CzejHBSKjJNrvBNESpYw4), geladen met mijn echte contextdata via tools/bar. Vergelijk daar direct mee, niet met een beschrijving ervan. Klaar is pas als elke story in stories.json af is en elk onderdeel van de plaat docs/prototype/architectuur.html.

Draai de golven die nog niet gewonnen zijn met tools/lead/golf-workflow.js en golven.json: per stuk een builder en een aparte criticus met frisse context. De criticus legt het onze blind naast de lat, labels weg, kiest de betere en noemt het grootste gat. Het is een harde criticus: lof heeft geen zin. Wint het onze niet, dan gaat het terug naar de builder.

/loop op elk stuk tot de criticus het onze blind kiest en alle tests groen zijn. Stop niet eerder.

Terwijl de golven op de achtergrond lopen, voer je met mij deel 1 van HUMAN_INPUT.md uit via Claude in Chrome en Tailscale. Mijn notities over Tailscale en de server staan in: <MAP MET JE NOTITIES>.

Houd de voortgangspagina bij (https://claude.ai/artifact/9aYoGq9PhxXvFQfmFNZr7H, publiceer met die url) en bundel mensenwerk in HUMAN_INPUT.md.

Fan out subagents and ultracode.
```

#### Optie 2 · Bouwen in de cloud, deel 1 lokaal

Twee sessies naast elkaar. Om botsingen te voorkomen, pusht alleen de cloudsessie naar `main`. De lokale sessie werkt op de branch `inrichting` en levert via een pull request aan.

**Cloudsessie (bouwen):**
1. Claude-app of desktopapp, tab **Code**, nieuwe sessie, kies **cloud**, omgeving **Default** (dezelfde als nu, met Postgres 16).
2. Repo: **robertverveen/homezero-workspace**, branch `main`. Voeg als extra repo's **HomeZeroTech/homezero-context** en **robertverveen/context-prive** toe; die zijn alleen om te lezen, voor de vergelijking met echte data.
3. Toestemmingsniveau **Auto**.
4. Plak:

```
Ga verder met de bouw van de HomeZero Workspace in deze repo. Draai eerst bash tools/lead/cloud-setup.sh (Postgres-rollen en afhankelijkheden in deze verse container). Lees daarna OVERDRACHT.md, BRIEF.md, tools/lead/progress.json en tools/lead/golven.json. De context-repo's staan naast deze repo in de container: gebruik ze alleen om te lezen.

De lat is het artifact-prototype docs/prototype/index.html (gepubliceerd: https://claude.ai/artifact/4CzejHBSKjJNrvBNESpYw4), geladen met de echte contextdata via tools/bar. Vergelijk daar direct mee, niet met een beschrijving ervan. Klaar is pas als elke story in stories.json af is en elk onderdeel van de plaat docs/prototype/architectuur.html.

Draai de golven die nog niet gewonnen zijn met tools/lead/golf-workflow.js en golven.json: per stuk een builder en een aparte criticus met frisse context. De criticus legt het onze blind naast de lat, labels weg, kiest de betere en noemt het grootste gat. Het is een harde criticus: lof heeft geen zin. Wint het onze niet, dan gaat het terug naar de builder.

/loop op elk stuk tot de criticus het onze blind kiest en alle tests groen zijn. Stop niet eerder.

Alleen jij pusht naar main. Pull requests van de branch inrichting (deel 1, lokaal) voeg je na elke golf samen.

Houd de voortgangspagina bij (https://claude.ai/artifact/9aYoGq9PhxXvFQfmFNZr7H, publiceer met die url) en bundel mensenwerk in HUMAN_INPUT.md.

Fan out subagents and ultracode.
```

**Lokale sessie (deel 1), zodra je tijd hebt:**
1. Claude-desktopapp, tab **Code**, nieuwe sessie, kies **lokaal**, en kies de map `~/code/homezero-workspace`.
2. Claude in Chrome verbonden en Tailscale aan.
3. Plak:

```
Voer deel 1 uit van HUMAN_INPUT.md in deze repo, op de branch inrichting (maak hem aan vanaf main en haal main regelmatig binnen).
Lees eerst OVERDRACHT.md, HUMAN_INPUT.md (tabel "Waar staat wat") en het runbook dat daar genoemd wordt,
en mijn notities over Tailscale en de Hetzner-server in: <MAP MET JE NOTITIES>.
De workspace komt op mijn bestaande server, naast mijn andere projecten; die mogen niet geraakt worden.
Gebruik Claude in Chrome met mijn ingelogde accounts; serverbeheer alleen via Tailscale.
Vraag mij alleen bij kosten of een toestemmingsscherm. Secrets nooit in Git of in de chat: rechtstreeks in de secret-opslag op de server.
Werk na elke stap de status in HUMAN_INPUT.md bij, commit op inrichting en open of werk een pull request naar main bij. Push nooit naar main.
```

### Stap 5 · Deel 1 inrichten (samen, lokaal) ⏳
Claude werkt deel 1 van `HUMAN_INPUT.md` af: eerst kijken op je server, dan de workspace naast je andere projecten zetten, DNS, Google Cloud, de Slack-app, Atlassian, GitHub, de Anthropic-sleutel en meldingen. Jij keurt alleen goed bij kosten en toestemmingsschermen. Ondertussen lopen golf B (schermen en contextlaag) en daarna golf C (Claude/MCP, mobiel, beveiliging) en de eindronde op de achtergrond.

### Stap 6 · Jouw testronde (jij, ongeveer 40 minuten) ⏳
Zodra de eindronde gewonnen is, krijg je een seintje met de link. Dan doe je deel 3 van `HUMAN_INPUT.md`: acht scenario's. Bevindingen meld je in de Claude Code-sessie.

## Voor de lead (Claude): zo draai je een golf lokaal

```js
Workflow({
  scriptPath: 'tools/lead/golf-workflow.js',
  args: {
    wave: 'B', base: 'main', maxRounds: 6,
    pieces: /* golven.json -> golven.B */,
    paths: {
      repo: '<absoluut pad naar de repo>', appSub: '',
      plate: '<repo>/docs/prototype/architectuur.html', proto: '<repo>/docs/prototype/index.html',
      wtRoot: '<repo>/../hzw-worktrees',
      ctxRepo: '<pad naar homezero-context>', persRepo: '<pad naar context-prive>'
    }
  }
})
```

- Volgorde: B, C, D (eindronde). Golf A is in de cloud gedaan; zie `tools/lead/progress.json`.
- Na elke golf:
  - werk `tools/lead/progress.json` bij;
  - draai `python3 tools/lead/gen_progress.py tools/lead/progress.json PROGRESS.html`;
  - publiceer de voortgangspagina met de vaste url;
  - commit en push naar `main`.
- Echte contextdata blijft runtime. Maak een export in `.local/` met `pnpm --filter @hz/context export "$HZ_CONTEXT_REPO" "$HZ_PERSOONLIJK_REPO" .local/ctx-export`. Nooit committen.
- Lokaal heb je waarschijnlijk meer processorkernen dan in de cloud (daar 4). Er lopen dus meer stukken tegelijk.
