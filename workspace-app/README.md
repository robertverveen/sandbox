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
| `pnpm test` | vitest in elk pakket (database-tests maken eigen, verse databases `hz_fundament_test_*`) |
| `pnpm test:e2e` | Playwright tegen de echte app (eigen poorten 8780/8781) |
| `pnpm lint`, `pnpm format` | ESLint en Prettier |
| `pnpm db:migrate` | migraties op `hz_fundament` (of `DATABASE_URL`) |
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

Twee rollen (HZW-020):

| Rol | Wat | Rechten |
|---|---|---|
| `hz_dev` (migratierol; productie: eigen migratie-login) | draait `pnpm db:migrate`, eigenaar van alle tabellen | LOGIN, CREATEDB, geen superuser, geen BYPASSRLS |
| `hz_app` (runtime-rol) | waar elke app-query als draait | NOLOGIN, NOBYPASSRLS, eigenaar van niets; alleen SELECT/INSERT/UPDATE/DELETE |

- `packages/db/sql/bootstrap-roles.sql` (eenmalig, beheerder) maakt `hz_app` aan en maakt de migratierol er lid van.
  Migratie `0004_app_role.sql` weigert te draaien zonder die rol, verleent de rechten en zet default privileges.
- `createDb()` start elke verbinding als `hz_app` (`-c role=hz_app`); `withUser()`/`withPurpose()` doen daarbovenop per
  transactie `SET LOCAL ROLE hz_app` en `set_config('app.user_id', …, true)` (gelijk aan `SET LOCAL`). Alleen
  `runMigrations()` gebruikt `createOwnerDb()`.
- Elke tabel heeft `ENABLE` + `FORCE ROW LEVEL SECURITY`. Omdat `hz_app` geen eigenaar is, kan de app RLS niet uitzetten
  (`NO FORCE`, `DISABLE`, `DROP POLICY` geven `must be owner`) en ziet hij ook zonder FORCE alleen eigen rijen.
- Test: `packages/db/test/rls.test.ts` (A ziet nooit rijen van B; `current_user` is `hz_app` en geen `relowner` van een
  tabel; NO FORCE, DISABLE, DROP/ALTER/CREATE POLICY worden geweigerd; ook als de eigenaar FORCE uitzet blijft A blind
  voor B).

Tabellen en wie ze vult:

| Tabel | Gevuld door | Gelezen door |
|---|---|---|
| `users`, `sessions` | dev-login (straks het auth-stuk) | sessie-middleware |
| `connections` | koppelingen (tokens envelope-versleuteld) | providers via `readConnectionToken` |
| `item_state` | `PUT /api/itemstate/:key`: leesstatus, verwerkt en **de planning** (`plan_date`, `backlog`, `moved`; één plek) | Dagstart, Planning, Inhalen |
| `weekdoelen`, `briefings` | `/api/weekdoelen`, de MCP-server (briefing van de ochtendroutine) | Dagstart, Tracker |
| `pins` | `POST /api/pins` (⌘↵ in het palet) | palet, zijbalk (zoek-stuk) |
| `preferences` | `PATCH /api/preferences` (thema; per agenda kleur en overal/alleen in Agenda) | `/api/agenda`, schil |
| `repo_queue` | `POST /api/repo/queue`: regel volgens `_systeem/schema.md`, status `queued` | schrijfjob van het context-stuk (HZW-060/062: pull --rebase, contextcheck, push, status) |
| `context_index` | indexjob van het context-stuk (`upsertContextIndex`, `withPurpose('index')`, nooit `admin.md`) | zoek-stuk (`searchContextIndex`) |
| `audit_log` | gevoelige acties (inloggen, koppelen, versturen, in de rij zetten) | beheer |

## CI

De git-root is de map boven `workspace-app`, dus de workflow staat in `../.github/workflows/workspace-app.yml` (met
`defaults.run.working-directory: workspace-app` en pnpm uit `package.json`). De Postgres-service draait met superuser
`postgres`; een stap maakt `hz_dev` aan zonder SUPERUSER en draait `bootstrap-roles.sql`. `packages/db/test/ci.test.ts`
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

## Inloggen, sessies en koppelingen (stuk E1)

- **Inloggen** met Google (OIDC) via Auth.js (`@auth/core`, `apps/api/src/auth/authjs.ts`) met een eigen adapter op
  `users`/`sessions` (alleen een sha256 van het token). Alleen naam en e-mail; de server eist e-mail in het domein,
  `hd`, `email_verified` en de uitnodigingslijst (tabel `allowlist`, `HZ_ALLOWLIST`, vaste beheerders
  `HZ_ADMIN_EMAILS`). Anders `/login?fout=…` met een nette weigerpagina. Eerste login: profiel en `/welkom`.
  Keuze Auth.js boven Better Auth (open vraag S3): de kleine adapter houdt de sessies op de fundamenttabellen.
- **Sessies**: cookie `hz_session` HttpOnly, SameSite=Lax, Secure in productie; 30 dagen, hooguit eens per dag
  verlengd; een cookie in een andere browser of op een ander systeem (user-agent zonder versienummers) trekt de
  sessie meteen in. Uitloggen per apparaat of overal (Instellingen → Apparaten). Verzoeken die iets wijzigen
  moeten van de eigen site komen (Origin-controle). De dev-login-stub alleen buiten productie.
- **Koppelingen** per bron met eigen toestemming (`apps/api/src/auth/oauth.ts`): state en PKCE in `connect_flows`,
  tokens envelope-versleuteld in `connections`, nooit naar de browser. Intrekken trekt het token in bij Google,
  Slack of GitHub (Atlassian heeft geen intrek-API) en wist de eigen data van die bron (itemstate, agenda-instellingen).
- **Lokaal en in tests** tegen de nep-autorisatieserver `packages/fake-oauth` (Google-uitgever met testaccounts,
  Slack, Atlassian, GitHub). E2e start die vanzelf met een tweede API (zie `e2e/e1-env.ts`).
- Schermen: `/login`, `/welkom` (wizard, `g w`), `/instellingen/{koppelingen,apparaten,team}` (`g i`), ook via ⌘K.
- Migratie `0005_e1_auth.sql`: `allowlist`, `auth_accounts`, `connect_flows`, `onboarding` met RLS, plus purpose
  `admin` (alleen via `withAdmin()`, na controle van de rol in dezelfde transactie).

## Status van dit stuk

Gebouwd en getest: zie de tests per pakket en `e2e/`. Bewust nog niet: echte OAuth en Google-inloggen, echte
API-koppelingen, schermen verder dan Dagstart en de schil (Planning, Agenda, Tracker, Gesprekken, Zoeken en de
partnerpagina zijn lege schermen met route, kop en toetsen), hosting. Wat een mens moet doen staat in `HUMAN_INPUT.md`.
