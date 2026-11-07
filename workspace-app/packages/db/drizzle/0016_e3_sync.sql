-- Sync-motor (HZW-036). Handgeschreven. Stuk E3 (koppelingen en sync); bij samenvoegen golf A 0005 -> 0016. Rechten: zie 0017.
-- sync_state: cursors en metadata-cache per collega (syncToken, historyId, Slack last_read). Geen mailtekst of
--             Slack-geschiedenis (P2). Alleen de eigen rijen (RLS).
-- sync_jobs:  planning per collega en bron (volgende run, fouten, terugval). Geen inhoud of tokens; de worker
--             (app.purpose = 'system') mag plannen en webhooks mogen een run naar voren halen.
-- sync_events: binnengekomen push-events (Slack Events, Agenda-kanalen, Gmail Pub/Sub) om dubbele te negeren.
CREATE TABLE IF NOT EXISTS sync_state (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sync_jobs (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  account text,
  status text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'backoff', 'error', 'needs_reauth', 'disconnected')),
  failures integer NOT NULL DEFAULT 0,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  last_run_at timestamptz,
  last_ok_at timestamptz,
  last_changed integer NOT NULL DEFAULT 0,
  last_error text,
  push jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (user_id, provider)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sync_jobs_due_idx ON sync_jobs (next_run_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sync_jobs_account_idx ON sync_jobs (provider, account);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sync_events (
  source text NOT NULL,
  event_id text NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  PRIMARY KEY (source, event_id)
);
--> statement-breakpoint
ALTER TABLE sync_state ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sync_state FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY sync_state_own ON sync_state FOR ALL USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
--> statement-breakpoint
ALTER TABLE sync_jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sync_jobs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY sync_jobs_own ON sync_jobs FOR ALL
  USING (user_id = app_user_id() OR app_purpose() = 'system')
  WITH CHECK (user_id = app_user_id() OR app_purpose() = 'system');
--> statement-breakpoint
ALTER TABLE sync_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sync_events FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY sync_events_system ON sync_events FOR ALL
  USING (app_purpose() = 'system' OR user_id = app_user_id())
  WITH CHECK (app_purpose() = 'system' OR user_id = app_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON sync_state, sync_jobs, sync_events TO hz_app;
