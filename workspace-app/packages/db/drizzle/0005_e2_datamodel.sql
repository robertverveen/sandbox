CREATE TABLE "tracker_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"legacy_id" text,
	"stroom" text NOT NULL,
	"wat" text NOT NULL,
	"aan" text DEFAULT '' NOT NULL,
	"org" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"deadline" date,
	"plan_date" date,
	"backlog" boolean DEFAULT false NOT NULL,
	"moved" integer DEFAULT 0 NOT NULL,
	"reminder" date,
	"naar" text,
	"overgezet" boolean DEFAULT false NOT NULL,
	"gtask" text,
	"src_key" text,
	"bron" jsonb,
	"citaat" text DEFAULT '' NOT NULL,
	"bewijs" text,
	"created" date,
	"closed_at" date,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "weekdoelen" ADD COLUMN "legacy_id" text;--> statement-breakpoint
ALTER TABLE "weekdoelen" ADD COLUMN "extra" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tracker_items" ADD CONSTRAINT "tracker_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tracker_items_user_legacy_uq" ON "tracker_items" USING btree ("user_id","legacy_id");--> statement-breakpoint
CREATE INDEX "tracker_items_user_status_idx" ON "tracker_items" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "weekdoelen_user_legacy_uq" ON "weekdoelen" USING btree ("user_id","legacy_id");--> statement-breakpoint
-- Handgeschreven (stuk E2, HZW-020): rij-beveiliging voor tracker_items, zoals elke tabel met user_id.
-- De rechten voor hz_app komen uit de default privileges van 0004 (SELECT, INSERT, UPDATE, DELETE).
ALTER TABLE "tracker_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "tracker_items" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tracker_items_own ON "tracker_items" FOR ALL USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
--> statement-breakpoint
-- Statussen en stromen als harde regel in de database (de import valideert ook, dit is de vangrail).
ALTER TABLE "tracker_items" ADD CONSTRAINT tracker_items_stroom_ck CHECK (stroom IN ('mijn', 'voornemen', 'aan_mij', 'bespreken'));
--> statement-breakpoint
ALTER TABLE "tracker_items" ADD CONSTRAINT tracker_items_status_ck CHECK (status IN ('open', 'waarschijnlijk_klaar', 'klaar', 'te_laat', 'overgedragen', 'losgelaten'));
