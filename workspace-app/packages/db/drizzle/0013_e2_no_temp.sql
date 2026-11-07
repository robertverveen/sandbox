-- Geen tijdelijke tabellen, sessies niet terug te halen, auditlog alleen toevoegen (stuk E2, HZW-020, criticus ronde 5).
-- Handgeschreven.
--
-- 1. Tijdelijke tabellen. Standaard mag PUBLIC in elke database TEMP-tabellen maken, en pg_temp staat vooraan in het
--    zoekpad. Willekeurige SQL in de request van A kon zo op een verbinding uit de pool `CREATE TEMP TABLE weekdoelen`
--    doen: de volgende request op die verbinding (van B) schreef en las dan in de tabel van A in plaats van in
--    public.weekdoelen, en RLS hielp niet. Daarom: TEMP weg bij PUBLIC (en bij de rollen van de app, voor het geval
--    iemand het los verleende). De eigenaar van de database (de migratierol) houdt het; die gebruikt het niet.
--    Daarnaast zet createDb() search_path=public,pg_temp op elke verbinding en begint elke transactie met RESET ALL
--    (packages/db/src/client.ts), en weigert assertAppLogin() in productie een login met TEMP.
-- 2. Sessies. hz_app mocht revoked_at van een eigen sessie wijzigen, ook terug naar NULL: een uitgelogde sessie werd
--    zo weer geldig. Nu: geen UPDATE-recht meer voor hz_app; intrekken gaat via auth_revoke_own_session(id), dat alleen
--    een eigen, nog geldige sessie intrekt. En een trigger houdt voor iedereen (ook de functies) vast: een
--    ingetrokken sessie blijft ingetrokken, en token_hash, user_id en created_at veranderen nooit.
-- 3. Auditlog en import_keys: hz_app mag het auditlog niet wijzigen of wissen, en import_keys niet wissen. Tot nu toe
--    hield alleen RLS (een ontbrekende regel) dat tegen; het recht zelf is nu weg.
DO $$
DECLARE
  db text := current_database();
  r text;
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', db);
  FOREACH r IN ARRAY ARRAY['hz_app', 'hz_worker', 'hz_auth', 'hz_indexer'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM %I', db, r);
    END IF;
  END LOOP;
  -- Was de migratierol geen eigenaar van de database, dan deed REVOKE niets (alleen een waarschuwing). Dan stoppen.
  IF EXISTS (SELECT 1 FROM pg_database d WHERE d.datname = db AND d.datacl IS NULL)
     OR EXISTS (SELECT 1 FROM pg_database d, aclexplode(d.datacl) a
                 WHERE d.datname = db AND a.grantee = 0 AND a.privilege_type = 'TEMPORARY') THEN
    RAISE EXCEPTION 'PUBLIC mag nog tijdelijke tabellen maken in database %. Laat de eigenaar of een beheerder eenmalig draaien: REVOKE TEMPORARY ON DATABASE % FROM PUBLIC; (zie README, Database)', db, db;
  END IF;
  FOREACH r IN ARRAY ARRAY['hz_app', 'hz_worker', 'hz_auth', 'hz_indexer'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) AND has_database_privilege(r, db, 'TEMPORARY') THEN
      RAISE EXCEPTION 'rol % mag nog tijdelijke tabellen maken in database %', r, db;
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE UPDATE ON sessions FROM hz_app;
--> statement-breakpoint
REVOKE UPDATE (revoked_at) ON sessions FROM hz_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sessions_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'een ingetrokken sessie blijft ingetrokken' USING ERRCODE = '42501';
  END IF;
  IF NEW.token_hash IS DISTINCT FROM OLD.token_hash OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'token_hash, user_id en created_at van een sessie veranderen niet' USING ERRCODE = '42501';
  END IF;
  -- intrekken kan alleen per nu, niet met een datum in de toekomst of het verleden
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    NEW.revoked_at := now();
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION sessions_guard() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS sessions_guard ON sessions;
--> statement-breakpoint
CREATE TRIGGER sessions_guard BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION sessions_guard();
--> statement-breakpoint
-- Een eigen sessie intrekken (uitloggen op een ander apparaat), vanuit een request als hz_app. Alleen een sessie van
-- de gebruiker van deze transactie (app_user_id(), dus van de geldige sessie) die nog niet is ingetrokken.
CREATE OR REPLACE FUNCTION auth_revoke_own_session(p_session_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE uid uuid := public.app_user_id();
BEGIN
  IF uid IS NULL OR p_session_id IS NULL THEN RETURN false; END IF;
  UPDATE public.sessions s SET revoked_at = now()
   WHERE s.id = p_session_id AND s.user_id = uid AND s.revoked_at IS NULL;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.audit_log (user_id, action) VALUES (uid, 'session.revoked');
  RETURN true;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_revoke_own_session(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_revoke_own_session(uuid) TO hz_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM hz_app;
--> statement-breakpoint
REVOKE DELETE, TRUNCATE ON import_keys FROM hz_app;
