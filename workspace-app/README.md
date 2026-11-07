# HomeZero Workspace

De webapp die het artifact-prototype (`workspace-prototype/index.html`, v17) vervangt: inloggen met Google
(@homezero.nl), per collega eigen koppelingen, de contextlaag (Git) als bron. Dit is het fundament: alles wat de
andere stukken nodig hebben om parallel te bouwen. Bouwplan: `stories.json`; briefing: `BRIEF.md`.

## Starten

Vereist: Node 22, pnpm 10, en voor de database-tests Postgres 16 op `localhost:5432` (rol `hz_dev`/`hz_dev`, mag
databases maken). Docker is niet nodig. Eenmalig per Postgres-server maakt een beheerder de runtime-rol `hz_app` aan
(zie [Database en rij-beveiliging](#database-en-rij-beveiliging)):

```bash
sudo -u postgres psql -v migrator=hz_dev -f packages/db/sql/bootstrap-roles.sql   # eenmalig, als beheerder
sudo -u postgres psql -v login=hz_app_login -v password=hz_app_login -f packages/db/sql/app-login.sql   # idem (tests)
pnpm install
pnpm dev            # API op :8700 en web op :5700  ->  http://127.0.0.1:5700
```

`pnpm dev` controleert eerst of 8700 en 5700 vrij zijn. Is er een bezet, dan start er niets en meldt het script welke
poort (kies een andere met `HZ_API_PORT`/`HZ_WEB_PORT`). Stopt de API onverwacht, dan stopt ook web.

Lokaal draait alles op fixtures (de demodata van het prototype, vaste klok vrijdag 30 oktober 2026 08:40) en logt de
app automatisch in als testgebruiker `robert@homezero.nl` (dev-login-stub tot het auth-stuk er is). Instellingen
staan in `.env.example`.

| Commando | Wat |
|---|---|
| `pnpm dev` | API (tsx watch) en web (Vite) samen; `pnpm dev -- --worker` start ook de worker |
| `pnpm build` | bundels van api en worker (`dist/`) en de web-app (`apps/web/dist/`) |
| `pnpm typecheck` | `tsc --noEmit` in elk pakket (strict) |
| `pnpm test` | vitest in elk pakket (database-tests maken eigen, verse databases `hz_fundament_test_*` en `hz_e2_test_*`; namen te kiezen met `HZ_TEST_DATABASE_URL*`) |
| `pnpm test:e2e` | Playwright tegen de echte app (eigen poorten 8780/8781) |
| `pnpm lint`, `pnpm format` | ESLint en Prettier |
| `pnpm db:migrate` | migraties op `hz_fundament` (of `DATABASE_URL`) |
| `pnpm --filter @hz/db import:prototype -- --export <pad> --email <collega>` | import uit het prototype (HZW-021), zie [Import](#import-uit-het-prototype) |
| `pnpm bar` | de lat: screenshots van het prototype in `.local/bar/` |
| `pnpm shot` | dezelfde schermen van onze app in `.local/ours/` |
| `node tools/compare.mjs [--blind]` | lat en onze app naast elkaar in `.local/compare/index.html` |

### Met echte contextdata

Echte data komt alleen runtime binnen, nooit in Git:

```bash
HZ_CONTEXT_EXPORT=/pad/naar/ctx-export pnpm dev                     # een export (zoals export_context.py maakt)
HZ_CONTEXT_REPO=/home/user/homezero-context HZ_PERSOONLIJK_REPO=/home/user/context-prive pnpm dev   # de repo's zelf, alleen lezen
pnpm --filter @hz/context export <homezero-context> <persoonlijk|-> <uitmap>                       # export maken (TS-port)
```

Voor een vergelijking met de lat op dezelfde data: `HZ_CONTEXT_EXPORT=... pnpm bar -- --modes demo,context` en
`HZ_CONTEXT_EXPORT=... pnpm shot -- --modes demo,context`. In modus `context` gebruiken beide dezelfde nep-bronnen als
het voorbeeldharnas (`HZ_FIXTURE_SET=harness`) en de klok van nu.

### Met Postgres in plaats van geheugen

```bash
pnpm db:migrate
HZ_STORE=db DATABASE_URL=postgres://hz_dev:hz_dev@localhost:5432/hz_fundament pnpm dev
```

## Database en rij-beveiliging

Drie rollen (HZW-020):

| Rol | Wat | Rechten |
|---|---|---|
| `hz_dev` (migratierol; productie: eigen migratie-login) | draait `pnpm db:migrate`, eigenaar van alle tabellen en van de SECURITY DEFINER-functies | LOGIN, CREATEDB, geen superuser, geen BYPASSRLS |
| `hz_app` (runtime-rol) | waar elke app-query als draait | NOLOGIN, NOBYPASSRLS, eigenaar van niets; alleen SELECT/INSERT/UPDATE/DELETE |
| `hz_app_login` (app-login; productie: zelfde naam, eigen wachtwoord) | de login van `DATABASE_URL` voor api en worker | LOGIN, NOINHERIT, lid van alleen `hz_app`, eigenaar van niets; zonder `SET ROLE hz_app` geen enkel tabelrecht |

- `packages/db/sql/bootstrap-roles.sql` (eenmalig, beheerder) maakt `hz_app` aan en maakt de migratierol er lid van.
  Migratie `0004_app_role.sql` weigert te draaien zonder die rol, verleent de rechten en zet default privileges.
- `packages/db/sql/app-login.sql` (eenmalig, beheerder) maakt de app-login aan en controleert dat hij lid is van alleen
  `hz_app` en nergens eigenaar van is. Lokaal en in CI met wachtwoord `hz_app_login` (alleen voor tests).
- `createDb()` start elke verbinding als `hz_app` (`-c role=hz_app`); `withUser()`/`withPurpose()` doen daarbovenop per
  transactie `SET LOCAL ROLE hz_app` en `set_config('app.user_id', …, true)` (gelijk aan `SET LOCAL`). Alleen
  `runMigrations()` gebruikt `createOwnerDb()`.
- In `NODE_ENV=production` controleert `createDb()` elke nieuwe verbinding (`assertAppLogin`): is de login superuser,
  BYPASSRLS of eigenaar van een tabel (ook via een rol waar hij lid van is), dan faalt elke query met
  `UnsafeAppLoginError`. De migratierol als `DATABASE_URL` in productie kan dus niet.
- Elke tabel heeft `ENABLE` + `FORCE ROW LEVEL SECURITY`. Omdat `hz_app` en de app-login geen eigenaar zijn, kan de app
  RLS niet uitzetten (`NO FORCE`, `DISABLE`, `DROP POLICY` geven `must be owner`), ook niet na `SET ROLE NONE` of
  `RESET ROLE` in een request (dan heeft de login door NOINHERIT zelfs geen leesrecht).
- `app.purpose` is een GUC die elke transactie zelf kan zetten. Daarom opent hij niets meer op `users`, `sessions` en
  `audit_log` (migratie `0006_e2_auth_functions`): die tabellen tonen alleen eigen rijen. Inloggen, een sessie
  opzoeken en de worker gaan via SECURITY DEFINER-functies (zie [Inloggen en de auth-bibliotheek](#inloggen-en-de-auth-bibliotheek)).
  Alleen `withPurpose('index')` opent nog iets: schrijven in de gedeelde `context_index`.
- Tests: `packages/db/test/rls.test.ts` (A ziet nooit rijen van B; `current_user` is `hz_app` en geen `relowner`;
  NO FORCE, DISABLE, DROP/ALTER/CREATE POLICY geweigerd; ook als de eigenaar FORCE uitzet blijft A blind voor B),
  `auth.test.ts` (app.purpose opent niets; de functies zoeken precies één sleutel; PUBLIC mag ze niet uitvoeren),
  `app-login.test.ts` (de app als aparte login: SET ROLE NONE/RESET ROLE, productiecontrole van `createDb()`).

Tabellen en wie ze vult:

| Tabel | Gevuld door | Gelezen door |
|---|---|---|
| `users`, `sessions` | alleen via de functies `auth_*` (dev-login, straks het auth-stuk) | sessie-middleware via `auth_session_by_token` |
| `connections` | koppelingen (tokens envelope-versleuteld) | providers via `readConnectionToken` |
| `item_state` | `PUT /api/itemstate/:key`: leesstatus, verwerkt en **de planning** (`plan_date`, `backlog`, `moved`; één plek) | Dagstart, Planning, Inhalen |
| `weekdoelen`, `briefings` | `/api/weekdoelen`, de MCP-server (briefing van de ochtendroutine), de import (`legacy_id`) | Dagstart, Tracker |
| `tracker_items` | de import uit het prototype (toezeggingen uit `commitments`: Ik beloofde, Eigen voornemen, Wachten op, Bespreken) | Tracker en items (`DbStore.legacyCommits`, zichtbaar zoals `commitVisible()` in het prototype) |
| `pins` | `POST /api/pins` (⌘↵ in het palet), de import (`_pins`) | palet, zijbalk (zoek-stuk) |
| `preferences` | `PATCH /api/preferences` (thema; per agenda kleur en overal/alleen in Agenda) | `/api/agenda`, schil |
| `repo_queue` | `POST /api/repo/queue`: regel volgens `_systeem/schema.md`, status `queued` | schrijfjob van het context-stuk (HZW-060/062: pull --rebase, contextcheck, push, status) |
| `context_index` | indexjob van het context-stuk (`upsertContextIndex`, `withPurpose('index')`, nooit `admin.md`); eenmalig ook de import | zoek-stuk (`searchContextIndex`) |
| `audit_log` | gevoelige acties (inloggen, koppelen, versturen, in de rij zetten) | beheer |

De losse tabel `planning` uit migratie 0000 bestaat niet meer: hij is in `item_state` opgegaan (migratie
`0003_planning_in_item_state`, kolommen `plan_date`, `backlog`, `moved`).

Geen eigen takenlijst (keuze 10): `tracker_items` bewaart alleen wat al in het prototype stond en nog niet is overgezet
(`overgezet`, `naar`). Nieuwe taken gaan naar Google Taken of `taken.md`, wachten op en bespreken naar `wachten-op.md`.

### Inloggen en de auth-bibliotheek

De app-rol heeft geen open SELECT op `users` of `sessions`. Een auth-bibliotheek (Better Auth of Auth.js, stuk E1)
gebruikt in zijn adapter deze SECURITY DEFINER-functies (eigenaar: de migratierol; `EXECUTE` alleen voor `hz_app`;
vast `search_path`), aan te roepen in een transactie als `hz_app` (bijv. `withPurpose(db, 'auth', …)`):

| Functie | Doet | TS (`@hz/db`) |
|---|---|---|
| `auth_user_by_email(email)` | gebruiker bij precies één e-mailadres (hoofdletterongevoelig, geen patroon) | `findUserByEmail` |
| `auth_upsert_user(email, naam, rol)` | aanmaken als hij niet bestaat (na de checks van de server: `email_verified`, domein, allowlist); bestaande blijft ongewijzigd; auditregel | `upsertUser` |
| `auth_create_session(user_id, token_hash, user_agent, expires_at)` | sessie voor een bestaande, niet geblokkeerde gebruiker; alleen sha256-hash (64 hex) van het token; auditregel | `createSession` |
| `auth_session_by_token(token_hash)` | de geldige sessie bij precies één hash (niet ingetrokken, niet verlopen, gebruiker niet geblokkeerd) | `findSession` |
| `auth_touch_session(token_hash, expires_at?)` | laatst gezien bijwerken, desgewenst verlengen (glijdende sessie) | `touchSession` |
| `auth_revoke_session(token_hash)` | uitloggen; auditregel | `revokeSession` |
| `system_active_user_ids()` | worker: alleen de id's van actieve collega's; per id daarna `withUser` | `activeUserIds` |

Voor een adapter: `findOne(session, token)` wordt `auth_session_by_token(sha256(token))`, `create(session)` wordt
`auth_create_session`, `update(session)` wordt `auth_touch_session`, `delete(session)` wordt `auth_revoke_session`,
`findOne(user, email)` en `create(user)` worden `auth_user_by_email` en `auth_upsert_user`. Alles wat na het inloggen
gebeurt (eigen sessies tonen, eigen naam wijzigen) loopt gewoon via `withUser` en RLS. Heeft de bibliotheek extra
tabellen nodig (OAuth-accounts, verificatietokens), volg dan hetzelfde patroon: RLS op eigen rijen en een
SECURITY DEFINER-functie per opzoeksleutel, nooit een regel op `app.purpose`.

### Import uit het prototype

`pnpm --filter @hz/db import:prototype` (HZW-021) zet de artifact-opslag van het prototype over naar Postgres voor één
collega. Draait als `hz_app` met RLS (het script kan alleen rijen van die collega schrijven, plus de gedeelde
contextindex met purpose `index`), in één transactie per deel.

1. **Export maken (mens).** In Claude (met de artifact-tools) per collectie alle documenten van het prototype-artifact
   lezen en wegschrijven als `{"collections": {"commitments": {"<id>": {…}}, "itemstate": {…}, "briefings": {…}}}`
   in een map buiten de repo. Ook goed: een lijst `[{"id": …, "data": {…}}]` per collectie, of een map met per
   collectie een submap met `<id>.json` (zoals de contextexport). Nooit in Git.
2. **Proefdraai:** `DATABASE_URL=… pnpm --filter @hz/db import:prototype -- --export <pad> --email robert@homezero.nl --proef`
   rekent alles door, controleert de aantallen en draait terug.
3. **Echt:** zonder `--proef`. Exitcode 0 = aantallen kloppen, 1 = kloppen niet, 2 = fout in de invoer. `--json` geeft
   het verslag als JSON; `--zonder-context` slaat de contextindex over.

| Collectie | Naar | Sleutel (idempotent) |
|---|---|---|
| `commitments` stroom `weekdoel`, `roadmap` | `weekdoelen` (velden zonder kolom in `extra`) | `legacy_id` = doc-id |
| `commitments` stroom `mijn`, `voornemen`, `aan_mij`, `bespreken` (leeg = `mijn`) | `tracker_items` | `legacy_id` = doc-id |
| `weekdoelen` (optioneel) | `weekdoelen` | `legacy_id` = `weekdoelen:<id>` |
| `itemstate` | `item_state` (read, processed, skipPrep, answeredBy, plan, backlog, moved; rest in `extra`) | item-sleutel |
| `itemstate/_pins` | `pins` | zoekopdracht |
| `processed` (optioneel) | `item_state.processed` | item-sleutel |
| `briefings` | `briefings` (één per dag; de nieuwste wint) | dag |
| `context_partners`, `context_acties` | `context_index` (brief, meetings, acties; `geheim_voor` mee; nooit `admin.md`) | pad (`partners/<slug>/brief.md`, `…/meetings/<bestand>`, `…/acties.md#<id>`) |
| `context_status` | alleen gelezen: commit en exportdatum in het verslag en in `context_index.commit` | - |
| `context_persoonlijk` | overgeslagen: de app leest de Persoonlijk-repo live per collega | - |

Een tweede run met dezelfde export verandert niets (alles `ongewijzigd`). `item_state`: de nieuwste wint, dus wat de
collega na de export in de app wijzigde blijft staan. Rijen die de app zelf maakte (zonder `legacy_id`) raakt de import
nooit. Het verslag telt per collectie docs = gebruikt + overgeslagen (met reden) en per tabel verwacht = nieuw +
bijgewerkt + ongewijzigd = rijen na afloop; het toont geen inhoud van toezeggingen of briefings.
Test: `packages/db/test/import.test.ts` (synthetische export `test/fixtures/prototype-export.json`) en
`apps/api/test/import.test.ts` (na de import ziet Robert zijn tracker terug in de API, een collega niets).

### Worker

pg-boss draait in een eigen schema (`pgboss`) met een eigen verbinding: `HZ_BOSS_DATABASE_URL` (productie verplicht;
een login die eigenaar is van dat schema, bijv. de migratierol; lokaal valt hij terug op `DATABASE_URL`). App-tabellen
gaan via `createDb(DATABASE_URL)` als `hz_app` (productie: de app-login); jobs per collega gebruiken
`activeUserIds()` en daarna `withUser`. `hz_app` heeft geen rechten op het pg-boss-schema. Test:
`apps/worker/test/app-db.test.ts`.

## CI

De git-root is de map boven `workspace-app`, dus de workflow staat in `../.github/workflows/workspace-app.yml` (met
`defaults.run.working-directory: workspace-app` en pnpm uit `package.json`). De Postgres-service draait met superuser
`postgres`; een stap maakt `hz_dev` aan zonder SUPERUSER en draait `bootstrap-roles.sql` en `app-login.sql`. `packages/db/test/ci.test.ts`
bewaakt dat.

## Mapstructuur

```
apps/
  api/        Hono-server: /api/health, dev-login-stub, alle routes uit het contract op de providers, SSE (/api/events)
  web/        React + Vite: schil (zijbalk, palet, hulp, inspector), toetsenbordmodel, TanStack Query, Dagstart
  worker/     pg-boss-worker met de voorbeeldjob context.tel-acties
packages/
  shared/     domeinmodel en API-contract (zod), Dagstart- en planningslogica uit het prototype (pure functies)
  providers/  interface per bron; fixture- (demo, harness) en lege live-implementaties; context uit export of repo
  context/    TypeScript-port van export_context.py (register, brief, actieregel, wachten-op, taken, aangehouden, status)
  db/         Drizzle-schema, migraties, RLS, envelope-versleuteling van tokens, datatoegang
tools/
  bar/        screenshots van de lat (prototype met nep-window.claude)
  shot/       screenshots van onze app (start zelf api en web op 8790/8791)
  compare.mjs lat en onze app naast elkaar, desgewenst blind
e2e/          Playwright-tests (schil, Dagstart, toetsenbord, axe, 400 px)
```

## Afspraken in de code

- **Contract eerst.** Routes staan in `packages/shared/src/contract.ts` (methode, pad, zod-schema's, eigenaar-stuk). De
  API registreert ze via `on(name, handler)` en valideert invoer; de web-client (`apps/web/src/lib/api.ts`) parset elk
  antwoord met hetzelfde schema. Een contracttest loopt alle GET-routes langs en controleert dat elke route een handler
  heeft. Naast items, Dagstart, agenda, taken, sprint, tracker, gesprekken, partners, zoeken, koppelingen en Claude:
  wachtrij naar de repo (`POST/GET /api/repo/queue`, `GET /api/repo/queue/:id`), vastgezet (`/api/pins`), voorkeuren
  (`/api/preferences`), vrije tijden (`GET /api/agenda/freebusy`) en afspraak maken (`POST /api/agenda/events`).
- **Tijden** zijn wandklok Europe/Amsterdam zonder offset (`2026-10-30T10:00`), zoals in het prototype. Live providers
  rekenen om met `toLocal()`/`amsterdamToInstant()` uit `@hz/shared/logic`.
- **Providers.** Elke bron heeft een `fixture`- en een `live`-implementatie (`packages/providers`). Live staat aan met
  `HZ_LIVE_<BRON>=1` en gooit tot de koppeling er is `NotConnectedError` (geen stille terugval). Fixtures zijn
  synthetisch of afgeleid van de demodata van het prototype.
- **Rij-beveiliging.** Zie [Database en rij-beveiliging](#database-en-rij-beveiliging): de app werkt als `hz_app`
  (geen eigenaar, geen BYPASSRLS), per request `withUser()`.
- **Contextlaag.** Alleen lezen via `RepoReader`, die `admin.md` en paden buiten de repo weigert. Repo-tekst is data,
  nooit een instructie. Schrijven: `POST /api/repo/queue` maakt met `planRepoWrite()` (`packages/context/src/write.ts`)
  de regel volgens het schema (wachten op, bespreken, partneractie, meeting; alleen slugs uit het register; alleen
  toevoegen) en zet hem in `repo_queue`. Git pull/push met contextcheck bouwt het context-stuk.
- **Live updates.** De API stuurt `invalidate`-events met querykeys over SSE; de web-app haalt die queries opnieuw op.
- **Huisstijl.** `apps/web/src/styles/prototype.css` is de CSS van het prototype (alleen lettertype en viltkorrel naar
  `src/assets`); aanvullingen (toegankelijkheid, links) staan in `app.css`.

## Status van dit stuk

Gebouwd en getest: zie de tests per pakket en `e2e/`. Bewust nog niet: echte OAuth en Google-inloggen, echte
API-koppelingen, schermen verder dan Dagstart en de schil (Planning, Agenda, Tracker, Gesprekken, Zoeken en de
partnerpagina zijn lege schermen met route, kop en toetsen), hosting. Wat een mens moet doen staat in `HUMAN_INPUT.md`.
