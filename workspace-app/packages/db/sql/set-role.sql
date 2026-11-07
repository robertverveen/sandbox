-- Beheerscript: de rol van één collega zetten (admin of member). Draai als de migratierol (eigenaar van users);
-- de app zelf kan geen rol zetten (auth_upsert_user maakt altijd 'member', migratie 0008).
--
--   psql "<url van de migratierol>" -v email=robert@homezero.nl -v role=admin -f packages/db/sql/set-role.sql
--
-- Schrijft een regel in audit_log. Faalt als het e-mailadres niet precies één gebruiker is.
\set ON_ERROR_STOP on
\o /dev/null
SELECT set_config('hz.email', :'email', false), set_config('hz.role', :'role', false);
\o
DO $$
DECLARE
  e text := lower(btrim(current_setting('hz.email')));
  r text := current_setting('hz.role');
  uid uuid;
  n int;
BEGIN
  IF r NOT IN ('admin', 'member') THEN
    RAISE EXCEPTION 'ongeldige rol % (admin of member)', r;
  END IF;
  UPDATE public.users u SET role = r WHERE lower(u.email) = e RETURNING u.id INTO uid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'geen (unieke) gebruiker met e-mailadres %', e;
  END IF;
  INSERT INTO public.audit_log (user_id, action, target, meta) VALUES (uid, 'user.role', 'users', jsonb_build_object('role', r));
END $$;
