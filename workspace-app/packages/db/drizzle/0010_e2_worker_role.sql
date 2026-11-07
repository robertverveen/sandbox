-- Worker-rol, sessielimiet en opruimen in de contextindex (stuk E2, HZW-020/021, criticus ronde 2). Handgeschreven.
--
-- 1. system_active_user_ids() gaf elke hz_app-transactie (dus elke request) alle gebruikers-id's. Met zo'n id kan
--    een request zelf app.user_id zetten. Nu mag alleen de rol hz_worker (NOLOGIN, aangemaakt door
--    sql/bootstrap-roles.sql) de functie uitvoeren. De worker verbindt met een eigen login die lid is van hz_app en
--    hz_worker (sql/worker-login.sql); de login van de api (hz_app_login) is alleen lid van hz_app.
-- 2. auth_touch_session en auth_create_session: de verloopdatum ligt in de toekomst en hoogstens 30 dagen na nu.
--    Een request (of een fout in de auth-bibliotheek) kan een sessie dus niet voor jaren verlengen.
-- 3. context_index_delete_id(id): één indexrij weghalen (een actie die uit acties.md verdween terwijl het bestand
--    blijft). Alleen hz_indexer, zoals context_index_delete (0009).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hz_worker') THEN
    RAISE EXCEPTION 'rol hz_worker ontbreekt. Laat een beheerder packages/db/sql/bootstrap-roles.sql (opnieuw) draaien (zie README, Database).';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hz_worker' AND (rolsuper OR rolbypassrls OR rolcanlogin)) THEN
    RAISE EXCEPTION 'rol hz_worker mag geen superuser, BYPASSRLS of login hebben';
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO hz_worker;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system_active_user_ids() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION system_active_user_ids() FROM hz_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION system_active_user_ids() TO hz_worker;
--> statement-breakpoint
-- Glijdende sessie: hoogstens 30 dagen na nu. Een verloopdatum in het verleden is een fout (uitloggen gaat via
-- auth_revoke_session).
CREATE OR REPLACE FUNCTION auth_touch_session(p_token_hash text, p_expires_at timestamptz DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n int;
BEGIN
  IF p_expires_at IS NOT NULL AND p_expires_at <= now() THEN
    RAISE EXCEPTION 'auth_touch_session: verloopdatum moet in de toekomst liggen' USING ERRCODE = '22023';
  END IF;
  UPDATE public.sessions s
     SET last_seen_at = now(),
         expires_at = least(coalesce(p_expires_at, s.expires_at), now() + interval '30 days')
   WHERE p_token_hash ~ '^[0-9a-f]{64}$' AND s.token_hash = p_token_hash
     AND s.revoked_at IS NULL AND s.expires_at > now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END $$;
--> statement-breakpoint
-- Sessie aanmaken: zoals 0008, met dezelfde bovengrens van 30 dagen.
CREATE OR REPLACE FUNCTION auth_create_session(p_user_id uuid, p_token_hash text, p_user_agent text, p_expires_at timestamptz)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE sid uuid;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'auth_create_session: alleen een sha256-hash (64 hex) van het token' USING ERRCODE = '22023';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= now() THEN
    RAISE EXCEPTION 'auth_create_session: verloopdatum moet in de toekomst liggen' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u
                  WHERE u.id = p_user_id AND u.blocked_at IS NULL AND public.auth_domain_allowed(u.email)) THEN
    RAISE EXCEPTION 'auth_create_session: onbekende of geblokkeerde gebruiker' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.sessions (user_id, token_hash, user_agent, expires_at)
    VALUES (p_user_id, p_token_hash, left(coalesce(p_user_agent, ''), 500),
            least(p_expires_at, now() + interval '30 days'))
    RETURNING sessions.id INTO sid;
  INSERT INTO public.audit_log (user_id, action) VALUES (p_user_id, 'session.created');
  RETURN sid;
END $$;
--> statement-breakpoint
-- Eén indexrij weghalen op zijn sleutel (exact, geen patroon). Geeft 0 of 1 terug.
CREATE FUNCTION context_index_delete_id(p_id text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n int;
BEGIN
  IF p_id IS NULL OR btrim(p_id) = '' THEN
    RAISE EXCEPTION 'context_index_delete_id: geef precies één sleutel' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.context_index c WHERE c.id = p_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION context_index_delete_id(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION context_index_delete_id(text) TO hz_indexer;
