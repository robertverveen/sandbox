# Runbook HomeZero Workspace

Voor wie de server beheert (mens of Claude met een mens die serverwijzigingen goedkeurt). Kort en in volgorde.
Achtergrond en keuzes: [`README.md`](README.md). Doel (plaat, keuze 14): maximaal 24 uur dataverlies, binnen 4 uur
weer op.

De workspace draait op **de bestaande Hetzner-server van Robert**, in zijn tailnet, naast andere projecten (plaat,
keuze 01, besloten 7 nov). Afspraken in dit runbook:

- `<server>` is de tailnet-naam van die server (MagicDNS, bv. `hetzner.tail1234.ts.net`) of zijn 100.x-adres.
  Beheer gaat alleen over het tailnet: `ssh <jij>@<server>`. Publiek staat alleen 443 open.
- Alles van de workspace heet `hz-workspace`: gebruiker `hz-workspace`, map `/srv/hz-workspace`, compose-projecten
  `hz-workspace-prod`, `hz-workspace-test`, `hz-workspace-pr-<nr>`, `hz-workspace-ops`, `hz-workspace-router`.
  Containers: `hz-workspace-prod-api-1`, `hz-workspace-prod-db-1` enzovoort.
- De andere projecten en hun proxy zijn niet van ons. We lezen hun configuratie (voorcheck) en voegen alleen ons
  eigen, gemarkeerde blok toe (`# >>> hz-workspace` ... `# <<< hz-workspace`).

## 1. Waar kijk ik? (eerste vijf minuten)

| Vraag | Waar |
|---|---|
| Draait het? | `https://<domein>/api/health` (`"ok":true,"db":"ok"`); uptime-dienst (healthchecks.io), check `workspace` |
| Wat draait er? | GitHub, workflow `workspace-deploy`, laatste run; op de server `cat /srv/hz-workspace/env/*/current` |
| Welke containers zijn ziek? | `ssh <jij>@<server> docker ps --filter label=nl.homezero.workspace=1 --format '{{.Names}}\t{{.Status}}'` |
| Logs (JSON, zonder persoonsgegevens) | `docker logs hz-workspace-prod-api-1 --since 1h`, idem `-worker-1`, `hz-workspace-router-router-1` |
| Fouten met stacktrace | GlitchTip: `https://<fouten-domein>`, project `workspace` |
| Uitrolgeschiedenis | `/srv/hz-workspace/log/deploys.log` (tijd, omgeving, tag, vorige, ok/mislukt/teruggezet) |
| Back-ups en hersteltests | `/srv/hz-workspace/log/hersteltest.log`; `journalctl -u hz-workspace-backup -u hz-workspace-hersteltest --since -2d` |
| Botst er iets met andere projecten? | `sudo -u hz-workspace /srv/hz-workspace/bin/hz-server-check --voorcheck` |
| Server zelf | workflow `workspace-server-check` (issue met label `servercontrole`) |

## 2. Op de bestaande server zetten (eerste keer)

Alles via Tailscale, vanaf een laptop in het tailnet met deze repo. Elke stap is eerst droog of alleen lezen.

1. **Voorcheck droog** (wijzigt niets). Bundel naar de server en de voorcheck draaien:
   ```bash
   scp -r workspace-app/infra <jij>@<server>:/tmp/hz-workspace-setup
   ssh <jij>@<server> sudo env HZ_DOMAIN=homezero.verveen.me HZ_TEST_DOMAIN=test.homezero.verveen.me \
     HZ_PROXY_KIND=caddy HZ_PROXY_NETWORK=<netwerk> HZ_PROXY_CONFIG=/etc/caddy \
     bash /tmp/hz-workspace-setup/scripts/server-check.sh
   ```
   De regel `voorcheck proxy` zegt welke proxy er op 443 draait, als container (met zijn netwerken) of op de host.
   Kies daarmee: Caddy in Docker -> `HZ_PROXY_KIND=caddy` en `HZ_PROXY_NETWORK=<een netwerk van die proxy>`;
   Caddy op de host -> `HZ_PROXY_KIND=caddy` en `HZ_ROUTER_PORT=<vrije poort, bv. 18780>` (zonder netwerk);
   Traefik of Coolify -> `HZ_PROXY_KIND=traefik` en het netwerk van Traefik (Coolify: `coolify`).
   `HZ_PROXY_CONFIG` wijst naar de configuratie van de proxy (map of bestand). Draai opnieuw tot alles OK is, op
   hooguit `WAARSCHUWING aangesloten` na (dat komt in stap 9). Rood bij een botsing: niets doen, eerst oplossen
   (bijv. een ander domein of een andere routerpoort).
2. **CI-sleutel** (eenmalig, op de laptop): `ssh-keygen -t ed25519 -N '' -C hz-workspace-ci -f hz_deploy`.
   De privésleutel gaat als GitHub-secret `HZ_DEPLOY_SSH_KEY` (stap 6), daarna weg van de laptop.
3. **Gebruiker, map, scripts, timers**: eerst droog, dan echt (stopt zelf als de voorcheck rood is):
   ```bash
   scp hz_deploy.pub <jij>@<server>:/tmp/hz-workspace-setup/
   ssh <jij>@<server> sudo bash /tmp/hz-workspace-setup/scripts/server-setup.sh \
     --domain homezero.verveen.me --acme-email robert@homezero.nl --registry ghcr.io/homezerotech \
     --proxy caddy --proxy-network <netwerk> --proxy-config /etc/caddy \
     --deploy-key /tmp/hz-workspace-setup/hz_deploy.pub --dry-run
   ```
   Klopt het, dan zonder `--dry-run`. Dat maakt gebruiker `hz-workspace`, `/srv/hz-workspace`, de vaste scripts,
   `hz.env`, de sudo-regel voor de servercontrole, de CI-sleutel (alleen `hz-ssh-dispatch`), de units
   `hz-workspace-*` en het netwerk `hz-workspace-net`. sshd, ufw, de proxy en de andere projecten blijven
   ongemoeid. Heeft sshd `AllowUsers`, dan meldt het script dat `hz-workspace` erbij moet; dat doet een mens.
   Daarna `rm -rf /tmp/hz-workspace-setup`.
4. **Sleutels van de server**: `ssh <jij>@<server> sudo cat /srv/hz-workspace/log/sleutels.txt`.
   - age-sleutel: regel erbij in `infra/secrets/recipients.txt`, dan
     `infra/scripts/secrets.sh rekey prod && infra/scripts/secrets.sh rekey test && infra/scripts/secrets.sh rekey server`, PR, merge.
   - Back-upsleutel: zie §6, "Back-updoel koppelen".
5. **Tailscale voor CI** (admin console van Roberts tailnet):
   - Access controls: het fragment uit `infra/tailscale/acl.hujson` samenvoegen (tag `tag:ci`, host `hz-server` met
     het tailnet-adres van de server, regel `tag:ci -> hz-server:22`, en de `tests`). Opslaan; Tailscale draait de
     tests en weigert een policy waarin `tag:ci` meer mag. Staat er nog `{"src": ["*"], "dst": ["*:*"]}`, vervang
     dan `"*"` in `src` door `"autogroup:member"`, anders mag `tag:ci` alles.
   - Settings, OAuth clients (of Trust credentials): nieuwe client met scope **Auth Keys: write** en tag `tag:ci`.
     Client-ID en geheim gaan als GitHub-secrets `TS_OAUTH_CLIENT_ID` en `TS_OAUTH_SECRET`. De action maakt per job
     een tijdelijke (ephemeral) node die na de job verdwijnt.
6. **GitHub** (repo, Settings): Variables `HZ_DEPLOY_HOST=<server>` (tailnet-naam; `ci-ssh.sh` weigert een publiek
   adres), `HZ_DOMAIN`, `HZ_TEST_DOMAIN`. Secrets `HZ_DEPLOY_SSH_KEY`, `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET` en
   `HZ_DEPLOY_KNOWN_HOSTS` = uitvoer van `ssh-keyscan -t ed25519 <server>` vanaf een apparaat in het tailnet (met
   precies de naam uit `HZ_DEPLOY_HOST`). Environments `test`, `preview` en `production` (production: required
   reviewer). Packages `hz-api`, `hz-worker`, `hz-web`: Manage Actions access, deze repo, Read (na de eerste build).
7. **DNS** (A en AAAA naar het publieke adres van de server, hetzelfde als de andere projecten):
   `homezero.verveen.me`, `test.homezero.verveen.me`, `*.test.homezero.verveen.me`, `fouten.homezero.verveen.me`.
8. **Secrets vullen**: `secrets.sh gen prod`, `gen test`, `gen server`, dan de waarden van mensen met `set` (zie
   `infra/secrets/*.keys`). Test heeft minstens het previewwachtwoord nodig (§4); productie ook het back-updoel (§6)
   en de hartslag (§7). `deploy.sh` noemt precies wat er nog ontbreekt en verandert dan niets.
9. **Eerste uitrol en aansluiten op de proxy**: Actions, `workspace-deploy`, Run workflow, omgeving `test`. De uitrol
   draait eerst de voorcheck, start de router en zet het site-blok in `/srv/hz-workspace/proxy`. Dan, eenmalig:
   - **Caddy**: in de Caddyfile van de proxy onderaan `import /srv/hz-workspace/proxy/hz-workspace.caddy` en in het
     globale blok `import /srv/hz-workspace/proxy/hz-workspace.global.caddy`. Draait Caddy in Docker: de map
     `/srv/hz-workspace/proxy` read-only mounten op hetzelfde pad (in de compose van de proxy; het opnieuw aanmaken
     van die container onderbreekt de andere sites een paar seconden: doe het op een rustig moment). Dan
     `caddy validate --config /etc/caddy/Caddyfile` en `caddy reload --config /etc/caddy/Caddyfile` (in Docker met
     `docker exec <proxy> ...`). Heeft de proxy al `on_demand_tls` (de voorcheck waarschuwt dan), voeg de `ask` dan
     samen: er kan er maar één zijn; zonder samenvoegen werken productie en test, previews niet.
   - **Traefik/Coolify**: niets aan Traefik. Controleer in `hz.env` `HZ_TRAEFIK_ENTRYPOINT` (Coolify: `https`) en
     `HZ_TRAEFIK_CERTRESOLVER` (Coolify: `letsencrypt`); previews vragen een resolver met DNS-challenge
     (`HZ_TRAEFIK_WILDCARD_RESOLVER`).
   Daarna de workflow opnieuw: groen = health-check en TLS goed.
10. **Controle**: `infra/scripts/tls-check.sh homezero.verveen.me test.homezero.verveen.me` (slotje, HSTS; poort 80
    van de proxy moet doorsturen of dicht zijn). Actions, `workspace-server-check`, Run workflow: het issue
    `servercontrole` toont alles groen (van buiten alleen 443 open en SSH dicht; van binnen tailnet, SSH, updates en
    de voorcheck).

## 3. Uitrollen

- **Test**: elke merge naar `main` met wijzigingen in `workspace-app/` bouwt de images (`sha-<commit>`) en rolt ze uit
  naar test. Niets te doen.
- **Productie**: GitHub, Releases, nieuwe release `vX.Y.Z` op een commit die al op test stond, Publish. De workflow
  zet de releasetag op dezelfde images en wacht op goedkeuring: Review deployments, `production`, Approve (één klik).
  Vóór de migraties maakt de server een back-up (`pre-deploy`).
- **Hoe de runner binnenkomt**: als tijdelijke Tailscale-node met `tag:ci`; `ci-ssh.sh` verbindt alleen met een
  tailnet-adres; op de server mag de sleutel alleen `hz-ssh-dispatch` (deploy, rollback, preview, status, check,
  voorcheck). Nooit publieke SSH.
- **Wat gebeurt er op de server**: `deploy.sh` draait de voorcheck (rood = stoppen, niets gewijzigd), ontsleutelt de
  secrets naar `/run/hz-workspace` (tmpfs), controleert de verplichte sleutels, werkt de router bij (herladen zonder
  onderbreking) en het site-blok, draait migraties, vervangt de containers, wacht tot ze gezond zijn en doet een
  health-check via https. Mislukt dat, dan gaat de vorige versie terug. De bestaande proxy herlaadt hij nooit zelf;
  verandert het site-blok (alleen bij een ander domein), dan zegt de log dat en volgt stap 9 van §2.
- **Terugzetten**: Actions, `workspace-deploy`, Run workflow, omgeving en de vorige tag (zie `deploys.log`).
- **Migraties gaan alleen vooruit.** Schrijf ze uitbreidend: eerst kolom of tabel erbij (oude code blijft werken),
  pas een release later iets weghalen. Dan is terugzetten van de code altijd veilig. Moet de database zelf terug:
  §6, "Echt herstel".

## 4. Preview per pull request

- Een PR (niet uit een fork) met wijzigingen in `workspace-app/` krijgt `https://pr-<nr>.test.homezero.verveen.me`,
  met een eigen database, op demodata, achter het previewwachtwoord (teamkluis, "Workspace preview"). De link komt
  als commentaar in de PR.
- PR gesloten of gemerged: de preview gaat weg (containers, database, certificaat-aanmelding) en de PR-images uit de
  registry.
- Maximaal 3 tegelijk (`HZ_PREVIEW_MAX`), met kleinere limieten; de oudste gaat eruit.
- Handmatig opruimen op de server:
  `sudo -u hz-workspace /srv/hz-workspace/env/test/bundle/infra/scripts/preview.sh down <nr>`.
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
- **CI-toegang intrekken**: OAuth-client in Tailscale verwijderen, of de regel voor `tag:ci` uit de policy; en de
  regel in `/srv/hz-workspace/.ssh/authorized_keys` weg.
- **`HZ_TOKEN_KEY` uitgelekt**: de app kan de hoofdsleutel nog niet roteren. Nieuwe sleutel zetten en alle koppelingen
  laten verbreken (collega's koppelen opnieuw); open punt voor het koppelingen-stuk.
- Een ontbrekende verplichte sleutel stopt de uitrol vóór er iets verandert; de API weigert in productie te starten
  zonder `DATABASE_URL`, een geldige `HZ_TOKEN_KEY` en `HZ_STORE=db`, en met `HZ_DEV_LOGIN=1`.

## 6. Back-ups en herstel

- **Nachtelijk 02:30** (`hz-workspace-backup.timer`): `pg_dump` als `hz_backup`, meteen versleuteld met age (server
  en beheerders), naar het back-updoel met controlesom. 30 dagen bewaard; de 7 nieuwste blijven altijd. Ook vóór
  elke productie-uitrol. Ping naar de uptime-check `back-up`; geen ping binnen een dag = melding.
- **Hersteltest** (eerste zondag van de maand, 04:30, `hz-workspace-hersteltest.timer`): de nieuwste back-up in een
  lege database (in de eigen db-container), rijen per tabel tellen tegen wat in de back-up staat. Uitkomst in
  `/srv/hz-workspace/log/hersteltest.log` en ping naar de check `hersteltest`. Handmatig:
  `sudo -u hz-workspace /srv/hz-workspace/bin/hz-run hersteltest.sh`.
- **Handmatige back-up**: `sudo -u hz-workspace /srv/hz-workspace/bin/hz-run backup.sh --label handmatig`.
- **Back-updoel koppelen** (eenmalig), een van twee:
  - De server heeft al een back-up die een map meeneemt: `HZ_BACKUP_TARGET=<die map>/hz-workspace` (de bestanden
    zijn al met age versleuteld, dus veilig in elke back-up).
  - Anders een Hetzner Storage Box (BX11) met eigen sub-account, map `hz-workspace`, SSH aan. De publieke sleutel
    uit `sleutels.txt` (regel "Storage Box") bij het sub-account zetten. Dan
    `printf '%s\n' 'sftp://<sub-account>@<box>.your-storagebox.de:23/hz-workspace' | infra/scripts/secrets.sh set server HZ_BACKUP_TARGET`.
  Daarna PR, merge, uitrol, en één handmatige back-up plus hersteltest.
- **Echt herstel** (database kapot of foute migratie):
  1. App stilzetten: `docker stop hz-workspace-prod-web-1 hz-workspace-prod-api-1 hz-workspace-prod-worker-1`.
  2. Herstellen in een nieuwe database naast de oude:
     `sudo -u hz-workspace /srv/hz-workspace/bin/hz-run restore.sh latest hz_herstel --create --role hz_migrator`
     (of een bestandsnaam in plaats van `latest`).
  3. Omwisselen: `docker exec hz-workspace-prod-db-1 psql -U postgres -c 'ALTER DATABASE hz RENAME TO hz_oud' -c 'ALTER DATABASE hz_herstel RENAME TO hz'`.
  4. Starten: `docker start hz-workspace-prod-api-1 hz-workspace-prod-worker-1 hz-workspace-prod-web-1`, dan
     `curl https://<domein>/api/health`.
  5. Is alles goed, dan na een week `DROP DATABASE hz_oud`.
- Wat er níet in de back-up hoeft: mail, Slack, taken en de contextlaag (die staan bij Google, Slack en GitHub).

## 7. Monitoring en meldingen

- **Hartslag** (elke 5 min, `hz-workspace-heartbeat.timer`): health via https, geen container van de workspace
  `unhealthy` (andere projecten tellen niet mee), schijf onder 85 %. Goed = ping; mis = `/fail` met de reden. Ligt de
  hele server plat, dan komt er geen ping en meldt de uptime-dienst het na 10 minuten aan Robert.
- **Foutregistratie**: api en worker sturen onverwachte fouten (geschoond: geen e-mail, IP of tokens) naar GlitchTip
  (`HZ_ERROR_DSN`). Testfout: `docker exec hz-workspace-prod-api-1 node dist/ops-cli.js test-error`.
- **GlitchTip eerste keer**: `docker exec -it hz-workspace-ops-glitchtip-1 ./manage.py createsuperuser`, inloggen op
  `https://<fouten-domein>`, organisatie en project `workspace`, DSN in `prod.keys` zetten (`HZ_ERROR_DSN`), en een
  alert naar Robert (mail of webhook).
- **Logs** zijn JSON-regels zonder persoonsgegevens (geen IP, user-agent, querystring of e-mail); Docker roteert ze
  (10 MB x 5 per container).

## 8. Plat: wat nu?

1. Health en `docker ps` (§1). Eén container ziek: `docker logs <naam> --since 30m`, daarna `docker restart <naam>`.
2. Net uitgerold? Terugzetten (§3).
3. Database start niet: `docker logs hz-workspace-prod-db-1`; schijf vol? `df -h`. Elke uitrol ruimt onze eigen oude
   images op (`ghcr.io/homezerotech/hz-*`, behalve de huidige, vorige en preview-tags). Nooit `docker system prune` of
   `docker image prune -a`: dat raakt de andere projecten.
4. Certificaat of 502: `infra/scripts/tls-check.sh <domein>`; logs van de proxy (niet van ons) en van
   `hz-workspace-router-router-1`; staat het site-blok nog in de proxy (`voorcheck aangesloten`)?
5. Server onbereikbaar via Tailscale: Hetzner Console, server, Power cycle (overleg: de andere projecten gaan mee).
   Kapot: eigen server (§10) en herstel (§6).
6. Schrijf achteraf in de PR of het issue wat er gebeurde en wat de oplossing was.

## 9. Onderhoud

- Ubuntu-beveiligingsupdates gaan automatisch (de servercontrole bewaakt dat); herstarten doet de eigenaar van de
  server, containers komen vanzelf terug (`restart: unless-stopped`).
- Basisimages en Actions: Dependabot opent PR's (wekelijks). Postgres-, Caddy- en GlitchTip-tags in `compose/` met de
  hand bijwerken (patchversies), via een PR en eerst op test.
- Postgres naar een nieuwe hoofdversie: back-up (§6), nieuwe tag in `compose/app.yaml`, nieuw volume, herstel met
  `restore.sh`. Oefen dit eerst met de proefverhuizing (§10).
- Elk kwartaal: workflow `workspace-server-check` handmatig, en de hersteltest-log nalopen.

## 10. Verhuizen naar een eigen server (HZW-082)

Zelfde code, andere waarden. Wordt de server te klein, of moet bedrijfsdata los van de hobbyprojecten, dan verhuist
de stack. Proef lokaal: `infra/test/image.test.ts` (back-up, nieuwe database met rollen, herstel met rechten, zelfde
rijen, API groen op een ander domein). Echte proef of verhuizing:

1. Tailscale: eenmalige, getagde, vooraf goedgekeurde auth-key (Settings, Keys; niet herbruikbaar, verloopt binnen
   een uur) in een bestand `ts.key`, nooit in Git.
2. Cloud-init (optie, niet de hoofdroute):
   ```bash
   node infra/cloud-init/render.mjs --domain proef.homezero.nl --acme-email robert@homezero.nl \
     --registry ghcr.io/homezerotech --admin-keys ~/.ssh/id_ed25519.pub --deploy-key hz_deploy.pub \
     --tailscale-authkey-file ts.key --hostname hz-workspace-2 --out user-data.yaml
   HCLOUD_TOKEN=… infra/scripts/hetzner-create.sh --name hz-workspace-2 --user-data user-data.yaml \
     --ssh-key ~/.ssh/id_ed25519.pub --dry-run      # controleren, dan zonder --dry-run
   ```
   De server komt in het tailnet, ufw laat publiek alleen 443 toe en SSH alleen op `tailscale0`, en daarna draait
   dezelfde `server-setup.sh` met een eigen edge (`--proxy eigen`; die weigert als 443 bezet is). `ts.key` en
   `user-data.yaml` weg.
3. Oude server: app stilzetten (`docker stop hz-workspace-prod-web-1 hz-workspace-prod-api-1 hz-workspace-prod-worker-1`)
   en `sudo -u hz-workspace /srv/hz-workspace/bin/hz-run backup.sh --label verhuizing`.
4. Nieuwe server: `sleutels.txt` (§2 stap 4), `HZ_DEPLOY_HOST` op de nieuwe tailnet-naam, ACL-host bijwerken,
   eerste uitrol naar prod met dezelfde tag (Actions, Run workflow, omgeving `production`, tag). Dan app stil,
   herstel uit het back-updoel (§6, "Echt herstel", stap 2-4).
5. DNS naar het nieuwe adres; `infra/scripts/tls-check.sh <domein>` groen; inloggen en Dagstart openen.
6. Oude server: workspace weghalen (§11), de andere projecten blijven daar.

Een ander domein vraagt ook: OAuth-redirect-URL's (Google, Slack, Atlassian, GitHub) en `HZ_PUBLIC_URL` volgen het
domein vanzelf; de OAuth-apps moeten de nieuwe URL's kennen (via Chrome, zie HUMAN_INPUT.md).

## 11. Workspace weghalen van een server (de rest blijft staan)

1. Het blok tussen `# >>> hz-workspace` en `# <<< hz-workspace` (en de twee `import`-regels) uit de proxy halen,
   `caddy validate`, `caddy reload`.
2. `for p in prod test ops router edge; do docker compose -p hz-workspace-$p down; done` en de previews
   (`docker compose ls --filter name=hz-workspace-pr`). Volumes pas weg (`down -v`) na een laatste back-up.
3. `systemctl disable --now hz-workspace-backup.timer hz-workspace-heartbeat.timer hz-workspace-hersteltest.timer`,
   units, `/etc/sudoers.d/hz-workspace`, `/etc/tmpfiles.d/hz-workspace.conf` weg; `docker network rm hz-workspace-net`.
4. `userdel hz-workspace` en `/srv/hz-workspace` weg (na de laatste back-up).
