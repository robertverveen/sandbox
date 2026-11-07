# Spike HZW-037: Slack-to-do's in de tracker

Stuk E3 (koppelingen en sync), november 2026. Tijdsbudget: max. 1 dag. Besluit: Robert (zie Advies).

## Vraag

Kan de tracker (keuze 10: geen eigen takenlijst) naast Google Taken ook de to-do's tonen die een collega in Slack
bijhoudt, met de user token van de interne Slack-app (keuze 07)? Drie soorten:

1. **Slack Lists** (lezen en aanmaken; scopes `lists:read`, `lists:write`);
2. **herinneringen** (`reminders.list`, `reminders.add`);
3. **bewaarde items onder "Later"**.

## Bron en controle

Gecontroleerd op 7 november 2026 tegen de officiële Slack-documentatie op docs.slack.dev (de methodepagina's, blok
"Facts": scopes, token-soort en rate-limit-tier, plus de tekst onder "Usage info"):

- `reference/methods/reminders.list`, `.add`, `.complete`, `.delete`, `.info`
- `reference/methods/slackLists.items.list`, `.items.create`, `.items.update`, `.items.delete`, `.items.info`,
  `slackLists.create` (de navigatie toont alle `slackLists.*`-methoden)
- `reference/methods/stars.list`
- `changelog/2023-07-its-later-already-for-stars-and-reminders`
- voor de sync (HZW-033/036): `apis/events-api` (veld `authorizations`, `event_context`),
  `reference/methods/apps.event.authorizations.list`, `reference/methods/conversations.mark`,
  `reference/events/channel_marked`

In de vorige ronde waren die pagina's vanuit de bouwomgeving niet bereikbaar en kwam de tabel uit eerdere kennis.
Nu wel; twee punten bleken anders dan gedacht (zie "Wat veranderde" onder de tabel). Wat de documentatie niet kan
zeggen (gedraagt onze workspace zich zo), toont het proefscript; dat staat nog open (HUMAN_INPUT).

## Uitkomst per soort

| Soort | Kan het? | Methoden | Scopes (user token) | Rate limit (officieel) | Beperkingen |
|---|---|---|---|---|---|
| Herinneringen | **Technisch wel, maar afgeraden** | `reminders.list`, `reminders.info` (lezen); `reminders.add`, `reminders.complete`, `reminders.delete` (schrijven) | `reminders:read`, `reminders:write`. Alleen user token (geen bot token genoemd) | Tier 2 (20+ per minuut), alle vijf | Elke methodepagina zegt: "Retirement of API methods for interfacing with reminders began March 2023, and as such have become degraded or useless." Volgens de changelog komen items die een collega met **Later** bewaart (met of zonder herinnering) **niet** terug in de API. Alleen eenmalige herinneringen hebben `time` en `complete_ts`. `user` bij `reminders.add` wordt genegeerd met een user token. Geen event voor herinneringen: pollen. |
| Slack Lists | **Wel**, per bekende lijst | `slackLists.items.list`, `slackLists.items.info` (lezen); `slackLists.items.create`, `slackLists.items.update`, `slackLists.items.delete`, `slackLists.create` (schrijven) | `lists:read`, `lists:write` (user én bot token) | `items.list`, `items.info`, `items.delete`, `create`: Tier 2 (20+ per minuut). `items.create`, `items.update`: Tier 3 (50+ per minuut) | "Lists are only available to Slack workspaces on a paid plan." Je hebt het `list_id` nodig: er is geen methode die "al mijn lijsten" geeft (de `slackLists.*`-familie heeft er geen). `items.list` pagineert met `cursor`, max. 5000 rijen; `include_list=true` geeft het kolomschema. Kolommen zijn vrij per lijst, dus de app moet per lijst weten welke kolom titel, datum en "klaar" is. `items.update` werkt per cel (`row_id`, `column_id`). |
| Later (bewaarde items) | **Niet** | geen | n.v.t. | n.v.t. | Changelog: "There are no direct APIs for Save it for Later" en "APIs for Save it for Later are not yet available and we don't have a timeline for when or if they'll be made available." `stars.list` (scope `stars:read`, Tier 3) "will no longer reflect anything new that users are saving" en wordt uitgefaseerd. |

Bij elke methode geldt: Slack geeft HTTP 200 met `{ok:false, error}` bij fouten en HTTP 429 met `Retry-After` bij
een rate limit. De provider vertaalt dat naar `AuthError` en `RateLimitError`; de sync-motor wacht dan (HZW-036).

### Wat veranderde na de controle

1. **Herinneringen zijn officieel "degraded or useless"** sinds maart 2023. De vorige versie van deze notitie
   noemde ze bruikbaar. Ze werken nog voor `/remind`-herinneringen, maar wat een collega via Later bewaart komt
   niet mee, en Slack raadt aan functionaliteit op deze methoden af te bouwen.
2. **Rate limits per Lists-methode** staan nu exact in de tabel (Tier 2 voor lezen, Tier 3 voor items maken en
   bijwerken).

### Gevolgen voor de sync (HZW-033/036), ook gecontroleerd

- `conversations.mark` (user token: `channels:write`, `groups:write`, `im:write`, `mpim:write`; Tier 3) zet de
  leescursor "for whomever owns the token": alles tot en met `ts` is gelezen. De app markeert daarom tot het
  gelezen bericht, niet tot het nieuwste.
- `channel_marked` (en de andere `*_marked`-events) bestaan alleen voor RTM ("Compatible APIs: RTM"), niet voor de
  Events API. "Gelezen op een ander apparaat" komt dus via de poll binnen (Slack zonder Events: elke 3 minuten).
- Een event bevat in `authorizations` maar **één** installatie, ook als meer collega's het zien. Alle installaties
  geeft `apps.event.authorizations.list` met `event_context`; daarvoor is een **app-level token** met
  `authorizations:read` nodig, in de Authorization-header (rate limit 600 per minuut per app per team). Zonder dat
  token valt de app terug op de kanaalleden die de sync al kent.

## Proefscript (zelftest van de story)

```bash
SLACK_USER_TOKEN=xoxp-… SLACK_TEST_LIST_ID=F0… pnpm --filter @hz/providers spike:slack-todos           # alleen lezen
SLACK_USER_TOKEN=xoxp-… SLACK_TEST_LIST_ID=F0… pnpm --filter @hz/providers spike:slack-todos --write   # + testherinnering aanmaken en weer verwijderen
```

- Token: de user token van de interne Slack-app (of tijdelijk een eigen token met dezelfde scopes). Nooit in Git.
- Testlijst: maak in Slack een lijst "HZW-037 test" met twee items, kopieer het id uit de link (`F0…`).
- Bewaar ook één bericht met Later en zet één `/remind`: zo laat de proef zien dat alleen de `/remind` terugkomt.
- Het script schrijft niets weg en verstuurt niets; met `--write` alleen één herinnering die direct weer weg is.
- Dezelfde logica (`probeSlackTodos`) draait in de repo tegen een nep-Slack:
  `packages/providers/test/live/slack-todos.test.ts`.

### Proefscript-uitkomst (invullen na de proef)

| Datum | Wie | Herinneringen (`/remind`) | Later-item zichtbaar? | Lists | Scopes van het token |
|---|---|---|---|---|---|
| | | | | | |

## Wat er al staat (achter een vlag)

`packages/providers/src/live/slack-todos.ts`, aan met `HZ_SLACK_TODOS=1` (naast `HZ_LIVE_SLACK=1`):

- `SlackTodos`: open eigen herinneringen en open items van gekoppelde lijsten als taken (`TaskItem`), in de lijsten
  "Slack-herinneringen" en per lijst `slack:list:<id>`. Lijsten koppelen: `HZ_SLACK_TODO_LISTS=F0…:Mijn to-do,F0…:Team`.
- Herinnering aanmaken (`reminders.add`) en afvinken (`reminders.complete`), alleen na een klik van een mens.
  Lists-items bijwerken zit er bewust nog niet in.
- `CombinedTasks`: Google Taken blijft leidend; Slack-to-do's komen erbij, dubbelingen (zelfde titel en datum) één keer.
- Zonder vlag verandert er niets.

## Advies

1. **Google Taken blijft de takenlijst** (keuze 10). Slack-to-do's worden hooguit een extra, optionele bron in de
   tracker, niet de plek waar de app nieuwe taken neerzet.
2. **Lists: ja, als een collega er echt mee werkt.** Officieel ondersteund, ruime limieten, maar per lijst moet je
   de kolommen kiezen (kleine instelling in Koppelingen) en Lists vraagt een betaald abonnement. Eerst lezen,
   afvinken later (`slackLists.items.update`, per cel).
3. **Herinneringen: niet als bouwstory.** De methoden zijn officieel "degraded or useless" en missen alles wat via
   Later gaat; dat is precies hoe collega's nu to-do's in Slack bewaren. De schil achter de vlag blijft staan voor
   wie alleen `/remind` gebruikt, maar gaat niet standaard aan.
4. **Later: niet bouwen.** Geen publieke API en geen tijdpad. Wie een bericht als to-do wil markeren gebruikt de
   📣-reactie die de app al als to-do herkent (`hasmy::mega:` in HZW-033), of maakt er met `1`–`5` in Inhalen een
   Google Taak van.
5. Scopes voor de Slack-app (K3): `lists:read` (en later `lists:write`) alleen als punt 2 doorgaat;
   `reminders:read`/`reminders:write` alleen voor de proef.

Voorstel bouwstory (als Robert ja zegt): "Tracker: items uit een gekoppelde Slack-lijst naast Google Taken (lezen,
later afvinken), lijst en kolommen kiezen in Koppelingen", met de schil hierboven als begin en de
proefscript-uitkomst als bewijs.
