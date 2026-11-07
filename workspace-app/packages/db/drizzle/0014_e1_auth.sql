-- Stuk E1: inloggen, teamleden, onboarding en koppelingen (HZW-010 t/m 014). Handgeschreven, los van het fundament.
-- Nieuwe tabellen: allowlist (uitnodigingslijst), auth_accounts (Google-sub bij een gebruiker, geen tokens),
-- connect_flows (lopende OAuth-koppelingen: gehashte state en PKCE-verifier), onboarding (wizard per collega).
--
-- Geen nieuwe GUC-regels (app.purpose): elke transactie kan die zelf zetten. Wat niet per eigen rij kan (inloggen,
-- beheer) loopt via SECURITY DEFINER-functies van de migratierol die zelf controleren wat mag:
--  - inloggen: precies één sleutel opzoeken (e-mail op de uitnodigingslijst, Google-sub), een account koppelen,
--    de rol overnemen van de uitnodigingslijst (die alleen beheerders vullen), een geweigerde login loggen;
--  - beheer: de functie leest de rol van app.user_id zelf (admin en niet geblokkeerd), anders 42501.
-- users, sessions en audit_log zelf lopen via de functies van stuk E2 (auth_*, 0006 t/m 0013). Rechten: zie 0015.
CREATE TABLE IF NOT EXISTS "allowlist" (
	"email" text PRIMARY KEY NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"added_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "allowlist_email_lower" CHECK ("email" = lower("email")),
	CONSTRAINT "allowlist_role_chk" CHECK ("role" IN ('admin', 'member'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth_accounts" (
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_accounts_pk" PRIMARY KEY ("provider", "provider_account_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_accounts_user_idx" ON "auth_accounts" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connect_flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"provider" text NOT NULL,
	"state_hash" text NOT NULL,
	"code_verifier" text NOT NULL,
	"return_to" text DEFAULT '/instellingen/koppelingen' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connect_flows_state_uq" ON "connect_flows" ("state_hash");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onboarding" (
	"user_id" uuid PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"status" text DEFAULT 'new' NOT NULL,
	"step" text DEFAULT 'welkom' NOT NULL,
	"steps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"weekritme" jsonb,
	"pers_repo" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "onboarding_status_chk" CHECK ("status" IN ('new', 'busy', 'later', 'done'))
);
--> statement-breakpoint
-- allowlist: alleen via de functies (hz_app heeft geen regel en geen recht).
ALTER TABLE allowlist ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE allowlist FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- auth_accounts: een collega ziet zijn eigen gekoppelde Google-account; opzoeken en koppelen via de functies.
ALTER TABLE auth_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE auth_accounts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY auth_accounts_own ON auth_accounts FOR SELECT USING (user_id = app_user_id());
--> statement-breakpoint
-- De functies hieronder draaien als de migratierol; door FORCE ROW LEVEL SECURITY valt die ook onder RLS.
-- hz_app is geen lid van de migratierol en kan deze regels nooit gebruiken.
DO $$
BEGIN
  EXECUTE format('CREATE POLICY allowlist_definer ON allowlist TO %I USING (true) WITH CHECK (true)', current_user);
  EXECUTE format('CREATE POLICY auth_accounts_definer ON auth_accounts TO %I USING (true) WITH CHECK (true)', current_user);
END $$;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['connect_flows', 'onboarding'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id())', t || '_own', t);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON allowlist, auth_accounts FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON allowlist FROM hz_app;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON auth_accounts FROM hz_app;
--> statement-breakpoint
GRANT SELECT ON auth_accounts TO hz_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON connect_flows, onboarding TO hz_app;
--> statement-breakpoint
-- Vaste beheerder (HZW-012: "Robert is admin"). Meer beheerders: een beheerder in de app (Instellingen, Team) of
-- packages/db/sql/e1-beheerder.sql als de migratierol.
INSERT INTO allowlist (email, role) VALUES ('robert@homezero.nl', 'admin') ON CONFLICT (email) DO NOTHING;
--> statement-breakpoint
-- Hulpfunctie (niet voor hz_app): is app.user_id een niet-geblokkeerde beheerder? Leest de rol uit users, niet
-- uit een GUC of de aanroep.
CREATE FUNCTION e1_require_admin() RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE me uuid := public.app_user_id();
BEGIN
  IF me IS NULL OR NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = me AND u.role = 'admin' AND u.blocked_at IS NULL) THEN
    RAISE EXCEPTION 'alleen voor beheerders' USING ERRCODE = '42501';
  END IF;
  RETURN me;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION e1_require_admin() FROM PUBLIC;
--> statement-breakpoint
-- Inloggen: de rol op de uitnodigingslijst bij precies één e-mailadres (null = niet uitgenodigd).
CREATE FUNCTION auth_allowlist_role(p_email text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT a.role FROM public.allowlist a WHERE p_email IS NOT NULL AND a.email = lower(btrim(p_email))
$$;
--> statement-breakpoint
-- Inloggen: neem de rol over van de uitnodigingslijst (alleen beheerders vullen die). Zonder regel blijft de rol.
-- Geeft de rol na afloop terug.
CREATE FUNCTION auth_apply_allowlist_role(p_user_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r text; cur text;
BEGIN
  SELECT a.role, u.role INTO r, cur FROM public.users u LEFT JOIN public.allowlist a ON a.email = lower(u.email)
   WHERE u.id = p_user_id;
  IF r IS NOT NULL AND r IS DISTINCT FROM cur THEN
    UPDATE public.users SET role = r WHERE id = p_user_id;
    INSERT INTO public.audit_log (user_id, action, target) VALUES (p_user_id, 'user.role', r);
    RETURN r;
  END IF;
  RETURN cur;
END $$;
--> statement-breakpoint
-- Inloggen: de gebruiker bij precies één Google-account (provider + sub).
CREATE FUNCTION auth_account_lookup(p_provider text, p_sub text)
RETURNS TABLE (id uuid, email text, name text, role text, blocked_at timestamptz, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT u.id, u.email, u.name, u.role, u.blocked_at, u.created_at
    FROM public.auth_accounts a JOIN public.users u ON u.id = a.user_id
   WHERE a.provider = p_provider AND a.provider_account_id = p_sub
$$;
--> statement-breakpoint
-- Inloggen: Google-account aan een bestaande gebruiker koppelen. Een account dat al bij iemand anders hoort, of een
-- tweede account van dezelfde soort voor deze gebruiker, wordt niet gekoppeld (false).
CREATE FUNCTION auth_link_account(p_user_id uuid, p_provider text, p_sub text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n int;
BEGIN
  IF p_provider IS NULL OR p_sub IS NULL OR p_sub = '' THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM public.auth_accounts a WHERE a.user_id = p_user_id AND a.provider = p_provider
              AND a.provider_account_id <> p_sub) THEN
    RETURN false;
  END IF;
  INSERT INTO public.auth_accounts (provider, provider_account_id, user_id)
    SELECT p_provider, p_sub, u.id FROM public.users u WHERE u.id = p_user_id
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    INSERT INTO public.audit_log (user_id, action, target) VALUES (p_user_id, 'account.linked', p_provider);
  END IF;
  RETURN EXISTS (SELECT 1 FROM public.auth_accounts a WHERE a.provider = p_provider AND a.provider_account_id = p_sub
                  AND a.user_id = p_user_id);
END $$;
--> statement-breakpoint
-- Geweigerde login loggen zonder gebruiker: alleen acties login.*, alleen de soort reden (geen e-mailadres).
CREATE FUNCTION auth_audit_refusal(p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_reason IS NULL OR p_reason !~ '^[a-z-]{1,40}$' THEN
    RAISE EXCEPTION 'auth_audit_refusal: ongeldige reden' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.audit_log (user_id, action, target) VALUES (NULL, 'login.refused', p_reason);
END $$;
--> statement-breakpoint
-- Beheer: teamleden met laatste activiteit en aantal actieve sessies (geen tokens, geen user-agents).
CREATE FUNCTION admin_members_list()
RETURNS TABLE (id uuid, email text, name text, role text, blocked_at timestamptz, created_at timestamptz,
               last_seen_at timestamptz, active_sessions int)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  PERFORM public.e1_require_admin();
  RETURN QUERY
    SELECT u.id, u.email, u.name, u.role, u.blocked_at, u.created_at,
           (SELECT max(s.last_seen_at) FROM public.sessions s WHERE s.user_id = u.id),
           (SELECT count(*)::int FROM public.sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now())
      FROM public.users u ORDER BY u.created_at;
END $$;
--> statement-breakpoint
-- Beheer: de uitnodigingslijst.
CREATE FUNCTION admin_allowlist_list()
RETURNS TABLE (email text, role text, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
BEGIN
  PERFORM public.e1_require_admin();
  RETURN QUERY SELECT a.email, a.role, a.created_at FROM public.allowlist a ORDER BY a.email;
END $$;
--> statement-breakpoint
-- Beheer: iemand blokkeren (trekt meteen al zijn sessies in) of weer toelaten. Jezelf blokkeren kan niet.
-- Wijzigt alleen blocked_at, nooit de rol.
CREATE FUNCTION admin_set_user_blocked(p_user_id uuid, p_blocked boolean)
RETURNS TABLE (id uuid, email text, name text, role text, blocked_at timestamptz, created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE me uuid := public.e1_require_admin();
BEGIN
  IF p_user_id = me THEN
    RAISE EXCEPTION 'je kunt jezelf niet blokkeren' USING ERRCODE = '22023';
  END IF;
  UPDATE public.users u SET blocked_at = CASE WHEN p_blocked THEN coalesce(u.blocked_at, now()) ELSE NULL END
   WHERE u.id = p_user_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF p_blocked THEN
    UPDATE public.sessions s SET revoked_at = now() WHERE s.user_id = p_user_id AND s.revoked_at IS NULL;
  END IF;
  INSERT INTO public.audit_log (user_id, action, target)
    VALUES (me, CASE WHEN p_blocked THEN 'admin.blocked' ELSE 'admin.unblocked' END, p_user_id::text);
  RETURN QUERY SELECT u.id, u.email, u.name, u.role, u.blocked_at, u.created_at FROM public.users u WHERE u.id = p_user_id;
END $$;
--> statement-breakpoint
-- Beheer: iemand op de uitnodigingslijst zetten (of de rol daar wijzigen). Alleen het eigen domein.
CREATE FUNCTION admin_allowlist_add(p_email text, p_role text)
RETURNS TABLE (email text, role text, created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
#variable_conflict use_column
DECLARE me uuid := public.e1_require_admin(); e text := lower(btrim(coalesce(p_email, '')));
BEGIN
  IF e !~ '^[^@\s]+@homezero\.nl$' THEN
    RAISE EXCEPTION 'admin_allowlist_add: alleen @homezero.nl' USING ERRCODE = '22023';
  END IF;
  IF p_role NOT IN ('admin', 'member') THEN
    RAISE EXCEPTION 'admin_allowlist_add: ongeldige rol' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.allowlist AS a (email, role, added_by) VALUES (e, p_role, me)
    ON CONFLICT (email) DO UPDATE SET role = excluded.role;
  INSERT INTO public.audit_log (user_id, action, target) VALUES (me, 'admin.allowlist.add', e);
  RETURN QUERY SELECT a.email, a.role, a.created_at FROM public.allowlist a WHERE a.email = e;
END $$;
--> statement-breakpoint
CREATE FUNCTION admin_allowlist_remove(p_email text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE me uuid := public.e1_require_admin(); e text := lower(btrim(coalesce(p_email, ''))); n int;
BEGIN
  DELETE FROM public.allowlist a WHERE a.email = e;
  GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO public.audit_log (user_id, action, target) VALUES (me, 'admin.allowlist.remove', e);
  RETURN n > 0;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_allowlist_role(text), auth_apply_allowlist_role(uuid), auth_account_lookup(text, text),
  auth_link_account(uuid, text, text), auth_audit_refusal(text), admin_members_list(), admin_allowlist_list(),
  admin_set_user_blocked(uuid, boolean), admin_allowlist_add(text, text), admin_allowlist_remove(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_allowlist_role(text), auth_apply_allowlist_role(uuid), auth_account_lookup(text, text),
  auth_link_account(uuid, text, text), auth_audit_refusal(text), admin_members_list(), admin_allowlist_list(),
  admin_set_user_blocked(uuid, boolean), admin_allowlist_add(text, text), admin_allowlist_remove(text) TO hz_app;
