-- Stuk E1 (HZW-012): een beheerder toevoegen of weghalen, als de migratierol (eigenaar van de tabellen).
-- De app zelf kan niemand beheerder maken zonder dat een beheerder dat doet (Instellingen → Team); dit script is
-- voor de eerste beheerder naast robert@homezero.nl, of als er geen beheerder meer is.
--
-- Gebruik: psql "$MIGRATIE_URL" -v email=naam@homezero.nl -v rol=admin -f packages/db/sql/e1-beheerder.sql
-- (rol = admin of member). De rol gaat in bij de volgende login (auth_apply_allowlist_role) en hier meteen.
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO allowlist (email, role) VALUES (lower(:'email'), :'rol')
  ON CONFLICT (email) DO UPDATE SET role = excluded.role;
UPDATE users SET role = :'rol' WHERE lower(email) = lower(:'email');
INSERT INTO audit_log (user_id, action, target) VALUES (NULL, 'admin.script.role', :'rol');
COMMIT;
