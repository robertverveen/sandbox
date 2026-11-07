-- Stuk E1: dezelfde inlogfuncties als stuk E2 (0006_e2_auth_functions.sql en 0008_e2_auth_domain.sql), zodat de
-- adapter in packages/db/src/auth.ts in deze tak en na het samenvoegen dezelfde functies aanroept.
--
-- Samenvoegen met E2: zet de migraties van E2 vóór die van E1. Dan bestaan de functies en regels al en slaat dit
-- bestand alles over (elke stap controleert eerst of het er al is); het mag dan ook weg. Draait dit bestand toch
-- eerst, dan faalt E2's CREATE FUNCTION op een bestaande functie: hernummer dan zo dat E2 eerst komt.
--
-- Bewust niet hier (dat doet E2): de oude GUC-regels van het fundament (users_select/users_write/sessions_own met
-- app.purpose 'auth') weghalen en UPDATE op users voor hz_app beperken tot de naam. De code van E1 gebruikt die
-- regels niet meer (geen withPurpose('auth') in packages/db/src/auth.ts).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'users' AND policyname = 'users_definer') THEN
    EXECUTE format('CREATE POLICY users_definer ON users TO %I USING (true) WITH CHECK (true)', current_user);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'sessions' AND policyname = 'sessions_definer') THEN
    EXECUTE format('CREATE POLICY sessions_definer ON sessions TO %I USING (true) WITH CHECK (true)', current_user);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'audit_log' AND policyname = 'audit_definer') THEN
    EXECUTE format('CREATE POLICY audit_definer ON audit_log FOR INSERT TO %I WITH CHECK (true)', current_user);
  END IF;
END $$;
--> statement-breakpoint
DO $outer$
BEGIN
  IF to_regprocedure('public.auth_user_by_email(text)') IS NULL THEN
    EXECUTE $f$
      CREATE FUNCTION auth_user_by_email(p_email text)
      RETURNS TABLE (id uuid, email text, name text, role text, blocked_at timestamptz, created_at timestamptz)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $b$
        SELECT u.id, u.email, u.name, u.role, u.blocked_at, u.created_at
          FROM public.users u
         WHERE p_email IS NOT NULL AND lower(u.email) = lower(btrim(p_email))
      $b$
    $f$;
  END IF;

  -- Zoals E2 0008: altijd als 'member' en alleen een toegestaan domein (E2 leest dat uit auth_domains, standaard
  -- homezero.nl; hier vast homezero.nl).
  IF to_regprocedure('public.auth_upsert_user(text, text)') IS NULL THEN
    EXECUTE $f$
      CREATE FUNCTION auth_upsert_user(p_email text, p_name text DEFAULT '')
      RETURNS TABLE (id uuid, email text, name text, role text, blocked_at timestamptz, created_at timestamptz)
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $b$
      DECLARE e text := lower(btrim(coalesce(p_email, '')));
      BEGIN
        IF e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
          RAISE EXCEPTION 'auth_upsert_user: ongeldig e-mailadres' USING ERRCODE = '22023';
        END IF;
        IF split_part(e, '@', 2) <> 'homezero.nl' THEN
          RAISE EXCEPTION 'auth_upsert_user: domein niet toegestaan' USING ERRCODE = '42501';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM public.users u WHERE lower(u.email) = e) THEN
          INSERT INTO public.users (email, name, role) VALUES (e, left(coalesce(p_name, ''), 200), 'member') ON CONFLICT DO NOTHING;
          INSERT INTO public.audit_log (user_id, action, target)
            SELECT u.id, 'user.created', 'users' FROM public.users u WHERE lower(u.email) = e;
        END IF;
        RETURN QUERY SELECT u.id, u.email, u.name, u.role, u.blocked_at, u.created_at FROM public.users u WHERE lower(u.email) = e;
      END $b$
    $f$;
  END IF;

  IF to_regprocedure('public.auth_create_session(uuid, text, text, timestamptz)') IS NULL THEN
    EXECUTE $f$
      CREATE FUNCTION auth_create_session(p_user_id uuid, p_token_hash text, p_user_agent text, p_expires_at timestamptz)
      RETURNS uuid
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $b$
      DECLARE sid uuid;
      BEGIN
        IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
          RAISE EXCEPTION 'auth_create_session: alleen een sha256-hash (64 hex) van het token' USING ERRCODE = '22023';
        END IF;
        IF p_expires_at IS NULL OR p_expires_at <= now() THEN
          RAISE EXCEPTION 'auth_create_session: verloopdatum moet in de toekomst liggen' USING ERRCODE = '22023';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user_id AND u.blocked_at IS NULL
                        AND split_part(lower(u.email), '@', 2) = 'homezero.nl') THEN
          RAISE EXCEPTION 'auth_create_session: onbekende of geblokkeerde gebruiker' USING ERRCODE = '22023';
        END IF;
        INSERT INTO public.sessions (user_id, token_hash, user_agent, expires_at)
          VALUES (p_user_id, p_token_hash, left(coalesce(p_user_agent, ''), 500), p_expires_at)
          RETURNING sessions.id INTO sid;
        INSERT INTO public.audit_log (user_id, action) VALUES (p_user_id, 'session.created');
        RETURN sid;
      END $b$
    $f$;
  END IF;

  IF to_regprocedure('public.auth_session_by_token(text)') IS NULL THEN
    EXECUTE $f$
      CREATE FUNCTION auth_session_by_token(p_token_hash text)
      RETURNS TABLE (
        session_id uuid, user_id uuid, expires_at timestamptz, created_at timestamptz, last_seen_at timestamptz,
        user_agent text, email text, name text, role text
      )
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $b$
        SELECT s.id, s.user_id, s.expires_at, s.created_at, s.last_seen_at, s.user_agent, u.email, u.name, u.role
          FROM public.sessions s JOIN public.users u ON u.id = s.user_id
         WHERE p_token_hash ~ '^[0-9a-f]{64}$' AND s.token_hash = p_token_hash
           AND s.revoked_at IS NULL AND s.expires_at > now() AND u.blocked_at IS NULL
           AND split_part(lower(u.email), '@', 2) = 'homezero.nl'
      $b$
    $f$;
  END IF;

  IF to_regprocedure('public.auth_touch_session(text, timestamptz)') IS NULL THEN
    EXECUTE $f$
      CREATE FUNCTION auth_touch_session(p_token_hash text, p_expires_at timestamptz DEFAULT NULL)
      RETURNS boolean
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $b$
      DECLARE n int;
      BEGIN
        UPDATE public.sessions s SET last_seen_at = now(), expires_at = coalesce(p_expires_at, s.expires_at)
         WHERE p_token_hash ~ '^[0-9a-f]{64}$' AND s.token_hash = p_token_hash
           AND s.revoked_at IS NULL AND s.expires_at > now();
        GET DIAGNOSTICS n = ROW_COUNT;
        RETURN n > 0;
      END $b$
    $f$;
  END IF;

  IF to_regprocedure('public.auth_revoke_session(text)') IS NULL THEN
    EXECUTE $f$
      CREATE FUNCTION auth_revoke_session(p_token_hash text)
      RETURNS boolean
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $b$
      DECLARE uid uuid;
      BEGIN
        UPDATE public.sessions s SET revoked_at = now()
         WHERE p_token_hash ~ '^[0-9a-f]{64}$' AND s.token_hash = p_token_hash AND s.revoked_at IS NULL
         RETURNING s.user_id INTO uid;
        IF uid IS NULL THEN RETURN false; END IF;
        INSERT INTO public.audit_log (user_id, action) VALUES (uid, 'session.revoked');
        RETURN true;
      END $b$
    $f$;
  END IF;
END $outer$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_user_by_email(text), auth_upsert_user(text, text),
  auth_create_session(uuid, text, text, timestamptz), auth_session_by_token(text),
  auth_touch_session(text, timestamptz), auth_revoke_session(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_user_by_email(text), auth_upsert_user(text, text),
  auth_create_session(uuid, text, text, timestamptz), auth_session_by_token(text),
  auth_touch_session(text, timestamptz), auth_revoke_session(text) TO hz_app;
