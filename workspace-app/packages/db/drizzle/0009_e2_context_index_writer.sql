-- Schrijven in de contextindex alleen door de indexer (stuk E2, HZW-020). Handgeschreven.
--
-- Probleem (criticus ronde 1): context_index_write gold voor app_purpose() = 'index'. app.purpose is een GUC die
-- elke transactie kan zetten; een gewone request-transactie met set_config('app.purpose', 'index', true) kon de
-- gedeelde index wijzigen, ook geheim_voor.
-- Oplossing:
-- - hz_app krijgt geen INSERT, UPDATE of DELETE meer op context_index, en de regel op app.purpose is weg;
-- - schrijven gaat via twee SECURITY DEFINER-functies van de migratierol: context_index_upsert(rijen) en
--   context_index_delete(pad). Ze weigeren admin.md in SQL (pad of sleutel) en controleren soort, pad en titel;
-- - alleen de rol hz_indexer (NOLOGIN, aangemaakt door sql/bootstrap-roles.sql) mag ze uitvoeren. De indexer en
--   het importscript verbinden met een eigen login die lid is van hz_indexer (sql/indexer-login.sql); de login van
--   de app (hz_app_login) is dat niet, en kan dus ook niet SET ROLE hz_indexer doen.
-- Lezen blijft voor iedereen (context_index_read).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hz_indexer') THEN
    RAISE EXCEPTION 'rol hz_indexer ontbreekt. Laat een beheerder packages/db/sql/bootstrap-roles.sql (opnieuw) draaien (zie README, Database).';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hz_indexer' AND (rolsuper OR rolbypassrls OR rolcanlogin)) THEN
    RAISE EXCEPTION 'rol hz_indexer mag geen superuser, BYPASSRLS of login hebben';
  END IF;
END $$;
--> statement-breakpoint
DROP POLICY IF EXISTS context_index_write ON context_index;
--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON context_index FROM hz_app;
--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('CREATE POLICY context_index_definer ON context_index FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO hz_indexer;
--> statement-breakpoint
GRANT SELECT ON context_index TO hz_indexer;
--> statement-breakpoint
-- Rijen toevoegen of bijwerken. p_rows: JSON-lijst van {id, kind, slug, path, title, body, data, geheim_voor, commit}.
-- Geeft alleen de rijen terug die echt nieuw of gewijzigd zijn (row_id, was_inserted). Dubbele id's: de laatste telt.
CREATE FUNCTION context_index_upsert(p_rows jsonb)
RETURNS TABLE (row_id text, was_inserted boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE bad text;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'context_index_upsert: verwacht een JSON-lijst' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(r->>'path', r->>'id') INTO bad FROM jsonb_array_elements(p_rows) r
   WHERE coalesce(r->>'path', '') ~* '(^|/)admin\.md($|#)' OR coalesce(r->>'id', '') ~* '(^|/)admin\.md($|#)' LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'context_index_upsert: admin.md hoort nooit in de index' USING ERRCODE = '42501';
  END IF;
  SELECT coalesce(r->>'id', '?') INTO bad FROM jsonb_array_elements(p_rows) r
   WHERE jsonb_typeof(r) <> 'object'
      OR coalesce(r->>'id', '') = '' OR coalesce(r->>'path', '') = '' OR r->>'title' IS NULL
      OR coalesce(r->>'kind', '') NOT IN ('partner', 'project', 'actie', 'meeting', 'besluit', 'product', 'overig')
      OR (r ? 'geheim_voor' AND jsonb_typeof(r->'geheim_voor') NOT IN ('array', 'null'))
      OR (r ? 'data' AND jsonb_typeof(r->'data') NOT IN ('object', 'null'))
   LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'context_index_upsert: ongeldige rij %', left(bad, 200) USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH src AS (
    SELECT DISTINCT ON (r.value->>'id')
           r.value->>'id' AS id, r.value->>'kind' AS kind, r.value->>'slug' AS slug, r.value->>'path' AS path,
           r.value->>'title' AS title, coalesce(r.value->>'body', '') AS body,
           coalesce(nullif(r.value->'data', 'null'::jsonb), '{}'::jsonb) AS data,
           coalesce(ARRAY(SELECT jsonb_array_elements_text(nullif(r.value->'geheim_voor', 'null'::jsonb))), '{}'::text[]) AS geheim_voor,
           r.value->>'commit' AS commit
      FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS r(value, n)
     ORDER BY r.value->>'id', r.n DESC
  )
  INSERT INTO public.context_index AS c (id, kind, slug, path, title, body, data, geheim_voor, commit, updated_at)
  SELECT s.id, s.kind, s.slug, s.path, s.title, s.body, s.data, s.geheim_voor, s.commit, now() FROM src s
  ON CONFLICT (id) DO UPDATE SET
    kind = excluded.kind, slug = excluded.slug, path = excluded.path, title = excluded.title, body = excluded.body,
    data = excluded.data, geheim_voor = excluded.geheim_voor, commit = excluded.commit, updated_at = now()
  WHERE (c.kind, c.slug, c.path, c.title, c.body, c.data, c.geheim_voor, c.commit)
        IS DISTINCT FROM (excluded.kind, excluded.slug, excluded.path, excluded.title, excluded.body, excluded.data,
                          excluded.geheim_voor, excluded.commit)
  RETURNING c.id, (c.xmax = 0);
END $$;
--> statement-breakpoint
-- Alle rijen van één bestand weghalen (bestand verwijderd of hernoemd in de contextlaag). Geeft het aantal terug.
CREATE FUNCTION context_index_delete(p_path text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n int;
BEGIN
  IF p_path IS NULL OR btrim(p_path) = '' OR p_path ~ '[%*]' THEN
    RAISE EXCEPTION 'context_index_delete: geef precies één pad' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.context_index c WHERE c.path = p_path;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION context_index_upsert(jsonb), context_index_delete(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION context_index_upsert(jsonb), context_index_delete(text) TO hz_indexer;
