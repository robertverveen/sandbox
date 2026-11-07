CREATE TABLE "import_keys" (
	"user_id" uuid NOT NULL,
	"tabel" text NOT NULL,
	"sleutel" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_keys_user_id_tabel_sleutel_pk" PRIMARY KEY("user_id","tabel","sleutel")
);
--> statement-breakpoint
ALTER TABLE "tracker_items" ADD COLUMN "imported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "weekdoelen" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "weekdoelen" ADD COLUMN "imported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "import_keys" ADD CONSTRAINT "import_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Handgeschreven (stuk E2, HZW-021): opnieuw importeren zet niets terug wat de collega in de app wijzigde.
--
-- updated_at: een trigger zet hem bij elke UPDATE, ook als app-code het vergeet. Is het de import zelf (die zet
-- imported_at), dan wordt updated_at gelijk aan imported_at; anders de klok (clock_timestamp()). Daarmee betekent
-- updated_at > imported_at: na de laatste import in de app gewijzigd. De import werkt zo'n rij niet meer bij.
-- Bestaande geïmporteerde rijen (legacy_id gezet) tellen als "net geïmporteerd".
UPDATE "weekdoelen" SET "updated_at" = "created_at" WHERE "legacy_id" IS NULL;
--> statement-breakpoint
UPDATE "weekdoelen" SET "imported_at" = "updated_at" WHERE "legacy_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "tracker_items" SET "imported_at" = "updated_at" WHERE "legacy_id" IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION hz_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.imported_at IS DISTINCT FROM OLD.imported_at THEN
    NEW.updated_at := NEW.imported_at;
  ELSE
    NEW.updated_at := clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION hz_touch_updated_at() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER weekdoelen_touch BEFORE UPDATE ON "weekdoelen" FOR EACH ROW EXECUTE FUNCTION hz_touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER tracker_items_touch BEFORE UPDATE ON "tracker_items" FOR EACH ROW EXECUTE FUNCTION hz_touch_updated_at();
--> statement-breakpoint
-- import_keys: per collega, zoals elke tabel met user_id. Rechten voor hz_app uit de default privileges van 0004.
ALTER TABLE "import_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "import_keys" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY import_keys_own ON "import_keys" FOR ALL USING (user_id = app_user_id()) WITH CHECK (user_id = app_user_id());
--> statement-breakpoint
ALTER TABLE "import_keys" ADD CONSTRAINT import_keys_tabel_ck CHECK (tabel IN ('tracker_items', 'weekdoelen', 'pins', 'briefings'));
