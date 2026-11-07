-- Inloggen zonder open SELECT op users en sessions (stuk E2, HZW-020). Handgeschreven.
--
-- Probleem: app.purpose is een GUC die elke transactie zelf kan zetten. De oude regels gaven met
-- app.purpose = 'auth' of 'system' leesrecht op ALLE gebruikers en sessies; een request die dat zet, ziet alles.
-- Oplossing: users en sessions alleen nog eigen rijen (app.user_id). Inloggen, een sessie opzoeken en de worker
-- gaan via SECURITY DEFINER-functies van de migratierol die precies één sleutel opzoeken (één sessietoken-hash,
-- één e-mailadres) of alleen id's teruggeven. hz_app mag ze uitvoeren, PUBLIC niet.
--
-- Omdat de tabellen FORCE ROW LEVEL SECURITY hebben, valt ook de eigenaar onder RLS. De functies draaien als de
-- eigenaar; daarvoor zijn er regels TO <migratierol>. hz_app is geen lid van de migratierol en kan die regels dus
-- nooit gebruiken (test: packages/db/test/auth.test.ts).
--
-- Voor een auth-bibliotheek (Better Auth, Auth.js; stuk E1): een adapter roept deze functies aan in plaats van
-- SELECT/INSERT op users en sessions. Zie README, "Inloggen en de auth-bibliotheek".

DROP POLICY IF EXISTS users_select ON users;
--> statement-breakpoint
DROP POLICY IF EXISTS users_write ON users;
--> statement-breakpoint
DROP POLICY IF EXISTS sessions_own ON sessions;
--> statement-breakpoint
DROP POLICY IF EXISTS audit_insert ON audit_log;
--> statement-breakpoint
-- Een ingelogde collega leest en wijzigt alleen zijn eigen gebruikersrij; aanmaken en wissen kan de app niet.
CREATE POLICY users_own_select ON users FOR SELECT USING (id = app_user_id());
--> statement-breakpoint
CREATE POLICY users_own_update ON users FOR UPDATE USING (id = app_user_id()) WITH CHECK (id = app_user_id());
--> statement-breakpoint
-- Eigen sessies: lijst van ingelogde apparaten, uitloggen op een ander apparaat.
CREATE POLICY sessions_own ON sessions FOR ALL USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
--> statement-breakpoint
CREATE POLICY audit_insert ON audit_log FOR INSERT WITH CHECK (user_id = app_user_id());
--> statement-breakpoint
-- Alleen voor de SECURITY DEFINER-functies hieronder (die draaien als de migratierol).
DO $$
BEGIN
  EXECUTE format('CREATE POLICY users_definer ON users TO %I USING (true) WITH CHECK (true)', current_user);
  EXECUTE format('CREATE POLICY sessions_definer ON sessions TO %I USING (true) WITH CHECK (true)', current_user);
  EXECUTE format('CREATE POLICY audit_definer ON audit_log FOR INSERT TO %I WITH CHECK (true)', current_user);
END $$;
--> statement-breakpoint
-- Eén gebruiker bij precies één e-mailadres (hoofdletterongevoelig, geen patroon).
CREATE FUNCTION auth_user_by_email(p_email text)
RETURNS TABLE (id uuid, email text, name text, role text, blocked_at timestamptz, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT u.id, u.email, u.name, u.role, u.blocked_at, u.created_at
    FROM public.users u
   WHERE p_email IS NOT NULL AND lower(u.email) = lower(btrim(p_email))
$$;
--> statement-breakpoint
-- Gebruiker aanmaken als hij nog niet bestaat (na de checks van de server: email_verified, domein, allowlist).
-- Een bestaande gebruiker wordt niet gewijzigd (naam en rol beheert de app zelf).
CREATE FUNCTION auth_upsert_user(p_email text, p_name text DEFAULT '', p_role text DEFAULT 'member')
RETURNS TABLE (id uuid, email text, name text, role text, blocked_at timestamptz, created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE e text := lower(btrim(coalesce(p_email, '')));
BEGIN
  IF e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'auth_upsert_user: ongeldig e-mailadres' USING ERRCODE = '22023';
  END IF;
  IF p_role NOT IN ('admin', 'member') THEN
    RAISE EXCEPTION 'auth_upsert_user: ongeldige rol' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE lower(u.email) = e) THEN
    INSERT INTO public.users (email, name, role) VALUES (e, coalesce(p_name, ''), p_role) ON CONFLICT DO NOTHING;
    INSERT INTO public.audit_log (user_id, action, target)
      SELECT u.id, 'user.created', 'users' FROM public.users u WHERE lower(u.email) = e;
  END IF;
  RETURN QUERY SELECT u.id, u.email, u.name, u.role, u.blocked_at, u.created_at FROM public.users u WHERE lower(u.email) = e;
END $$;
--> statement-breakpoint
-- Sessie aanmaken voor een bestaande, niet geblokkeerde gebruiker. Alleen de sha256-hash van het token (64 hex).
CREATE FUNCTION auth_create_session(p_user_id uuid, p_token_hash text, p_user_agent text, p_expires_at timestamptz)
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
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user_id AND u.blocked_at IS NULL) THEN
    RAISE EXCEPTION 'auth_create_session: onbekende of geblokkeerde gebruiker' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.sessions (user_id, token_hash, user_agent, expires_at)
    VALUES (p_user_id, p_token_hash, left(coalesce(p_user_agent, ''), 500), p_expires_at)
    RETURNING sessions.id INTO sid;
  INSERT INTO public.audit_log (user_id, action) VALUES (p_user_id, 'session.created');
  RETURN sid;
END $$;
--> statement-breakpoint
-- De geldige sessie bij precies één token-hash: niet ingetrokken, niet verlopen, gebruiker niet geblokkeerd.
CREATE FUNCTION auth_session_by_token(p_token_hash text)
RETURNS TABLE (
  session_id uuid, user_id uuid, expires_at timestamptz, created_at timestamptz, last_seen_at timestamptz,
  user_agent text, email text, name text, role text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT s.id, s.user_id, s.expires_at, s.created_at, s.last_seen_at, s.user_agent, u.email, u.name, u.role
    FROM public.sessions s JOIN public.users u ON u.id = s.user_id
   WHERE p_token_hash ~ '^[0-9a-f]{64}$' AND s.token_hash = p_token_hash
     AND s.revoked_at IS NULL AND s.expires_at > now() AND u.blocked_at IS NULL
$$;
--> statement-breakpoint
-- Laatst gezien bijwerken en desgewenst de verloopdatum verschuiven (glijdende sessie). Alleen een geldige sessie.
CREATE FUNCTION auth_touch_session(p_token_hash text, p_expires_at timestamptz DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n int;
BEGIN
  UPDATE public.sessions s SET last_seen_at = now(), expires_at = coalesce(p_expires_at, s.expires_at)
   WHERE p_token_hash ~ '^[0-9a-f]{64}$' AND s.token_hash = p_token_hash
     AND s.revoked_at IS NULL AND s.expires_at > now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END $$;
--> statement-breakpoint
-- Uitloggen: precies één sessie intrekken.
CREATE FUNCTION auth_revoke_session(p_token_hash text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE uid uuid;
BEGIN
  UPDATE public.sessions s SET revoked_at = now()
   WHERE p_token_hash ~ '^[0-9a-f]{64}$' AND s.token_hash = p_token_hash AND s.revoked_at IS NULL
   RETURNING s.user_id INTO uid;
  IF uid IS NULL THEN RETURN false; END IF;
  INSERT INTO public.audit_log (user_id, action) VALUES (uid, 'session.revoked');
  RETURN true;
END $$;
--> statement-breakpoint
-- Worker: de id's van actieve (niet geblokkeerde) collega's, om per collega een job met withUser te plannen.
-- Alleen id's, geen e-mail of naam.
CREATE FUNCTION system_active_user_ids()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT u.id FROM public.users u WHERE u.blocked_at IS NULL ORDER BY u.created_at
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_user_by_email(text), auth_upsert_user(text, text, text),
  auth_create_session(uuid, text, text, timestamptz), auth_session_by_token(text),
  auth_touch_session(text, timestamptz), auth_revoke_session(text), system_active_user_ids() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_user_by_email(text), auth_upsert_user(text, text, text),
  auth_create_session(uuid, text, text, timestamptz), auth_session_by_token(text),
  auth_touch_session(text, timestamptz), auth_revoke_session(text), system_active_user_ids() TO hz_app;
