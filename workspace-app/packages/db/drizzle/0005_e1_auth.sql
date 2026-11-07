-- Stuk E1: inloggen, teamleden, onboarding en koppelingen (HZW-010 t/m 014). Handgeschreven, los van het fundament.
-- Nieuwe tabellen: allowlist (uitnodigingslijst), auth_accounts (Google-sub bij een gebruiker, geen tokens),
-- connect_flows (lopende OAuth-koppelingen: gehashte state en PKCE-verifier), onboarding (wizard per collega).
-- Nieuw doel (app.purpose) 'admin': alleen gezet door withAdmin() nadat in dezelfde transactie is gecontroleerd dat
-- app.user_id een niet-geblokkeerde beheerder is. Daarmee mag de beheerder teamleden zien en blokkeren.
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
ALTER TABLE allowlist ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE allowlist FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY allowlist_auth_admin ON allowlist FOR ALL USING (app_purpose() IN ('auth', 'admin')) WITH CHECK (app_purpose() IN ('auth', 'admin'));
--> statement-breakpoint
ALTER TABLE auth_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE auth_accounts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY auth_accounts_own ON auth_accounts FOR ALL USING (user_id = app_user_id() OR app_purpose() = 'auth') WITH CHECK (user_id = app_user_id() OR app_purpose() = 'auth');
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
-- Beheer: teamleden zien en blokkeren, sessies van een geblokkeerde collega intrekken. Alleen met purpose 'admin'.
CREATE POLICY users_admin_select ON users FOR SELECT USING (app_purpose() = 'admin');
--> statement-breakpoint
CREATE POLICY users_admin_update ON users FOR UPDATE USING (app_purpose() = 'admin') WITH CHECK (app_purpose() = 'admin');
--> statement-breakpoint
CREATE POLICY sessions_admin_select ON sessions FOR SELECT USING (app_purpose() = 'admin');
--> statement-breakpoint
CREATE POLICY sessions_admin_update ON sessions FOR UPDATE USING (app_purpose() = 'admin') WITH CHECK (app_purpose() = 'admin');
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON allowlist, auth_accounts, connect_flows, onboarding TO hz_app;
