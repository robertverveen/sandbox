# Spike HZW-037: Slack-to-do's in de tracker

Stuk E3 (koppelingen en sync), november 2026. Tijdsbudget: max. 1 dag. Besluit: Robert (zie Advies).

## Vraag

Kan de tracker (keuze 10: geen eigen takenlijst) naast Google Taken ook de to-do's tonen die een collega in Slack
bijhoudt, met de user token van de interne Slack-app (keuze 07)? Drie soorten:

1. **Slack Lists** (lezen en aanmaken; scopes `lists:read`, `lists:write`);
2. **herinneringen** (`reminders.list`, `reminders.add`);
3. **bewaarde items onder "Later"**.

## Uitkomst per soort

| Soort | Kan het? | Methoden | Scopes (user token) | Rate limit | Beperkingen |
|---|---|---|---|---|---|
| Herinneringen | **Wel**, lezen en schrijven | `reminders.list`, `reminders.info`, `reminders.add`, `reminders.complete`, `reminders.delete` | `reminders:read`, `reminders:write` | Tier 2 (ca. 20 per minuut) | Alleen met een user token (geen bot token). Herinneringen die via "Later" op een bericht zijn gezet komen mogelijk niet mee; het proefscript laat zien wat `reminders.list` voor ons teruggeeft. Geen push-event voor herinneringen: pollen. |
| Slack Lists | **Wel**, per bekende lijst | `slackLists.items.list` (lezen), `slackLists.items.create`, `slackLists.items.update`, `slackLists.items.delete`, `slackLists.create` | `lists:read`, `lists:write` | Tier 2 tot 3 (per methode verschillend) | Alleen op betaalde Slack-abonnementen. Je hebt het `list_id` nodig (uit de link van de lijst); er is geen methode "al mijn lijsten". Kolommen zijn vrij per lijst, dus de app moet per lijst weten welke kolom titel, datum en "klaar" is. |
| Later (bewaarde items) | **Niet** | geen | n.v.t. | n.v.t. | Geen publieke API. De oude `stars.*`-methoden geven niet de items onder Later terug (sinds Later de bewaarde items verving). Bouwen op een niet-publieke methode doen we niet. |

Bij elke methode geldt: Slack geeft HTTP 200 met `{ok:false, error}` bij fouten en HTTP 429 met `Retry-After` bij
een rate limit. De provider vertaalt dat naar `AuthError` en `RateLimitError`; de sync-motor wacht dan (HZW-036).

### Hoe zeker is dit?

De tabel volgt de officiële Slack-documentatie (methodenreferentie op docs.slack.dev: `reminders.list`,
`reminders.add`, `slackLists.items.list` e.d., en de pagina over rate limits). Vanuit de bouwomgeving waren die
pagina's niet bereikbaar (netwerkbeperking), dus de details hierboven komen uit eerdere kennis van die documentatie
en zijn **nog niet tegen de HomeZero-workspace geverifieerd**. Daarvoor is het proefscript (hieronder): het draait in
één minuut en zegt per soort wel of niet, met de scopes van het token. Vul de uitkomst in voordat er een bouwstory
komt.

## Proefscript (zelftest van de story)

```bash
SLACK_USER_TOKEN=xoxp-… SLACK_TEST_LIST_ID=F0… pnpm --filter @hz/providers spike:slack-todos           # alleen lezen
SLACK_USER_TOKEN=xoxp-… SLACK_TEST_LIST_ID=F0… pnpm --filter @hz/providers spike:slack-todos --write   # + testherinnering aanmaken en weer verwijderen
```

- Token: de user token van de interne Slack-app (of tijdelijk een eigen token met dezelfde scopes). Nooit in Git.
- Testlijst: maak in Slack een lijst "HZW-037 test" met twee items, kopieer het id uit de link (`F0…`).
- Het script schrijft niets weg en verstuurt niets; met `--write` alleen één herinnering die direct weer weg is.
- Dezelfde logica (`probeSlackTodos`) draait in de repo tegen een nep-Slack:
  `packages/providers/test/live/slack-todos.test.ts`.

### Proefscript-uitkomst (invullen na de proef)

| Datum | Wie | Herinneringen | Lists | Later | Scopes van het token |
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

1. **Google Taken blijft de takenlijst** (keuze 10). Slack-to-do's worden een extra, optionele bron in de tracker,
   niet de plek waar de app nieuwe taken neerzet.
2. **Herinneringen: ja, lezen en afvinken.** Weinig werk (de schil staat er), echte waarde voor wie `/remind`
   gebruikt. Pollen elke 5 tot 10 minuten past ruim binnen Tier 2.
3. **Lists: alleen als een collega er echt mee werkt.** Per lijst moet je de kolommen kiezen; dat is een kleine
   instelling in Koppelingen. Eerst lezen, afvinken later (`slackLists.items.update`).
4. **Later: niet bouwen.** Geen publieke API. Wie een bericht als to-do wil markeren gebruikt de 📣-reactie die de
   app al als to-do herkent (`hasmy::mega:` in HZW-033), of maakt er met `1`–`5` in Inhalen een Google Taak van.
5. Scopes voor de Slack-app (K3): `reminders:read` en `reminders:write` erbij; `lists:read` (en later `lists:write`)
   alleen als punt 3 doorgaat.

Voorstel bouwstory (als Robert ja zegt): "Tracker: Slack-herinneringen naast Google Taken (lezen, afvinken), lijst
koppelen in Koppelingen", met de schil hierboven als begin en de proefscript-uitkomst als bewijs.
