# Persoonlijke contextlaag (Robert)

Een Obsidian-vault in een private GitHub-repo, naast de centrale Home Zero-contextlaag. Snel en visueel in Obsidian (graph, backlinks), bereikbaar op je telefoon, en voor Claude aan te roepen via een kleine MCP-server die vooral met de index werkt. Claude leest dus niet elke keer alle bestanden.

## Twee lagen, één conventie

```
homezero/context   (centraal, gedeeld)            robert/context   (persoonlijk, deze vault)
├── partners/feenstra.md                          ├── partners/feenstra.md   → mijn notities, verwijst naar [[hz/partners/feenstra]]
├── product/decisions/…                           ├── meetings/2026/…        → alles wat ik besprak
├── design/decisions/…                            ├── weeks/2026-W45.md      → weekdoelen + check-ins
└── …                                             ├── roadmap/…              → wat ik strak volg
                                                  ├── inbox/                 → nog te routeren
                                                  └── hz/  (submodule, alleen lezen: de centrale laag)
```

- **Dezelfde mappen en frontmatter** in beide lagen. Een link als `[[hz/partners/feenstra]]` werkt in Obsidian omdat de centrale repo als submodule in `hz/` staat. De graph laat persoonlijke en gedeelde kennis dus samen zien.
- **Eén feit, één plek.** Partnerfeiten (fase, contract, contactpersonen) staan centraal. Jouw notitie verwijst ernaar en voegt alleen toe wat persoonlijk is: indrukken, onderhandelingsruimte, eigen to-do's.
- **Promoveren:** zet `share: hz` in de frontmatter. Een routine opent dan een PR naar de centrale repo met alleen de gemarkeerde sectie. Jij of een collega keurt die goed. Zo blijft de centrale laag schoon.

## Frontmatter (verplicht, houdt het token-zuinig)

```yaml
---
type: partner | person | meeting | decision | week | roadmap | note
id: feenstra                # stabiel, kort; bestandsnaam = id
title: Feenstra
summary: Installateur, live; leadinstroom tijdelijk uit (capaciteit).   # 1 regel, ≤160 tekens
links: [hz/partners/feenstra, people/marie-jose]                         # optioneel, naast [[wikilinks]] in de tekst
status: actief
review_by: 2026-12-01       # wanneer moet dit opnieuw gecheckt
share: none | hz            # promoveren naar de centrale laag
updated: 2026-10-31
---
```

`summary` is het belangrijkste veld. De index geeft Claude eerst alleen `id`, `type`, `summary` en links (~25 tokens per notitie). Pas als een notitie relevant is, haalt Claude één sectie op.

## Index: de goedkope ingang voor Claude

`node tools/build-index.mjs` maakt twee bestanden:

- `_index/graph.json`: per notitie id, pad, type, titel, summary, links, backlinks, koppen en `updated`.
- `_index/digest.md`: één regel per notitie, gegroepeerd per type. Dit is wat Claude als eerste leest (enkele kilobytes, ook bij honderden notities).

Draai de index bij elke commit (git hook of GitHub Action), zodat hij altijd klopt.

## MCP-server: hoe Claude ermee werkt

`node tools/mcp-server.mjs` (stdio, geen dependencies). Tools:

| Tool | Wat | Waarom zuinig |
|---|---|---|
| `context_digest` | De digest, optioneel per type of map | Eén call geeft overzicht |
| `context_search` | Zoeken in titel, summary en koppen; geeft ids + summaries | Geen volledige bestanden |
| `context_get` | Eén notitie, of alleen `section: "Afspraken"` | Alleen wat nodig is |
| `context_related` | Links en backlinks van een id, met summaries | Navigeren zonder lezen |
| `context_route` | Voorstel waar meetingnotities heen moeten: partner, personen, besluiten, weeknotitie, inbox | Claude schrijft gericht weg |
| `context_write` | Schrijft of vult een notitie aan (append onder een kop), zet `updated` | Kleine diffs, git-history |

In productie zet je dezelfde tools achter een kleine webapp (bijv. Cloudflare Worker of Vercel) met GitHub als opslag. Je koppelt hem als custom connector in claude.ai. Dan kunnen routines, skills en Claude op je telefoon hem allemaal gebruiken.

## Klantmeeting verwerken (samen met /klant-recap)

1. `/klant-recap` haalt Wispr-notities en de partnerstand op, zoals nu.
2. Nieuw: `context_route` met deelnemers, partner en notities geeft terug:
   - `partners/<partner>.md` → sectie *Logboek* (1–3 zinnen) en *Open punten*;
   - `meetings/<jaar>/<datum>-<partner>.md` (nieuw, met links naar partner, personen en Wispr);
   - `people/<persoon>.md` → wat je over iemand leerde;
   - besluiten → `product/decisions/` of `design/decisions/` (één bestand per besluit);
   - toezeggingen → de tracker in de workspace (niet in markdown).
3. Claude schrijft met `context_write` alleen die stukken weg. Deelbare feiten markeert hij met `share: hz` → PR naar de centrale laag.

## Product- en designcontext die blijft kloppen

- **Design weekly:** na de meeting komt elk besluit als eigen bestand in `design/decisions/` (wat, waarom, alternatieven, link naar Dominiques design en de Slack-thread). Het onderwerpbestand (bijv. `design/offerte-pdf.md`) linkt naar de besluiten en houdt een korte *Huidige stand* bij.
- **Contextpakket op aanvraag:** `context_search` + `context_related` op een onderwerp geeft Claude de stand plus de besluiten in een paar honderd tokens. Werkt Claude aan een design of story, dan roept hij dat eerst aan.
- **Kloppend houden:** een nachtelijke routine draait de index en controleert:
  - gebroken links;
  - notities voorbij `review_by`;
  - weesnotities;
  - "Huidige stand" die ouder is dan het nieuwste besluit;
  - tegenstrijdigheden tussen persoonlijk en centraal: Claude vergelijkt alleen de summaries.

  De bevindingen komen als één item in je dagstart.

## Mobiel

- **Obsidian iOS:** synchroniseren via Obsidian Sync, of via git met de app Working Copy.
- **Alleen lezen:** GitHub mobiel. De digest is een gewone markdownpagina.
- **Vragen stellen:** Claude op je telefoon met de connector uit de vorige sectie.

## Hoe het samenwerkt met de skills en routines die nu draaien

| Nu | Straks |
|---|---|
| `/morning-briefing` leest Slack, Wispr en het canvas | Leest eerst de digest en de tracker, en zoekt alleen live naar wat sinds gisteren nieuw is |
| `/klant-recap` schrijft Slack-drafts en het portaal | Zet daarnaast meeting, besluiten en partnerlogboek in de contextlaag via `context_route` |
| `/zondag-weekprep` maakt doelen in Slack en Tasks | Schrijft ook `weeks/<ISO-week>.md` en de doelen in de tracker (staat al in de routine) |
| Design weekly via canvas | Besluiten in `design/decisions/`, items in de dagstart |

Overgang: eerst landt alles dubbel (Telegram en workspace; de routines doen dat nu al). Ziet de workspace er een paar weken goed uit, dan vervangt een ochtendnotificatie van de app de Telegram-briefing.
