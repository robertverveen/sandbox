-- Samenvoegen van stuk E3 (sync, 0016) met stuk E2 (rollen, 0006-0013). Handgeschreven.
--
-- 0016 gaf de planning (sync_jobs) en de push-events (sync_events) van alle collega's vrij aan elke transactie met
-- app.purpose = 'system'. Sinds E2 opent een GUC niets meer: elke transactie, ook een request van de api (of een
-- SQL-injectie daarin), kan app.purpose zelf zetten. Daarom:
-- 1. 'system' telt alleen als de login (session_user, niet te veranderen met SET ROLE) lid is van hz_worker: de worker.
--    De api-login is daar geen lid van (zie sql/app-login.sql en assertAppLogin).
-- 2. De webhooks in de api (Slack Events, Agenda, Gmail) hebben geen ingelogde collega. Ze krijgen SECURITY
--    DEFINER-functies die precies één ding doen: de collega('s) bij een extern account of kanaal opzoeken, een event
--    ontdubbelen en een run naar voren halen. Geen inhoud, geen tokens, geen planning lezen.
CREATE FUNCTION app_system() RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT coalesce(current_setting('app.purpose', true), '') = 'system'
     AND pg_has_role(session_user, 'hz_worker', 'MEMBER')
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_system() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_system() TO hz_app;
--> statement-breakpoint
ALTER POLICY sync_jobs_own ON sync_jobs
  USING (user_id = (SELECT app_user_id()) OR (SELECT app_system()))
  WITH CHECK (user_id = (SELECT app_user_id()) OR (SELECT app_system()));
--> statement-breakpoint
ALTER POLICY sync_events_system ON sync_events
  USING ((SELECT app_system()) OR user_id = (SELECT app_user_id()))
  WITH CHECK ((SELECT app_system()) OR user_id = (SELECT app_user_id()));
--> statement-breakpoint
ALTER POLICY sync_state_own ON sync_state
  USING (user_id = (SELECT app_user_id()))
  WITH CHECK (user_id = (SELECT app_user_id()));
--> statement-breakpoint
-- De functies hieronder draaien als de migratierol; door FORCE ROW LEVEL SECURITY valt die ook onder RLS.
DO $$
BEGIN
  EXECUTE format('CREATE POLICY sync_jobs_definer ON sync_jobs TO %I USING (true) WITH CHECK (true)', current_user);
  EXECUTE format('CREATE POLICY sync_events_definer ON sync_events TO %I USING (true) WITH CHECK (true)', current_user);
END $$;
--> statement-breakpoint
-- Collega bij een extern account (Slack-gebruiker, Google-adres) met een planningsrij voor die bron.
CREATE FUNCTION sync_hook_user_by_account(p_provider text, p_account text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT j.user_id FROM public.sync_jobs j
   WHERE j.provider = p_provider AND p_account IS NOT NULL AND lower(j.account) = lower(p_account)
   LIMIT 1
$$;
--> statement-breakpoint
-- Collega bij een push-kanaal (Agenda): het kanaal-id staat in sync_jobs.push.channels.
CREATE FUNCTION sync_hook_user_by_channel(p_provider text, p_channel text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT j.user_id FROM public.sync_jobs j
   WHERE j.provider = p_provider AND p_channel IS NOT NULL AND j.push -> 'channels' ? p_channel
   LIMIT 1
$$;
--> statement-breakpoint
-- Collega's met een Slack-sync die dit kanaal kennen.
CREATE FUNCTION sync_hook_users_by_slack_channel(p_channel text) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT j.user_id FROM public.sync_jobs j
   WHERE j.provider = 'slack' AND p_channel IS NOT NULL AND j.push -> 'slackChannels' ? p_channel
$$;
--> statement-breakpoint
-- Collega's met een planningsrij voor deze bron, met het externe account (om Slack-autorisaties te koppelen).
CREATE FUNCTION sync_hook_users_with_job(p_provider text) RETURNS TABLE (user_id uuid, account text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT j.user_id, j.account FROM public.sync_jobs j WHERE j.provider = p_provider
$$;
--> statement-breakpoint
-- Event bewaren als het nieuw is (true) of negeren als het dubbel is (false). Geen inhoud: alleen wat de motor nodig
-- heeft om de juiste run te starten (zie sync-hooks.ts).
CREATE FUNCTION sync_hook_record_event(p_source text, p_event_id text, p_user_id uuid, p_payload jsonb)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n int;
BEGIN
  IF p_source IS NULL OR p_source !~ '^[a-z_:.-]{1,40}$' OR p_event_id IS NULL OR length(p_event_id) > 300 THEN
    RAISE EXCEPTION 'sync_hook_record_event: ongeldige bron of event-id' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.sync_events (source, event_id, user_id, payload)
    VALUES (p_source, p_event_id, p_user_id, coalesce(p_payload, '{}'::jsonb))
    ON CONFLICT (source, event_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;
--> statement-breakpoint
-- Run zo snel mogelijk (push of klik). Alleen tijd en status; niet voor bronnen die opnieuw gekoppeld moeten worden.
CREATE FUNCTION sync_hook_request(p_user_id uuid, p_provider text, p_now timestamptz DEFAULT now()) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  UPDATE public.sync_jobs SET next_run_at = least(coalesce(p_now, now()), now() + interval '1 minute'),
         status = CASE WHEN status IN ('error', 'backoff') THEN status ELSE 'idle' END
   WHERE user_id = p_user_id AND provider = p_provider AND status NOT IN ('needs_reauth', 'disconnected')
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION sync_hook_user_by_account(text, text), sync_hook_user_by_channel(text, text),
  sync_hook_users_by_slack_channel(text), sync_hook_users_with_job(text),
  sync_hook_record_event(text, text, uuid, jsonb), sync_hook_request(uuid, text, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION sync_hook_user_by_account(text, text), sync_hook_user_by_channel(text, text),
  sync_hook_users_by_slack_channel(text), sync_hook_users_with_job(text),
  sync_hook_record_event(text, text, uuid, jsonb), sync_hook_request(uuid, text, timestamptz) TO hz_app;
