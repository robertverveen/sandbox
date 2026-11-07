# Runbook HomeZero Workspace

Voor wie de server beheert (mens of Claude met een mens die serverwijzigingen goedkeurt). Kort en in volgorde.
Achtergrond en keuzes: [`README.md`](README.md). Doel (plaat, keuze 14): maximaal 24 uur dataverlies, binnen 4 uur
weer op.

Afspraken: `<IP>` is het IPv4-adres van de server, `hz` de beheerdersgebruiker (sudo, docker). Productie heet
`hz-prod`, test `hz-test`, previews `hz-pr-<nr>`. Containers: `hz-prod-api-1`, `hz-prod-db-1` enzovoort.

## 1. Waar kijk ik? (eerste vijf minuten)

| Vraag | Waar |
|---|---|
| Draait het? | `https://<domein>/api/health` (`"ok":true,"db":"ok"`); uptime-dienst (healthchecks.io), check `workspace` |
| Wat draait er? | GitHub, workflow `workspace-deploy`, laatste run; of `ssh deploy@<IP> status` vanuit een CI-run |
| Welke containers zijn ziek? | `ssh hz@<IP> docker ps --format '{{.Names}}\t{{.Status}}'` |
| Logs (JSON, zonder persoonsgegevens) | `docker logs hz-prod-api-1 --since 1h`, idem `-worker-1`, `hz-edge-caddy-1` |
| Fouten met stacktrace | GlitchTip: `https://<fouten-domein>`, project `workspace` |
| Uitrolgeschiedenis | `/var/log/hz/deploys.log` (tijd, omgeving, tag, vorige, ok/mislukt/teruggezet) |
| Back-ups en hersteltests | `/var/log/hz/hersteltest.log`; `journalctl -u hz-backup -u hz-hersteltest --since -2d` |
| Server zelf | workflow `workspace-server-check` (issue met label `servercontrole`) |

## 2. Nieuwe server (eerste keer, of een tweede server bij een verhuizing)

1. **CI-sleutel** (eenmalig): `ssh-keygen -t ed25519 -N '' -C hz-deploy -f hz_deploy`. De privésleutel gaat als
   GitHub-secret `HZ_DEPLOY_SSH_KEY`, daarna weg van de laptop.
2. **Cloud-init**:
   ```bash
   node infra/cloud-init/render.mjs --domain homezero.verveen.me --test-domain test.homezero.verveen.me \
     --acme-email robert@homezero.nl --registry ghcr.io/homezerotech \
     --admin-keys ~/.ssh/id_ed25519.pub --deploy-key hz_deploy.pub --out user-data.yaml
   ```
3. **Server**: `HCLOUD_TOKEN=… infra/scripts/hetzner-create.sh --user-data user-data.yaml --ssh-key ~/.ssh/id_ed25519.pub --dry-run`,
   controleren, en dan zonder `--dry-run`. Het script print IPv4 en IPv6.
4. **DNS** (A en AAAA naar de server): `homezero.verveen.me`, `test.homezero.verveen.me`, `*.test.homezero.verveen.me`,
   `fouten.homezero.verveen.me`. Ander domein? Alleen andere waarden in stap 2 en hier.
5. **Sleutels van de server** (na ~5 minuten): `ssh hz@<IP> sudo cat /var/log/hz/sleutels.txt`.
   - age-sleutel: regel erbij in `infra/secrets/recipients.txt`, dan
     `infra/scripts/secrets.sh rekey prod && infra/scripts/secrets.sh rekey test && infra/scripts/secrets.sh rekey server`, PR, merge.
   - Storage Box-sleutel: zie §6, "Storage Box koppelen".
6. **GitHub** (repo, Settings): Variables `HZ_DEPLOY_HOST=<IP>`, `HZ_DOMAIN`, `HZ_TEST_DOMAIN`; Secret
   `HZ_DEPLOY_KNOWN_HOSTS` = uitvoer van `ssh-keyscan -t ed25519 <IP>`; Environments `test`, `preview` en `production`
   (production: required reviewer). Packages `hz-api`, `hz-worker`, `hz-web`: Manage Actions access, deze repo, Read
   (na de eerste build).
7. **Eerste uitrol**: Actions, `workspace-deploy`, Run workflow, omgeving `test`. Groen = health-check en TLS goed.
8. **Controle**: Actions, `workspace-server-check`, Run workflow. Het issue `servercontrole` moet alles groen tonen.

## 3. Uitrollen

- **Test**: elke merge naar `main` met wijzigingen in `workspace-app/` bouwt de images (`sha-<commit>`) en rolt ze uit
  naar test. Niets te doen.
- **Productie**: GitHub, Releases, nieuwe release `vX.Y.Z` op een commit die al op test stond, Publish. De workflow
  zet de releasetag op dezelfde images en wacht op goedkeuring: Review deployments, `production`, Approve (één klik).
  Vóór de migraties maakt de server een back-up (`pre-deploy`).
- **Wat gebeurt er op de server**: `deploy.sh` ontsleutelt de secrets naar `/run/hz` (tmpfs), controleert de
  verplichte sleutels, werkt de edge bij (herladen zonder onderbreking), draait migraties, vervangt de containers,
  wacht tot ze gezond zijn en doet een health-check via https. Mislukt dat, dan gaat de vorige versie terug.
- **Terugzetten**: Actions, `workspace-deploy`, Run workflow, omgeving en de vorige tag (zie `deploys.log`). Of vanuit
  een CI-run `ssh deploy@<IP> rollback prod` (de bundel van de vorige versie staat nog op de server).
- **Migraties gaan alleen vooruit.** Schrijf ze uitbreidend: eerst kolom of tabel erbij (oude code blijft werken),
  pas een release later iets weghalen. Dan is terugzetten van de code altijd veilig. Moet de database zelf terug:
  §6, "Echt herstel".

## 4. Preview per pull request

- Een PR (niet uit een fork) met wijzigingen in `workspace-app/` krijgt `https://pr-<nr>.test.homezero.verveen.me`,
  met een eigen database, op demodata, achter het previewwachtwoord (teamkluis, "Workspace preview"). De link komt
  als commentaar in de PR.
- PR gesloten of gemerged: de preview gaat weg (containers, database, certificaat-aanmelding) en de PR-images uit de
  registry.
- Maximaal 5 tegelijk (`HZ_PREVIEW_MAX`); de oudste gaat eruit.
- Handmatig opruimen: `ssh deploy@<IP> preview down <nr>` (vanuit een CI-run), of op de server
  `sudo -u deploy /opt/hz/env/test/bundle/infra/scripts/preview.sh down <nr>`.
- Previewwachtwoord wijzigen: `docker run --rm caddy:2.10.2-alpine caddy hash-password` en de hash met
  `printf '%s\n' '<hash>' | infra/scripts/secrets.sh set server HZ_PREVIEW_HASH`, PR, merge, uitrol test.

## 5. Secrets

- Staan versleuteld in `infra/secrets/<omgeving>.env.age` (age), te openen door de server en de beheerders in
  `recipients.txt`. `<omgeving>.keys` zegt welke sleutels er moeten zijn en wie ze levert.
- **Zetten of wijzigen** (de waarde via stdin, nooit als argument):
  `printf '%s\n' '<waarde>' | infra/scripts/secrets.sh set prod HZ_GOOGLE_CLIENT_SECRET`, dan
  `infra/scripts/secrets.sh check prod`, PR, merge, uitrol. Machine-geheimen (databasewachtwoorden, `HZ_TOKEN_KEY`,
  `HZ_AUTH_SECRET`): `infra/scripts/secrets.sh gen prod`.
- **Nieuwe beheerder**: `infra/scripts/secrets.sh keygen ~/.config/hz/age.key`, publieke sleutel in `recipients.txt`,
  een bestaande beheerder draait `rekey` voor prod, test en server.
- **Beheerder weg of laptop kwijt**: regel uit `recipients.txt`, `rekey` voor prod, test en server, en wissel de
  waarden die die persoon kon zien. Machine-geheimen: `secrets.sh unset prod HZ_PG_APP_PASSWORD` (enzovoort) en
  `secrets.sh gen prod`; de rest met `set`. PR, merge, uitrol: `deploy.sh` zet bij elke uitrol de databaserollen en
  -wachtwoorden opnieuw gelijk met de secrets (`hz-roles.sh` in de db-container, idempotent).
- **`HZ_TOKEN_KEY` uitgelekt**: de app kan de hoofdsleutel nog niet roteren. Nieuwe sleutel zetten en alle koppelingen
  laten verbreken (collega's koppelen opnieuw); open punt voor het koppelingen-stuk.
- Een ontbrekende verplichte sleutel stopt de uitrol vóór er iets verandert; de API weigert in productie te starten
  zonder `DATABASE_URL`, een geldige `HZ_TOKEN_KEY` en `HZ_STORE=db`, en met `HZ_DEV_LOGIN=1`.

## 6. Back-ups en herstel

- **Nachtelijk 02:30** (`hz-backup.timer`): `pg_dump` als `hz_backup`, meteen versleuteld met age (server en
  beheerders), naar de Storage Box met controlesom. 30 dagen bewaard; de 7 nieuwste blijven altijd. Ook vóór elke
  productie-uitrol. Ping naar de uptime-check `back-up`; geen ping binnen een dag = melding.
- **Hersteltest** (eerste zondag van de maand, 04:30, `hz-hersteltest.timer`): de nieuwste back-up in een lege
  database, rijen per tabel tellen tegen wat in de back-up staat. Uitkomst in `/var/log/hz/hersteltest.log` en ping
  naar de check `hersteltest`. Handmatig: `ssh hz@<IP> sudo -u deploy /opt/hz/bin/hz-run hersteltest.sh`.
- **Handmatige back-up**: `ssh hz@<IP> sudo -u deploy /opt/hz/bin/hz-run backup.sh --label handmatig`.
- **Storage Box koppelen** (eenmalig): Storage Box (BX11) met sub-account, map `hz`, SSH aan. De publieke sleutel uit
  `sleutels.txt` (regel "Storage Box") bij het sub-account zetten. Dan
  `printf '%s\n' 'sftp://<sub-account>@<box>.your-storagebox.de:23/hz' | infra/scripts/secrets.sh set server HZ_BACKUP_TARGET`,
  PR, merge, uitrol, en één handmatige back-up plus hersteltest.
- **Echt herstel** (database kapot of foute migratie):
  1. App stilzetten: `docker stop hz-prod-web-1 hz-prod-api-1 hz-prod-worker-1`.
  2. Herstellen in een nieuwe database naast de oude:
     `sudo -u deploy /opt/hz/bin/hz-run restore.sh latest hz_herstel --create --role hz_migrator`
     (of een bestandsnaam in plaats van `latest`; lijst: `ls` op de Storage Box via `sftp`).
  3. Omwisselen: `docker exec hz-prod-db-1 psql -U postgres -c 'ALTER DATABASE hz RENAME TO hz_oud' -c 'ALTER DATABASE hz_herstel RENAME TO hz'`.
  4. Starten: `docker start hz-prod-api-1 hz-prod-worker-1 hz-prod-web-1`, dan `curl https://<domein>/api/health`.
  5. Is alles goed, dan na een week `DROP DATABASE hz_oud`.
- Wat er níet in de back-up hoeft: mail, Slack, taken en de contextlaag (die staan bij Google, Slack en GitHub).

## 7. Monitoring en meldingen

- **Hartslag** (elke 5 min, `hz-heartbeat.timer`): health via https, geen container `unhealthy`, schijf onder 85 %.
  Goed = ping; mis = `/fail` met de reden. Ligt de hele server plat, dan komt er geen ping en meldt de uptime-dienst
  het na 10 minuten aan Robert.
- **Foutregistratie**: api en worker sturen onverwachte fouten (geschoond: geen e-mail, IP of tokens) naar GlitchTip
  (`HZ_ERROR_DSN`). Testfout: `docker exec hz-prod-api-1 node dist/ops-cli.js test-error`.
- **GlitchTip eerste keer**: `docker exec -it hz-ops-glitchtip-1 ./manage.py createsuperuser`, inloggen op
  `https://<fouten-domein>`, organisatie en project `workspace`, DSN in `prod.keys` zetten (`HZ_ERROR_DSN`), en een
  alert naar Robert (mail of webhook).
- **Logs** zijn JSON-regels zonder persoonsgegevens (geen IP, user-agent, querystring of e-mail); Docker roteert ze
  (10 MB x 5 per container).

## 8. Plat: wat nu?

1. Health en `docker ps` (§1). Eén container ziek: `docker logs <naam> --since 30m`, daarna `docker restart <naam>`.
2. Net uitgerold? Terugzetten (§3).
3. Database start niet: `docker logs hz-prod-db-1`; schijf vol? `df -h`, `docker system prune -af --filter until=168h`.
4. Certificaat: `infra/scripts/tls-check.sh <domein>`; logs van `hz-edge-caddy-1` (Let's Encrypt-limieten, DNS).
5. Server onbereikbaar: Hetzner Console, server, Power cycle; daarna §1. Kapot: nieuwe server (§2) en herstel (§6).
6. Schrijf achteraf in de PR of het issue wat er gebeurde en wat de oplossing was.

## 9. Onderhoud

- Ubuntu-beveiligingsupdates gaan automatisch; herstart om 04:00 als het moet (containers komen vanzelf terug).
- Basisimages en Actions: Dependabot opent PR's (wekelijks). Postgres-, Caddy- en GlitchTip-tags in `compose/` met de
  hand bijwerken (patchversies), via een PR en eerst op test.
- Postgres naar een nieuwe hoofdversie: back-up (§6), nieuwe tag in `compose/app.yaml`, nieuw volume, herstel met
  `restore.sh`. Oefen dit eerst met de proefverhuizing (§10).
- Elk kwartaal: workflow `workspace-server-check` handmatig, en de hersteltest-log nalopen.

## 10. Verhuizen (HZW-082)

Zelfde code, andere waarden. Proef lokaal: `infra/test/image.test.ts` (back-up, nieuwe database met rollen, herstel
met rechten, zelfde rijen, API groen op een ander domein). Echte proef of verhuizing:

1. Nieuwe server met het nieuwe (of een tijdelijk) domein: §2, stap 2-5. Ook `--hostname hz-workspace-2`.
2. Oude server: app stilzetten (`docker stop hz-prod-web-1 hz-prod-api-1 hz-prod-worker-1`) en
   `sudo -u deploy /opt/hz/bin/hz-run backup.sh --label verhuizing`.
3. Nieuwe server: eerste uitrol naar prod met dezelfde tag (Actions, Run workflow, omgeving `production`, tag),
   met `HZ_DEPLOY_HOST` op het nieuwe adres. Dan app stil, herstel uit de Storage Box (§6, "Echt herstel", stap 2-4).
4. DNS naar het nieuwe adres; `infra/scripts/tls-check.sh <domein>` groen; inloggen en Dagstart openen.
5. Oude server een week laten staan (uit), dan verwijderen.

Een ander domein vraagt ook: OAuth-redirect-URL's (Google, Slack, Atlassian, GitHub) en `HZ_PUBLIC_URL` volgen het
domein vanzelf; de OAuth-apps moeten de nieuwe URL's kennen (via Chrome, zie HUMAN_INPUT.md).
