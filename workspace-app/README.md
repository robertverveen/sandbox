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
sudo -u postgres psql -v login=hz_indexer_login -v password=hz_indexer_login -f packages/db/sql/indexer-login.sql   # idem (tests)
sudo -u postgres psql -c "CREATE DATABASE hz_boss_setup OWNER hz_dev"   # idem: maakt de pg-boss-login (tests)
sudo -u postgres psql -d hz_boss_setup -v login=hz_boss -v password=hz_boss_test -v schema=pgboss -f packages/db/sql/boss-login.sql
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

Rollen (HZW-020):

| Rol | Wat | Rechten |
|---|---|---|
| `hz_dev` (migratierol; productie: eigen migratie-login) | draait `pnpm db:migrate`, eigenaar van alle tabellen en van de SECURITY DEFINER-functies | LOGIN, CREATEDB, geen superuser, geen BYPASSRLS |
| `hz_app` (runtime-rol) | waar elke app-query als draait | NOLOGIN, NOBYPASSRLS, eigenaar van niets; alleen SELECT/INSERT/UPDATE/DELETE (op `users` alleen de kolom `name`; op `context_index` alleen lezen) |
| `hz_app_login` (app-login; productie: zelfde naam, eigen wachtwoord) | de login van `DATABASE_URL` voor de api | LOGIN, NOINHERIT, lid van alleen `hz_app`, eigenaar van niets; zonder `SET ROLE hz_app` geen enkel tabelrecht |
| `hz_auth` (rol voor inloggen, migratie 0011) | mag als enige de `auth_*`-functies uitvoeren (gebruiker opzoeken of aanmaken, sessie aanmaken, opzoeken, verlengen, intrekken) | NOLOGIN, NOBYPASSRLS, geen tabelrechten; `USAGE` op `public` en `EXECUTE` op die functies |
| `hz_auth_login` (auth-login) | `HZ_AUTH_DATABASE_URL` van de api: sessie-middleware en adapter van de auth-bibliotheek; ook het importscript | LOGIN, NOINHERIT, lid van alleen `hz_auth`, eigenaar van niets; leest geen enkele tabel |
| `hz_worker` (rol van de worker, migratie 0010) | mag als enige `system_active_user_ids()` uitvoeren (de id's van alle actieve collega's); een login die hier lid van is, mag namens een collega werken met `app.user_id` (0011) | NOLOGIN, NOBYPASSRLS, geen tabelrechten; `USAGE` op `public` en `EXECUTE` op die ene functie |
| `hz_worker_login` (worker-login) | `DATABASE_URL` van de worker en van het importscript | LOGIN, NOINHERIT, lid van alleen `hz_app` en `hz_worker`, eigenaar van niets |
| `hz_indexer` (rol van de indexer) | schrijft in de gedeelde `context_index`, alleen via `context_index_upsert`/`context_index_delete` | NOLOGIN, NOBYPASSRLS, eigenaar van niets; lezen op `context_index` en `EXECUTE` op die twee functies |
| `hz_indexer_login` (indexer-login) | `HZ_INDEX_DATABASE_URL` van de indexjob (context-stuk) en van het importscript | LOGIN, NOINHERIT, lid van alleen `hz_indexer`, eigenaar van niets |
| `hz_boss` (pg-boss-login) | `HZ_BOSS_DATABASE_URL` van de worker | LOGIN, NOINHERIT, nergens lid van; eigenaar van alleen schema `pgboss`; mag niets in `public` |

- `packages/db/sql/bootstrap-roles.sql` (eenmalig, beheerder; opnieuw draaien mag) maakt `hz_app`, `hz_indexer`,
  `hz_worker` en `hz_auth` aan en maakt de migratierol er lid van. Migratie `0004_app_role.sql` weigert te draaien
  zonder `hz_app`, `0009` zonder `hz_indexer`, `0010` zonder `hz_worker`, `0011` zonder `hz_auth`. **Na deze ronde:**
  op een bestaande server `bootstrap-roles.sql` opnieuw draaien vóór `pnpm db:migrate`, en `sql/auth-login.sql` voor
  de api (`HZ_AUTH_DATABASE_URL`). Migratie 0013 (geen tijdelijke tabellen) vraagt dat de migratierol eigenaar is van
  de database; is hij dat niet, dan stopt 0013 en noemt de ene `REVOKE` die een beheerder moet draaien. Daarna de
  login-scripts nog eens met `-v db=<app-database>` voor de TEMP-controle.
- `packages/db/sql/auth-login.sql` (eenmalig, beheerder) maakt de auth-login (lid van alleen `hz_auth`). Lokaal en in
  CI met testwachtwoord `hz_auth_login`.
- `packages/db/sql/worker-login.sql` (eenmalig, beheerder) maakt de login van de worker (lid van `hz_app` en
  `hz_worker`). Lokaal en in CI met testwachtwoord `hz_worker_login`.
- `packages/db/sql/indexer-login.sql` en `boss-login.sql` (eenmalig, beheerder) maken de logins van de indexer en van
  pg-boss, met dezelfde controles als `app-login.sql`. Lokaal en in CI met testwachtwoorden (`hz_indexer_login`,
  `hz_boss_test`), alleen voor tests.
- `packages/db/sql/app-login.sql` (eenmalig, beheerder) maakt de app-login aan en controleert dat hij lid is van alleen
  `hz_app` en nergens eigenaar van is. Lokaal en in CI met wachtwoord `hz_app_login` (alleen voor tests).
- `createDb()` start elke verbinding als `hz_app` (`-c role=hz_app`); `withUser()`/`withPurpose()` doen daarbovenop per
  transactie `SET LOCAL ROLE hz_app` en `set_config('app.user_id', …, true)` (gelijk aan `SET LOCAL`). Binnen
  `runWithSession(hashToken(token), …)` zet `withUser()` ook `app.session`; `withSession(db, hash, …)` doet alleen dat.
  `createAuthDb()`/`withAuth()` draaien als `hz_auth`. Alleen `runMigrations()` gebruikt `createOwnerDb()`.
- In `NODE_ENV=production` controleert `createDb()` elke nieuwe verbinding (`assertAppLogin`): is de login superuser,
  BYPASSRLS of eigenaar van een tabel (ook via een rol waar hij lid van is), dan faalt elke query met
  `UnsafeAppLoginError`. De migratierol als `DATABASE_URL` in productie kan dus niet. Ook een login die lid is van
  `hz_worker` of `hz_indexer` weigert hij, behalve wat de aanroeper toestaat (`allowRoles`: de worker `hz_worker`,
  `createIndexerDb()` `hz_indexer`). Zo kan de api niet per ongeluk met de worker-login draaien.
- Sessies duren hoogstens 30 dagen: `auth_create_session` en `auth_touch_session` kappen de verloopdatum op
  `now() + 30 dagen` (migratie 0010); een verloopdatum in het verleden geeft een fout.
- Elke tabel heeft `ENABLE` + `FORCE ROW LEVEL SECURITY`. Omdat `hz_app` en de app-login geen eigenaar zijn, kan de app
  RLS niet uitzetten (`NO FORCE`, `DISABLE`, `DROP POLICY` geven `must be owner`), ook niet na `SET ROLE NONE` of
  `RESET ROLE` in een request (dan heeft de login door NOINHERIT zelfs geen leesrecht).
- **Wie is de gebruiker van een transactie (migratie 0011)?** `app_user_id()` (gebruikt door alle RLS-regels) kijkt
  eerst naar `app.session`: de sha256-hash van het sessietoken uit de cookie. Hoort die bij een geldige sessie (niet
  ingetrokken, niet verlopen, gebruiker niet geblokkeerd, domein toegestaan), dan is dat de gebruiker; anders niemand.
  Staat `app.user_id` op iemand anders dan de sessie, dan ook niemand. Zonder `app.session` telt `app.user_id` alleen
  als de login van de verbinding (`session_user`, niet te veranderen met `SET ROLE`) lid is van `hz_worker`: de worker
  en het importscript werken zo namens een collega. De api-login is daar geen lid van. In de api zet de
  sessie-middleware elke request in `store.asSession(token, …)` (`runWithSession`); de `DbStore` gebruikt voor
  inloggen en sessies een aparte verbinding als `hz_auth_login`.
- **Wat RLS met een GUC wel en niet tegenhoudt.** RLS met `app.user_id` beschermt tegen een vergeten `WHERE`-filter in
  app-code, niet tegen willekeurige SQL als `hz_app`: een GUC kan elke transactie zelf zetten. Daarom hangt de
  gebruiker sinds 0011 aan een geldig sessietoken (256 bits, alleen de hash staat in de database) en kan `hz_app` geen
  gebruiker opzoeken, aanmaken of een sessie maken (die functies zijn van `hz_auth`). Wat blijft: willekeurige SQL in
  de request van A kan alles van A lezen en wijzigen (dat is A zelf); een gestolen sessietoken is een gestolen sessie;
  de worker-login kan namens iedereen werken en hoort dus alleen in de omgeving van worker en importscript; de
  auth-login kan voor iedereen een sessie maken en hoort alleen bij de sessie-middleware en de auth-adapter. Test:
  `auth.test.ts`, "aanvalspad: een request kan niemand nadoen" (als `hz_app_login`: geen id via e-mail of
  `auth_upsert_user`, `app.user_id` op B geeft geen rijen van B, geen sessie voor B).
- **Een verbinding uit de pool erft niets van de vorige request (migratie 0013).** Willekeurige SQL in de request van
  A kon tot 0013 op een gedeelde verbinding `CREATE TEMP TABLE weekdoelen` doen: drizzle noemt tabellen zonder schema
  en `pg_temp` stond vooraan in het zoekpad, dus de volgende request (van B) schreef en las in de tabel van A. Nu drie
  sloten: (1) 0013 doet `REVOKE TEMPORARY ON DATABASE <db> FROM PUBLIC` (en van `hz_app`, `hz_worker`, `hz_auth`,
  `hz_indexer`); de migratie stopt met uitleg als de migratierol geen eigenaar van de database is en het dus niet lukt.
  (2) Elke verbinding van `createDb()` en de andere pools start met `-c search_path=public,pg_temp` (`SEARCH_PATH`,
  `connectionOptions()`), dus `pg_temp` komt altijd na `public`. (3) Elke transactie van `withUser`, `withSession`,
  `withPurpose`, `withAuth`, `withIndexer` en `withWorker` begint met `RESET ALL`: een gewone `SET` (zoekpad,
  `app.session`, `app.user_id`) die A op sessieniveau achterliet, telt in de volgende request niet. In productie
  weigert `assertAppLogin()` ook een login die TEMP heeft (`checkAppLogin().temp`), en `sql/*-login.sql` met
  `-v db=<app-database>` controleert hetzelfde. Test: `app-login.test.ts`, "temp-tabel kan een collega niet nadoen"
  (pool met één verbinding: `CREATE TEMP TABLE weekdoelen` geeft 42501, de insert van B landt in `public.weekdoelen`,
  A ziet die rij daarna niet, een request zonder sessie erft `app.session` van A niet).
- **Uitloggen blijft uitloggen (0013).** `hz_app` heeft geen UPDATE meer op `sessions` (ook niet op `revoked_at`):
  `UPDATE sessions SET revoked_at = NULL` binnen de eigen sessie maakte een uitgelogd token weer geldig. Een eigen
  sessie intrekken (uitloggen op een ander apparaat) gaat via `auth_revoke_own_session(sessie_id)` (SECURITY DEFINER,
  `EXECUTE` alleen voor `hz_app`; TS: `revokeOwnSession(db, userId, sessieId)` binnen `runWithSession`): alleen een
  eigen, nog geldige sessie. De trigger `sessions_guard` houdt voor iedereen vast (ook de functies en de
  migratierol) dat een ingetrokken sessie ingetrokken blijft en dat `token_hash`, `user_id` en `created_at` niet
  veranderen. Test: `auth.test.ts`, "uitloggen blijft uitloggen".
- **Auditlog alleen toevoegen (0013).** `hz_app` heeft geen UPDATE, DELETE of TRUNCATE op `audit_log` en geen DELETE
  of TRUNCATE op `import_keys`; dat hing eerst alleen aan een ontbrekende RLS-regel. Toevoegen voor zichzelf en
  eigen regels lezen kan nog.
- RLS-regels schrijven `(SELECT app_user_id())`: Postgres rekent de sessie dan één keer per query uit, niet per rij
  (0011 herschreef alle bestaande regels zo). Nieuwe regels in latere migraties: zelfde vorm.
- `app.purpose` is een GUC die elke transactie zelf kan zetten. Daarom opent hij niets meer op `users`, `sessions` en
  `audit_log` (migratie `0006_e2_auth_functions`): die tabellen tonen alleen eigen rijen. Inloggen, een sessie
  opzoeken en de worker gaan via SECURITY DEFINER-functies (zie [Inloggen en de auth-bibliotheek](#inloggen-en-de-auth-bibliotheek)).
  Ook `withPurpose('index')` opent niets meer (migratie `0009_e2_context_index_writer`): `hz_app` heeft geen
  INSERT/UPDATE/DELETE op `context_index`. Schrijven kan alleen als `hz_indexer` via `context_index_upsert(rijen)` en
  `context_index_delete(pad)`, die `admin.md` in SQL weigeren (pad of sleutel) en soort, pad en titel controleren. In TS:
  `createIndexerDb()` + `upsertContextIndex()`/`deleteContextIndexPath()` (of `withIndexer()`). De app-login kan geen
  `hz_indexer` worden; `canIndex(db)` zegt of een verbinding het kan.
- Tests: `packages/db/test/rls.test.ts` (A ziet nooit rijen van B; `current_user` is `hz_app` en geen `relowner`;
  NO FORCE, DISABLE, DROP/ALTER/CREATE POLICY geweigerd; ook als de eigenaar FORCE uitzet blijft A blind voor B),
  `auth.test.ts` (app.purpose opent niets op users, sessions en context_index; de functies zoeken precies één sleutel;
  alleen `hz_auth` mag ze uitvoeren; het aanvalspad als `hz_app_login`; geen admin of gebruiker buiten het domein; de
  indexer-login schrijft, de app-login niet), `app-login.test.ts` (de app als aparte login: SET ROLE NONE/RESET ROLE,
  alleen rijen binnen een geldige sessie, productiecontrole van `createDb()`).

Tabellen en wie ze vult:

| Tabel | Gevuld door | Gelezen door |
|---|---|---|
| `users`, `sessions` | alleen via de functies `auth_*` als `hz_auth` (dev-login, straks het auth-stuk) | sessie-middleware via `auth_session_by_token`; `app_user_id()` |
| `connections` | koppelingen (tokens envelope-versleuteld) | providers via `readConnectionToken` |
| `item_state` | `PUT /api/itemstate/:key`: leesstatus, verwerkt en **de planning** (`plan_date`, `backlog`, `moved`; één plek) | Dagstart, Planning, Inhalen |
| `weekdoelen`, `briefings` | `/api/weekdoelen`, de MCP-server (briefing van de ochtendroutine), de import (`legacy_id`, `imported_at`; velden van een briefing zonder kolom in `briefings.extra`, 0012) | Dagstart, Tracker |
| `tracker_items` | de import uit het prototype (toezeggingen uit `commitments`: Ik beloofde, Eigen voornemen, Wachten op, Bespreken) | Tracker en items (`DbStore.legacyCommits`, zichtbaar zoals `commitVisible()` in het prototype) |
| `pins` | `POST /api/pins` (⌘↵ in het palet), de import (`_pins`) | palet, zijbalk (zoek-stuk) |
| `preferences` | `PATCH /api/preferences` (thema; per agenda kleur en overal/alleen in Agenda) | `/api/agenda`, schil |
| `repo_queue` | `POST /api/repo/queue`: regel volgens `_systeem/schema.md`, status `queued` | schrijfjob van het context-stuk (HZW-060/062: pull --rebase, contextcheck, push, status) |
| `context_index` | indexjob van het context-stuk als `hz_indexer` (`createIndexerDb` + `upsertContextIndex`/`deleteContextIndexPath`, nooit `admin.md`); eenmalig ook de import | zoek-stuk (`searchContextIndex`) |
| `import_keys` | de import: welke sleutels hij per collega al eens schreef (zodat iets wat in de app is verwijderd niet terugkomt) | de import |
| `auth_domains` | beheerder als migratierol (standaard `homezero.nl`) | alleen de functies `auth_upsert_user`, `auth_create_session`, `auth_session_by_token` |
| `audit_log` | gevoelige acties (inloggen, koppelen, versturen, in de rij zetten) | beheer |

**Let op:** de losse tabel `planning` uit migratie 0000 bestaat niet meer: hij is in `item_state` opgegaan (migratie
`0003_planning_in_item_state`, kolommen `plan_date`, `backlog`, `moved`). Planning lezen en schrijven gaat dus via
`item_state` (`PUT /api/itemstate/:key`).

`weekdoelen` en `tracker_items` hebben `updated_at` (een trigger zet hem bij elke UPDATE, ook als app-code het
vergeet) en `imported_at` (laatste import van die rij). `updated_at > imported_at` betekent: na de import in de app
gewijzigd; zie [Import](#import-uit-het-prototype).

Geen eigen takenlijst (keuze 10): `tracker_items` bewaart alleen wat al in het prototype stond en nog niet is overgezet
(`overgezet`, `naar`). Nieuwe taken gaan naar Google Taken of `taken.md`, wachten op en bespreken naar `wachten-op.md`.

### Inloggen en de auth-bibliotheek

De app-rol heeft geen open SELECT op `users` of `sessions`, mag van zijn eigen gebruikersrij alleen `name` wijzigen
(geen rol, e-mail of blokkade) en zijn eigen sessies alleen lezen, wissen en via `auth_revoke_own_session(id)` intrekken
(0013; geen nieuwe sessie, geen verloopdatum, nooit terug naar geldig).
Een auth-bibliotheek (Better Auth of Auth.js, stuk E1) gebruikt in zijn adapter deze SECURITY DEFINER-functies
(eigenaar: de migratierol; vast `search_path`; `EXECUTE` sinds 0011 **alleen voor `hz_auth`**, niet meer voor
`hz_app`). Aanroepen via de verbinding van `createAuthDb(HZ_AUTH_DATABASE_URL)` in een transactie als `hz_auth`
(`withAuth(db, …)`; de TS-functies hieronder doen dat zelf). Met de api-login geven ze `permission denied` (42501):

| Functie | Doet | TS (`@hz/db`) |
|---|---|---|
| `auth_user_by_email(email)` | gebruiker bij precies één e-mailadres (hoofdletterongevoelig, geen patroon) | `findUserByEmail` |
| `auth_upsert_user(email, naam)` | aanmaken als hij niet bestaat, **altijd als `member`** en alleen als het domein in `auth_domains` staat (anders 42501); bestaande blijft ongewijzigd; auditregel. De server checkt daarnaast `email_verified`, `hd` en de allowlist | `upsertUser` |
| `auth_create_session(user_id, token_hash, user_agent, expires_at)` | sessie voor een bestaande, niet geblokkeerde gebruiker met een toegestaan domein; alleen sha256-hash (64 hex) van het token; auditregel | `createSession` |
| `auth_session_by_token(token_hash)` | de geldige sessie bij precies één hash (niet ingetrokken, niet verlopen, gebruiker niet geblokkeerd, domein nog toegestaan) | `findSession` |
| `auth_touch_session(token_hash, expires_at?)` | laatst gezien bijwerken, desgewenst verlengen (glijdende sessie, hoogstens 30 dagen na nu; verleden = fout) | `touchSession` |
| `auth_revoke_session(token_hash)` | uitloggen; auditregel | `revokeSession` |
| `auth_revoke_own_session(sessie_id)` | **voor `hz_app`** (0013), vanuit een request: een eigen, nog geldige sessie intrekken (uitloggen op een ander apparaat); auditregel. Een ingetrokken sessie wordt nooit weer geldig (trigger `sessions_guard`) | `revokeOwnSession` (binnen `runWithSession`) |
| `system_active_user_ids()` | worker: alleen de id's van actieve collega's; per id daarna `withUser`. **Alleen `hz_worker`** (0010). Een id kennen is sinds 0011 niet genoeg om iemand na te doen: voor de api-login telt `app.user_id` niet, alleen een geldige sessie | `activeUserIds` (als `hz_worker`, `withWorker`) |

`auth_create_session` kapt de verloopdatum ook op 30 dagen. Een bibliotheek met een langere standaardduur (Better
Auth: `session.expiresIn`) zet die op hoogstens 30 dagen; anders krijgt de sessie stil 30 dagen.

Admin word je alleen via een beheerscript als de migratierol: `psql "<migratie-url>" -v email=… -v role=admin -f
packages/db/sql/set-role.sql` (auditregel `user.role`). Een domein toevoegen: als de migratierol
`insert into auth_domains (domain) values ('…')`. Een request kan beide niet (test: `auth.test.ts`).

Voor een adapter (stuk E1): `findOne(session, token)` wordt `auth_session_by_token(sha256(token))`, `create(session)`
wordt `auth_create_session`, `update(session)` wordt `auth_touch_session`, `delete(session)` wordt
`auth_revoke_session` (een sessie verwijderen of terugzetten kan de adapter niet: ingetrokken blijft ingetrokken, 0013;
"andere apparaten uitloggen" vanuit de app is `auth_revoke_own_session`), `findOne(user, email)` en `create(user)`
worden `auth_user_by_email` en `auth_upsert_user`. De
adapter krijgt de verbinding van `createAuthDb()` (`hz_auth_login`), nooit die van de requests. De
sessie-middleware moet na het opzoeken van de sessie de rest van de request in `runWithSession(hashToken(token), …)`
draaien (in de api: `store.asSession(token, next)`); anders ziet de api-login niemand. Gebruikt de bibliotheek een
eigen sessietoken, dan is de hash daarvan wat in `sessions.token_hash` staat en wat `app.session` krijgt. Alles wat na
het inloggen gebeurt (eigen sessies tonen, eigen naam wijzigen) loopt gewoon via `withUser` en RLS. Heeft de bibliotheek extra
tabellen nodig (OAuth-accounts, verificatietokens), volg dan hetzelfde patroon: RLS op eigen rijen en een
SECURITY DEFINER-functie per opzoeksleutel, nooit een regel op `app.purpose`.

### Import uit het prototype

`pnpm --filter @hz/db import:prototype` (HZW-021) zet de artifact-opslag van het prototype over naar Postgres voor één
collega. Draait als `hz_app` met RLS namens die ene collega (`app.user_id`), in één transactie per deel. Sinds 0011
moet de login van `DATABASE_URL` daarvoor lid zijn van `hz_worker` (de worker-login; lokaal de migratierol); met de
api-login stopt het script met uitleg (exitcode 2) en maakt het niets aan. De collega opzoeken of aanmaken gaat als
`hz_auth` met `HZ_AUTH_DATABASE_URL` (auth-login; standaard `DATABASE_URL`). De gedeelde contextindex schrijft het als
`hz_indexer`: met `HZ_INDEX_DATABASE_URL` (indexer-login), of met `DATABASE_URL` als die login lid is van
`hz_indexer` (lokaal de migratierol). Zonder indexer-login slaat het de contextindex over en zegt dat in het verslag
(de indexjob vult hem ook zelf).

1. **Export maken (mens).** In Claude (met de artifact-tools) per collectie alle documenten van het prototype-artifact
   lezen en wegschrijven als `{"collections": {"commitments": {"<id>": {…}}, "itemstate": {…}, "briefings": {…}}}`
   in een map buiten de repo. Ook goed: een lijst `[{"id": …, "data": {…}}]` per collectie, of een map met per
   collectie een submap met `<id>.json` (zoals de contextexport). Nooit in Git.
2. **Proefdraai:** `DATABASE_URL=<worker-login> HZ_AUTH_DATABASE_URL=<auth-login> HZ_INDEX_DATABASE_URL=<indexer-login>
   pnpm --filter @hz/db import:prototype -- --export <pad> --email robert@homezero.nl --proef` rekent alles door,
   controleert de aantallen en draait terug. `<pad>` mag absoluut zijn of relatief aan de map waar je het commando
   typt (het script leest `INIT_CWD` van pnpm, want pnpm start het in `packages/db`). De collega wordt alleen
   opgezocht, nooit aangemaakt (geen gebruiker, geen auditregel). Bestaat hij nog niet, dan is alles voor hem nieuw: zijn tabellen worden uit de export berekend (het
   verslag zegt dat), de contextindex wordt echt doorgerekend en teruggedraaid.
3. **Echt:** zonder `--proef`. Exitcode 0 = aantallen kloppen, 1 = kloppen niet, 2 = fout in de invoer. `--json` geeft
   het verslag als JSON; `--zonder-context` slaat de contextindex over.

| Collectie | Naar | Sleutel (idempotent) |
|---|---|---|
| `commitments` stroom `weekdoel`, `roadmap` | `weekdoelen` (velden zonder kolom in `extra`) | `legacy_id` = doc-id |
| `commitments` stroom `mijn`, `voornemen`, `aan_mij`, `bespreken` (leeg = `mijn`) | `tracker_items` (`gtask` als `{id, tasklist}` of `'gtask:<id>'` -> kolom `gtask` = de taak-id, `tasklist` in `extra.gtask`; `src` -> `src_key`; `bron` met `key`; bewijsregel, week, outcome, checks, lastCheck in `extra`) | `legacy_id` = doc-id |
| `weekdoelen` (optioneel) | `weekdoelen` | `legacy_id` = `weekdoelen:<id>` |
| `itemstate` | `item_state` (read, processed, skipPrep, **handledBy** of answeredBy -> `answered_by`, plan, backlog, moved, at -> `updated_at`; rest in `extra`) | item-sleutel |
| `itemstate/_pins` | `pins` | zoekopdracht |
| `processed` (optioneel) | `item_state.processed` | item-sleutel |
| `briefings` | `briefings` (één per dag; de nieuwste wint; velden zonder kolom en een `sections` die niet in de vaste vorm past in `extra`) | dag |
| `context_partners`, `context_acties` | `context_index` (brief, meetings, acties; `geheim_voor` mee; nooit `admin.md`) | pad (`partners/<slug>/brief.md`, `…/meetings/<bestand>`, `…/acties.md#<id>`) |
| `context_status` | alleen gelezen: commit en exportdatum in het verslag en in `context_index.commit` | - |
| `context_persoonlijk` | overgeslagen: de app leest de Persoonlijk-repo live per collega | - |

Opnieuw draaien mag, ook met een nieuwere export. **De app wint**: de import zet niets terug wat de collega na een
eerdere import in de app deed.

- `weekdoelen` en `tracker_items`: in de app gewijzigd sinds de vorige import (`updated_at > imported_at`) = de import
  laat de rij staan, ook als de export die rij anders heeft. Niet gewijzigd in de app = bijwerken als de export
  verschilt (alleen de gewijzigde rijen), anders `ongewijzigd`.
- `item_state` en `briefings`: de nieuwste wint (`updated_at` uit de export tegen die in de app; `created_at`).
- In de app verwijderd na een eerdere import (`tracker_items`, `weekdoelen`, `pins`, `briefings`; de import onthoudt
  zijn sleutels in `import_keys`) = komt niet terug.
- Rijen die de app zelf maakte (zonder `legacy_id`) raakt de import nooit.

Het verslag telt per collectie docs = gebruikt + overgeslagen (met reden) en per tabel verwacht = nieuw + bijgewerkt +
ongewijzigd + `overgeslagen: in app gewijzigd` + `in app verwijderd`, en rijen na afloop = verwacht - in app
verwijderd. Het toont geen inhoud van toezeggingen of briefings. Een tweede run met dezelfde export geeft dus 0 nieuw
en 0 bijgewerkt; wat in de app is aangepast staat in de kolom `in app gewijzigd`.

**Niets gaat stil verloren.** `VELDEN` in `packages/db/src/import.ts` zegt per veld dat het prototype schrijft
(`commitAdd()`, elke `commitSave()` en `setState()` in `index.html`) of het in een kolom of in `extra` landt. Een
waarde die niet in zijn kolom past (een datum als "volgende week", een onbekende status, een gtask zonder id) blijft
met de oorspronkelijke waarde in `extra`, met een waarschuwing in het verslag. Ook een briefing heeft sinds migratie
0012 een `extra`: velden zonder kolom staan daar, en past `sections` niet volledig in de vaste vorm (titel, items met
tekst en url), dan staat het origineel in `extra.sections`. Toezeggingen die aan een Google Taak gekoppeld zijn (`gtask`, ook zonder
bruikbare id) zijn in de tracker verborgen zoals `commitVisible()` in het prototype: de taak staat al in Google Taken,
dus Robert ziet hem één keer.

**Contextindex opruimen.** Bij opnieuw importeren met een export die partners (en acties) bevat, haalt het script
rijen weg van bestanden die niet meer in de export staan (een verdwenen partner of meeting: `context_index_delete`
per pad) en van acties die uit `acties.md` verdwenen (`context_index_delete_id` per sleutel), als `hz_indexer`.
Alleen binnen de soorten die de export beschrijft en alleen op de paden die de import zelf maakt
(`partners|projecten/<slug>/brief.md`, `acties.md`, `meetings/*.md`); rijen van de indexjob (product, besluiten)
blijven. Zou meer dan de helft van die rijen verdwijnen (minstens 10 in scope), dan ruimt het niets op en waarschuwt;
met `--opruimen-forceren` wel. Het verslag noemt de weggehaalde paden en sleutels (geen inhoud).

Een geïmporteerd weekdoel houdt de item-sleutel uit het prototype, `cm:<doc-id>` (`Weekdoel.legacyId`), net als
tracker-items; leesstatus en planning uit `itemstate` blijven er dus aan hangen. `PATCH /api/weekdoelen/:id` gebruikt
het rij-id (`docId`).
Tests:
- `packages/db/test/import.test.ts`: synthetische export `test/fixtures/prototype-export.json`, opgebouwd uit de
  schrijfpaden van het prototype (gtask als object en als tekst, handledBy, itemToCommit met `src` en `bron.key`,
  een doorgeschoven en een meegenomen weekdoel, done/skip/until/recapSession/reacted in itemstate); o.a. een aangepast
  weekdoel en tracker-item blijven staan bij dezelfde en een nieuwere export, verwijderd blijft weg; de contextindex
  ruimt verdwenen partners, meetings en acties op; de opdrachtregel als worker- en auth-login met en zonder
  indexer-login, en als api-login geweigerd; een proefdraai laat het aantal gebruikers en auditregels gelijk; onbekende
  briefingvelden staan in `extra`.
- `packages/db/test/prototype-contract.test.ts`: leest `commitAdd`/`commitSave`/`setState` uit
  `workspace-prototype/index.html` (en welke collecties het schrijft) en eist dat elk veld in `VELDEN` staat en na
  `planImport` in zijn kolom of in `extra` zit. Plus `test/fixtures/prototype-recorded-export.json`: opgenomen uit het
  prototype zelf met `node tools/bar/record-export.mjs` (commitAdd, planCommit, de knop In Google Taken,
  itemToCommit, setState, setPins); opnieuw opnemen na een nieuwe versie van het prototype.
- `apps/api/test/import.test.ts`: na de import ziet Robert zijn tracker terug in de API, met `cm:dg1`; gekoppelde
  taken staan er niet dubbel in; handledBy maakt een Slack-item beantwoord; PATCH op een weekdoel overleeft opnieuw
  importeren; een collega ziet niets. De API draait daar als `hz_app_login` en `hz_auth_login`: buiten een sessie of
  binnen de sessie van een ander ziet de store niets van Robert, en na uitloggen werkt het oude token niet meer.

### Worker

pg-boss draait in een eigen schema (`pgboss`, of `HZ_BOSS_SCHEMA`) met een eigen verbinding: `HZ_BOSS_DATABASE_URL`
(productie verplicht; de login `hz_boss` uit `sql/boss-login.sql`, eigenaar van alleen dat schema, nergens lid van;
lokaal valt hij terug op `DATABASE_URL`). In `NODE_ENV=production` weigert de worker te starten als die login
eigenaar is van iets buiten het pg-boss-schema (dus nooit de migratierol: dan stond de credential van de
tabeleigenaar in het worker-proces), superuser of BYPASSRLS is (`UnsafeBossLoginError`, `assertBossLogin` hergebruikt
`checkAppLogin` met een uitzondering voor dat schema), of als `DATABASE_URL` en `HZ_BOSS_DATABASE_URL` gelijk zijn.
App-tabellen gaan via `createDb(DATABASE_URL, …, { allowRoles: ['hz_worker'] })` als `hz_app` (productie: de
worker-login `hz_worker_login` uit `sql/worker-login.sql`, ook gecontroleerd); jobs per collega gebruiken
`activeUserIds()` (als `hz_worker`) en daarna `withUser`. `hz_app` heeft geen rechten op het pg-boss-schema.
`boss-login.sql` geeft `hz_boss` ook CREATE op de database, omdat pg-boss bij elke start `CREATE SCHEMA IF NOT EXISTS`
draait (Postgres controleert dat recht ook als het schema al bestaat). Test: `apps/worker/test/app-db.test.ts`
(draait met `NODE_ENV=production`, pg-boss als `hz_boss`, jobs als `hz_worker_login`; de migratierol als
pg-boss-login wordt geweigerd; de api-login kan `system_active_user_ids()` niet uitvoeren, ook niet met app.purpose;
`createDb()` weigert in productie de worker-login voor de api).

## CI

De git-root is de map boven `workspace-app`, dus de workflow staat in `../.github/workflows/workspace-app.yml` (met
`defaults.run.working-directory: workspace-app` en pnpm uit `package.json`). De Postgres-service draait met superuser
`postgres`; een stap maakt `hz_dev` aan zonder SUPERUSER en draait `bootstrap-roles.sql`, `app-login.sql`,
`indexer-login.sql`, `worker-login.sql` en `boss-login.sql`. `packages/db/test/ci.test.ts` bewaakt dat.

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
  bar/        screenshots van de lat (prototype met nep-window.claude); record-export.mjs neemt een export op uit
              de echte schrijfpaden van het prototype (fixture voor de import)
  shot/       screenshots van onze app (start zelf api en web op 8790/8791)
  compare.mjs lat en onze app naast elkaar, desgewenst blind
e2e/          Playwright-tests (schil, Dagstart, toetsenbord, axe, 400 px)
```

## Hosting en uitrol

Eén Hetzner Cloud-server (CX32) met Docker Compose en Caddy, uitgerold door GitHub Actions: test bij elke merge naar
`main`, productie bij een goedgekeurde release, een preview per pull request, nachtelijke versleutelde back-ups naar
een Storage Box met maandelijkse hersteltest. Alles staat als code in `infra/` (stuk E0): uitleg en de keuze voor
Compose + Caddy in [`infra/README.md`](infra/README.md), beheer in [`infra/RUNBOOK.md`](infra/RUNBOOK.md).

```bash
pnpm --filter @hz/infra test     # infra-tests (schema's, scripts, back-up en verhuizing tegen de lokale Postgres)
bash infra/scripts/validate.sh   # shellcheck, actionlint, caddy validate, compose config
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

## Inloggen, sessies en koppelingen (stuk E1)

- **Inloggen** met Google (OIDC) via Auth.js (`@auth/core`, `apps/api/src/auth/authjs.ts`) met een eigen adapter op
  `users`/`sessions` (alleen een sha256 van het token). Alleen naam en e-mail; de server eist e-mail in het domein,
  `hd`, `email_verified` en de uitnodigingslijst (tabel `allowlist`, `HZ_ALLOWLIST`). Beheerder ben je via de
  uitnodigingslijst met rol `admin` (`robert@homezero.nl` staat er vast op; meer via Instellingen → Team of
  `packages/db/sql/e1-beheerder.sql` als de migratierol). `HZ_ADMIN_EMAILS` geldt alleen voor de geheugenopslag:
  met Postgres kan geen request zichzelf beheerder maken. Anders `/login?fout=…` met een nette weigerpagina. Eerste login: profiel en `/welkom`.
  Keuze Auth.js boven Better Auth (open vraag S3): de kleine adapter houdt de sessies op de fundamenttabellen.
- **Sessies**: cookie `hz_session` HttpOnly, SameSite=Lax, Secure in productie; 30 dagen, hooguit eens per dag
  verlengd; een cookie in een andere browser of op een ander systeem (user-agent zonder versienummers) trekt de
  sessie meteen in. Uitloggen per apparaat of overal (Instellingen → Apparaten). Verzoeken die iets wijzigen
  moeten van de eigen site komen (Origin-controle). De dev-login-stub alleen buiten productie.
- **Koppelingen** per bron met eigen toestemming (`apps/api/src/auth/oauth.ts`): state en PKCE in `connect_flows`,
  tokens envelope-versleuteld in `connections`, nooit naar de browser. Een bron met een OAuth-flow levert alleen data
  als hij gekoppeld is (`sourceReadable` in `apps/api/src/services.ts`): een nieuwe collega ziet niets tot hij
  koppelt. Intrekken trekt het token in bij Google, Slack of GitHub (Atlassian heeft geen intrek-API) en wist de
  eigen data van die bron (itemstate, agenda-instellingen; bij GitHub ook de Persoonlijk-data in Dagstart en Tracker).
  Google trekt per app (client) en gebruiker in: Taken, Agenda en Gmail delen de client, dus het intrek-endpoint
  wordt pas bij de laatste Google-bron aangeroepen; daarvoor wordt alleen het token gewist (`keptFor` in het antwoord).
- **Lokaal en in tests** tegen de nep-autorisatieserver `packages/fake-oauth` (Google-uitgever met testaccounts,
  Slack, Atlassian, GitHub). E2e start die vanzelf met een tweede API (zie `e2e/e1-env.ts`).
- Schermen: `/login`, `/welkom` (wizard, `g w`), `/instellingen/{koppelingen,apparaten,team}` (`g i`), ook via ⌘K.
- Migratie `0014_e1_auth.sql`: `allowlist`, `auth_accounts`, `connect_flows`, `onboarding` met RLS, zonder
  GUC-doelen. Inloggen en beheer via SECURITY DEFINER-functies: `auth_allowlist_role`, `auth_apply_allowlist_role`,
  `auth_account_lookup`, `auth_link_account`, `auth_audit_refusal` en `admin_members_list`, `admin_allowlist_list`,
  `admin_set_user_blocked`, `admin_allowlist_add/remove` (die controleren zelf of `app_user_id()` een niet-geblokkeerde
  beheerder is, anders 42501). Users en sessies via de functies van stuk E2 (`auth_session_by_token` enz.).
- Migratie `0015_e1_auth_roles.sql` (samenvoegen met E2): de inlogfuncties van E1 zijn alleen voor `hz_auth`, net als
  die van E2 sinds 0011. `DbAuthStore` krijgt twee verbindingen: de api-login (`hz_app`, alles per collega binnen de
  request-sessie) en de auth-login (`HZ_AUTH_DATABASE_URL`, `hz_auth`: inloggen, sessies, uitnodigingslijst). Nieuw
  voor `hz_auth`: `auth_user_by_id`, `auth_init_onboarding` (onboarding-rij bij de eerste login) en `auth_audit_event`
  (auditregel over inloggen en sessies buiten een request); voor `hz_app`: `auth_revoke_all_own_sessions` (overal
  uitloggen; `hz_app` heeft sinds 0013 geen UPDATE op `sessions`). Eén sessie op een ander apparaat intrekken loopt via
  E2's `auth_revoke_own_session`.

## Koppelingen en sync (stuk E3)

Live-implementaties per bron in `packages/providers/src/live/`, aan met `HZ_LIVE_<BRON>=1` (zie `.env.example`).
Zonder koppeling gooien ze `NotConnectedError`; tests draaien op opgenomen, synthetische antwoorden (msw), nooit op
echte endpoints.

| Bron | Bestand | Wat |
|---|---|---|
| Google Agenda | `google-calendar.ts` | alle agenda's (ook gedeelde privé en Lou), incrementele sync met `syncToken` (410 -> volledig), reageren, vrije tijden, afspraak maken (wandklok + `timeZone`), push via `events.watch` |
| Google Taken | `google-tasks.ts` | meerdere lijsten, toevoegen, datum, afvinken, Backlog-lijst (`tasks.move`), pollen met `updatedMin` |
| Gmail | `gmail.ts` | threads, volledige thread (datum uit de Date-header), gelezen/ongelezen (terug te draaien), antwoord als **concept** in Gmail (nooit versturen), `history.list` en Pub/Sub |
| Slack | `slack.ts` | kanalen, DM's, threads, zoeken, echte gelezen-status (`last_read`, `conversations.mark` tot het gelezen bericht; gelezen elders via de poll, `*_marked` is alleen RTM), reacties, eigen emoji |
| Jira | `jira.ts` | lopende sprint van HOM, storypoints, Tester; contextlaag eerst (`product/jira/`), daarna alleen `updated >= vorige sync`; per issue `source` laag/live |
| Wispr | `wispr.ts` | meetings uit de laag plus live (MCP) alleen na de laatste nachtrun (`_systeem/routines/<voornaam>.md`) |
| GitHub | `github.ts` | contextlaag en Persoonlijk-repo lezen via git trees/blobs, alleen gewijzigde bestanden, nooit `admin.md` |
| Slack-to-do's | `slack-todos.ts` | spike HZW-037 achter `HZ_SLACK_TODOS=1`, zie `docs/spike-slack-todos.md` |

- **Tokens**: `live/tokens.ts` laadt het token van de collega (`withUserScope`), ververst het op de server en slaat
  het versleuteld op (`dbTokenStore` in `@hz/db`). Ontkoppelen trekt het in (`live/revoke.ts`) en wist token en sync-data.
- **Versturen alleen na een klik**: `postMessage`, `react`, `createEvent` en `respond` werken alleen binnen de
  verstuur-routes `sendMessage`, `react`, `createEvent` en `rsvp` van een ingelogde collega (`HUMAN_ACTION_ROUTES` in
  `apps/api/src/app.ts` zet `withHumanAction`). Elke andere POST (ook `/api/ask` of een MCP-aanroep) krijgt een 403
  als hij toch iets probeert te versturen. De worker en Claude kunnen het niet. Gmail maakt alleen concepten.
- **Slack-gelezen-status**: `conversations.mark` zet de leescursor in Slack precies op het gekozen bericht (gelezen én
  ongelezen) en de app neemt die cursor direct over. Gelezen op een ander apparaat: de Events API heeft geen
  `*_marked`, dus de worker pollt elke 3 minuten `conversations.info` voor wat bij ons ongelezen staat, buiten de
  cache om (`pollReadState`). Met Events haalt die poll geen geschiedenis op (nieuwe berichten komen via events),
  zonder Events ook de verouderde standen. Budget per run: `HZ_SLACK_POLL_BUDGET` (standaard 40 calls); een verzoek
  van de browser haalt hooguit 20 standen op. Een rate limit gaat door naar de worker (terugval), nooit "gelezen".
- **Slack-app-manifest**: `infra/slack/manifest.yml` (user-scopes, events, request-URL, redirect-URL als placeholder);
  `slack-manifest.test.ts` houdt het gelijk met de code.
- **Sync-motor** (`apps/worker/src/sync.ts`, `sync-db.ts`): planner elke minuut (pg-boss), één run per collega en
  bron (`singletonKey`), terugval bij rate limits (`Retry-After`) en fouten, `needs_reauth` bij een afgewezen token.
  Webhooks (`/api/hooks/slack`, `/api/hooks/google/calendar`, `/api/hooks/google/gmail`) worden gecontroleerd,
  ontdubbeld (`sync_events`; Slack per `event_id:collega`) en zetten een run klaar (`NOTIFY hz_sync`). Nieuwe data: `NOTIFY hz_events` -> SSE
  `invalidate`. Stand per bron: `GET /api/sync/status`, nu bijwerken: `POST /api/sync/:provider`.
- **Database**: `drizzle/0016_e3_sync.sql` (`sync_state`, `sync_jobs`, `sync_events`, alle drie onder RLS) en
  `drizzle/0017_e3_sync_roles.sql` (samenvoegen met E2): planning en events van alle collega's (`app.purpose = 'system'`)
  alleen voor een login die lid is van `hz_worker` (de worker), niet voor de api-login; webhooks in de api lopen via
  SECURITY DEFINER-functies die precies één ding doen (`sync_hook_*`: collega bij een account of kanaal opzoeken, event
  ontdubbelen, run naar voren halen). De lijst met collega's voor de planner komt uit `activeUserIds()` (E2, `hz_worker`).
- **Ontkoppelen** (samen met E1): de route van E1 trekt eigen tokens in (Google pas bij de laatste Google-bron); hangt
  de bron op de gedeelde Google-koppeling `google`, dan trekt `disconnectSource` die in. Daarna wist de route planning,
  cursors en events van die bron (`wipeSyncData`).
- **Starten met live bronnen** (na de mens-stappen in `HUMAN_INPUT.md`):
  `HZ_STORE=db HZ_TOKEN_KEY=… HZ_LIVE_TASKS=1 … pnpm dev -- --worker`.
- **Tests met eigen databases**: `HZ_TEST_DATABASE_URL_SYNC` (standaard `hz_e3_test_sync`) en
  `HZ_TEST_DATABASE_URL_HOOKS` (standaard `hz_e3_test_hooks`).

## Status van dit stuk

Gebouwd en getest: zie de tests per pakket en `e2e/`. Bewust nog niet: echte OAuth en Google-inloggen, echte
API-koppelingen, schermen verder dan Dagstart en de schil (Planning, Agenda, Tracker, Gesprekken, Zoeken en de
partnerpagina zijn lege schermen met route, kop en toetsen), hosting. Wat een mens moet doen staat in `HUMAN_INPUT.md`.
