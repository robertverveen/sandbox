CREATE TABLE "auth_domains" (
	"domain" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Handgeschreven (stuk E2, HZW-020): auth_upsert_user zonder rol en met domeincontrole in de database.
--
-- Probleem (criticus ronde 1): auth_upsert_user(email, naam, rol) mocht elke request-transactie als hz_app
-- aanroepen, dus ook 'evil@example.com' met rol admin, en daarna een sessie maken met auth_create_session.
-- Oplossing:
-- - auth_upsert_user(email, naam) maakt altijd een 'member'; admin wordt je alleen via een beheerscript als de
--   migratierol (packages/db/sql/set-role.sql);
-- - het domein van het e-mailadres moet in auth_domains staan (standaard alleen homezero.nl); hz_app kan die tabel
--   niet lezen of wijzigen;
-- - auth_create_session maakt alleen een sessie voor een gebruiker met een toegestaan domein.
ALTER TABLE "auth_domains" ADD CONSTRAINT auth_domains_domain_ck CHECK (domain = lower(domain) AND domain ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$');
--> statement-breakpoint
INSERT INTO "auth_domains" (domain) VALUES ('homezero.nl') ON CONFLICT DO NOTHING;
--> statement-breakpoint
REVOKE ALL ON "auth_domains" FROM hz_app;
--> statement-breakpoint
REVOKE ALL ON "auth_domains" FROM PUBLIC;
--> statement-breakpoint
ALTER TABLE "auth_domains" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "auth_domains" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('CREATE POLICY auth_domains_definer ON auth_domains TO %I USING (true) WITH CHECK (true)', current_user);
END $$;
--> statement-breakpoint
-- Hulpfunctie (geen SECURITY DEFINER, niet voor hz_app): mag dit e-mailadres inloggen?
CREATE FUNCTION auth_domain_allowed(p_email text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT p_email IS NOT NULL
     AND lower(btrim(p_email)) ~ '^[^@\s]+@[^@\s]+$'
     AND EXISTS (SELECT 1 FROM public.auth_domains d WHERE d.domain = split_part(lower(btrim(p_email)), '@', 2))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_domain_allowed(text) FROM PUBLIC;
--> statement-breakpoint
DROP FUNCTION auth_upsert_user(text, text, text);
--> statement-breakpoint
-- Gebruiker aanmaken als hij nog niet bestaat, altijd als 'member', alleen voor een toegestaan domein.
-- Een bestaande gebruiker wordt niet gewijzigd (naam beheert de app, rol alleen het beheerscript).
-- De server checkt daarnaast email_verified, hd en de allowlist (stuk E1); dit is de vangrail in de database.
CREATE FUNCTION auth_upsert_user(p_email text, p_name text DEFAULT '')
RETURNS TABLE (id uuid, email text, name text, role text, blocked_at timestamptz, created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE e text := lower(btrim(coalesce(p_email, '')));
BEGIN
  IF e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
    RAISE EXCEPTION 'auth_upsert_user: ongeldig e-mailadres' USING ERRCODE = '22023';
  END IF;
  IF NOT public.auth_domain_allowed(e) THEN
    RAISE EXCEPTION 'auth_upsert_user: domein niet toegestaan' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE lower(u.email) = e) THEN
    INSERT INTO public.users (email, name, role) VALUES (e, left(coalesce(p_name, ''), 200), 'member') ON CONFLICT DO NOTHING;
    INSERT INTO public.audit_log (user_id, action, target)
      SELECT u.id, 'user.created', 'users' FROM public.users u WHERE lower(u.email) = e;
  END IF;
  RETURN QUERY SELECT u.id, u.email, u.name, u.role, u.blocked_at, u.created_at FROM public.users u WHERE lower(u.email) = e;
END $$;
--> statement-breakpoint
-- Sessie aanmaken: zoals 0006, en alleen voor een gebruiker met een toegestaan domein.
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
    VALUES (p_user_id, p_token_hash, left(coalesce(p_user_agent, ''), 500), p_expires_at)
    RETURNING sessions.id INTO sid;
  INSERT INTO public.audit_log (user_id, action) VALUES (p_user_id, 'session.created');
  RETURN sid;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_upsert_user(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_upsert_user(text, text) TO hz_app;
--> statement-breakpoint
-- Sessie opzoeken: zoals 0006, en het domein moet (nog) toegestaan zijn. Haalt een beheerder een domein weg, dan
-- werken bestaande sessies daarvan niet meer.
CREATE OR REPLACE FUNCTION auth_session_by_token(p_token_hash text)
RETURNS TABLE (
  session_id uuid, user_id uuid, expires_at timestamptz, created_at timestamptz, last_seen_at timestamptz,
  user_agent text, email text, name text, role text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT s.id, s.user_id, s.expires_at, s.created_at, s.last_seen_at, s.user_agent, u.email, u.name, u.role
    FROM public.sessions s JOIN public.users u ON u.id = s.user_id
   WHERE p_token_hash ~ '^[0-9a-f]{64}$' AND s.token_hash = p_token_hash
     AND s.revoked_at IS NULL AND s.expires_at > now() AND u.blocked_at IS NULL
     AND public.auth_domain_allowed(u.email)
$$;
--> statement-breakpoint
-- Eigen gebruikersrij: alleen de naam mag de app wijzigen. Rol, e-mail en blokkade niet (anders maakt een request
-- zichzelf admin met UPDATE users SET role = 'admin'). Aanmaken en wissen kan de app ook niet (RLS en geen recht).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON users FROM hz_app;
--> statement-breakpoint
GRANT UPDATE (name) ON users TO hz_app;
