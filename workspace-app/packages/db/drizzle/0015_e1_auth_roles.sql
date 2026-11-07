-- Samenvoegen van stuk E1 (inloggen, 0014) met stuk E2 (rollen, 0011 en 0013). Handgeschreven.
--
-- 0014 verleende de inlogfuncties van E1 aan hz_app. Sinds 0011 is inloggen alleen voor hz_auth (de sessie-middleware en
-- de adapter van Auth.js verbinden met de auth-login, HZ_AUTH_DATABASE_URL), en geeft app_user_id() in een request alleen
-- de gebruiker van de geldige sessie (app.session). Daarom:
-- 1. De inlogfuncties van E1 (uitnodigingslijst, Google-account, geweigerde login) alleen voor hz_auth, niet hz_app.
-- 2. Wat de adapter vóór een sessie nodig heeft, ook als hz_auth: een gebruiker bij id, de onboarding-rij bij de eerste
--    login, en een auditregel over inloggen en sessies (alleen acties session.*, login.*, user.*).
-- 3. Overal uitloggen vanuit een request als hz_app: hz_app heeft sinds 0013 geen UPDATE op sessions; de functie trekt
--    alleen de sessies van app_user_id() in (de gebruiker van de geldige sessie).
-- De beheerfuncties (admin_*) blijven voor hz_app: ze lezen de rol van app_user_id() zelf.
REVOKE ALL ON FUNCTION auth_allowlist_role(text), auth_apply_allowlist_role(uuid), auth_account_lookup(text, text),
  auth_link_account(uuid, text, text), auth_audit_refusal(text) FROM PUBLIC, hz_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_allowlist_role(text), auth_apply_allowlist_role(uuid), auth_account_lookup(text, text),
  auth_link_account(uuid, text, text), auth_audit_refusal(text) TO hz_auth;
--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('CREATE POLICY onboarding_definer ON onboarding TO %I USING (true) WITH CHECK (true)', current_user);
END $$;
--> statement-breakpoint
-- De gebruiker bij precies één id (de adapter: getUser, updateUser).
CREATE FUNCTION auth_user_by_id(p_user_id uuid)
RETURNS TABLE (id uuid, email text, name text, role text, blocked_at timestamptz, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT u.id, u.email, u.name, u.role, u.blocked_at, u.created_at FROM public.users u WHERE u.id = p_user_id
$$;
--> statement-breakpoint
-- Eerste login: de onboarding-rij (status new) voor een bestaande gebruiker; bestaat hij al, dan niets.
CREATE FUNCTION auth_init_onboarding(p_user_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO public.onboarding (user_id, status)
    SELECT u.id, 'new' FROM public.users u WHERE u.id = p_user_id
    ON CONFLICT (user_id) DO NOTHING;
END $$;
--> statement-breakpoint
-- Auditregel over inloggen en sessies buiten een request-sessie (bv. "ingelogd via google", "sessie op ander apparaat").
CREATE FUNCTION auth_audit_event(p_user_id uuid, p_action text, p_target text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_action IS NULL OR p_action !~ '^(session|login|user)\.[a-z.-]{1,40}$' THEN
    RAISE EXCEPTION 'auth_audit_event: alleen acties session.*, login.* of user.*' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = p_user_id) THEN
    RAISE EXCEPTION 'auth_audit_event: onbekende gebruiker' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.audit_log (user_id, action, target) VALUES (p_user_id, p_action, left(p_target, 200));
END $$;
--> statement-breakpoint
-- Overal uitloggen (eigen sessies), vanuit een request als hz_app. Geeft het aantal ingetrokken sessies.
CREATE FUNCTION auth_revoke_all_own_sessions() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE uid uuid := public.app_user_id(); n int;
BEGIN
  IF uid IS NULL THEN RETURN 0; END IF;
  UPDATE public.sessions s SET revoked_at = now() WHERE s.user_id = uid AND s.revoked_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO public.audit_log (user_id, action, meta) VALUES (uid, 'session.revoked-all', jsonb_build_object('n', n));
  RETURN n;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION auth_user_by_id(uuid), auth_init_onboarding(uuid), auth_audit_event(uuid, text, text),
  auth_revoke_all_own_sessions() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_user_by_id(uuid), auth_init_onboarding(uuid), auth_audit_event(uuid, text, text) TO hz_auth;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION auth_revoke_all_own_sessions() TO hz_app;
