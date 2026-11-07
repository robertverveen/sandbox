-- Inloggen alleen als hz_auth, app.user_id vast aan een geldige sessie (stuk E2, HZW-020, criticus ronde 3).
-- Handgeschreven.
--
-- Probleem: hz_app mocht auth_user_by_email(), auth_upsert_user() en auth_create_session() uitvoeren. Elke
-- request-transactie (dus ook een SQL-injectie of een fout in een route) kon zo het id van een collega opvragen bij
-- een raadbaar e-mailadres, app.user_id op dat id zetten en al zijn rijen lezen, of zelfs een sessie voor hem maken.
-- RLS met een GUC beschermt tegen een vergeten WHERE-filter, niet tegen willekeurige SQL: een GUC kan elke
-- transactie zelf zetten.
--
-- Oplossing:
-- 1. De auth_*-functies zijn alleen nog voor de rol hz_auth (NOLOGIN, geen tabelrechten). De sessie-middleware van de
--    api en de adapter van de auth-bibliotheek verbinden met een eigen login die alleen lid is van hz_auth
--    (sql/auth-login.sql, HZ_AUTH_DATABASE_URL). De api-login (hz_app_login) kan ze niet meer aanroepen.
-- 2. app_user_id() vertrouwt app.user_id niet meer zomaar. In een request zet de api app.session (de sha256-hash van
--    het sessietoken uit de cookie); app_user_id() zoekt daarmee de geldige sessie op (niet ingetrokken, niet
--    verlopen, gebruiker niet geblokkeerd, domein toegestaan) en geeft die gebruiker. Wie geen geldig token heeft, is
--    niemand; staat app.user_id op iemand anders dan de sessie, dan ook niemand.
--    Zonder app.session telt app.user_id alleen als de login (session_user, niet te veranderen met SET ROLE) lid is van
--    hz_worker: de worker en het importscript werken namens een collega. De api-login is daar geen lid van.
-- 3. hz_app mag zelf geen sessierij meer invoegen of wijzigen; alleen revoked_at (uitloggen op een ander apparaat).
--
-- Wat dit niet tegenhoudt: willekeurige SQL binnen de request van A kan nog steeds alles van A lezen en wijzigen (dat is
-- A zelf). Een gestolen sessietoken is een gestolen sessie. De worker-login kan namens iedereen werken; die login
-- staat alleen in de omgeving van de worker en het importscript.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hz_auth') THEN
    RAISE EXCEPTION 'rol hz_auth ontbreekt. Laat een beheerder packages/db/sql/bootstrap-roles.sql (opnieuw) draaien (zie README, Database).';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hz_auth' AND (rolsuper OR rolbypassrls OR rolcanlogin)) THEN
    RAISE EXCEPTION 'rol hz_auth mag geen superuser, BYPASSRLS of login hebben';
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO hz_auth;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_user_by_email(text), auth_upsert_user(text, text),
  auth_create_session(uuid, text, text, timestamptz), auth_session_by_token(text),
  auth_touch_session(text, timestamptz), auth_revoke_session(text) FROM PUBLIC, hz_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_user_by_email(text), auth_upsert_user(text, text),
  auth_create_session(uuid, text, text, timestamptz), auth_session_by_token(text),
  auth_touch_session(text, timestamptz), auth_revoke_session(text) TO hz_auth;
--> statement-breakpoint
-- De gebruiker van deze transactie. Alle RLS-regels (user_id = app_user_id()) gebruiken deze functie.
CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  h text := nullif(current_setting('app.session', true), '');
  claimed uuid := nullif(current_setting('app.user_id', true), '')::uuid;
  uid uuid;
BEGIN
  IF h IS NOT NULL THEN
    IF h !~ '^[0-9a-f]{64}$' THEN
      RETURN NULL;
    END IF;
    SELECT s.user_id INTO uid
      FROM public.sessions s JOIN public.users u ON u.id = s.user_id
     WHERE s.token_hash = h AND s.revoked_at IS NULL AND s.expires_at > now()
       AND u.blocked_at IS NULL AND public.auth_domain_allowed(u.email);
    IF uid IS NULL OR (claimed IS NOT NULL AND claimed <> uid) THEN
      RETURN NULL;
    END IF;
    RETURN uid;
  END IF;
  IF claimed IS NOT NULL AND pg_has_role(session_user, 'hz_worker', 'MEMBER') THEN
    RETURN claimed;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_user_id() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_user_id() TO hz_app, hz_indexer;
--> statement-breakpoint
-- Sessies maakt alleen hz_auth (auth_create_session). hz_app mag een eigen sessie lezen, wissen en intrekken.
REVOKE INSERT, UPDATE ON sessions FROM hz_app;
--> statement-breakpoint
GRANT UPDATE (revoked_at) ON sessions TO hz_app;
--> statement-breakpoint
-- app_user_id() zoekt nu een sessie op. In de regels als (SELECT app_user_id()): Postgres rekent hem dan één keer per
-- query uit (initplan) in plaats van per rij. Alle bestaande regels die app_user_id() noemen, worden zo herschreven;
-- de betekenis blijft gelijk. Nieuwe regels van latere migraties mogen het ook zo schrijven.
DO $$
DECLARE p record; q text; c text; stmt text;
BEGIN
  FOR p IN
    SELECT pol.polname, cls.relname,
           pg_get_expr(pol.polqual, pol.polrelid) AS qual,
           pg_get_expr(pol.polwithcheck, pol.polrelid) AS chk
      FROM pg_policy pol JOIN pg_class cls ON cls.oid = pol.polrelid
     WHERE cls.relnamespace = 'public'::regnamespace
       AND (coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') LIKE '%app_user_id()%'
         OR coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') LIKE '%app_user_id()%')
  LOOP
    q := replace(p.qual, 'app_user_id()', '(SELECT app_user_id())');
    c := replace(p.chk, 'app_user_id()', '(SELECT app_user_id())');
    stmt := format('ALTER POLICY %I ON %I', p.polname, p.relname);
    IF q IS NOT NULL THEN stmt := stmt || format(' USING (%s)', q); END IF;
    IF c IS NOT NULL THEN stmt := stmt || format(' WITH CHECK (%s)', c); END IF;
    EXECUTE stmt;
  END LOOP;
END $$;
