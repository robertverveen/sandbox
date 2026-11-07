CREATE TABLE "pins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"q" text,
	"view" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"theme" text DEFAULT 'system' NOT NULL,
	"calendars" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"extra" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "item_state" ADD COLUMN "plan_date" date;--> statement-breakpoint
ALTER TABLE "item_state" ADD COLUMN "backlog" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "item_state" ADD COLUMN "moved" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "repo_queue" ADD COLUMN "kind" text DEFAULT 'wachten-op' NOT NULL;--> statement-breakpoint
ALTER TABLE "repo_queue" ALTER COLUMN "kind" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "repo_queue" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "repo_queue" ADD COLUMN "commit_sha" text;--> statement-breakpoint
ALTER TABLE "pins" ADD CONSTRAINT "pins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preferences" ADD CONSTRAINT "preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pins_user_idx" ON "pins" USING btree ("user_id","position");
