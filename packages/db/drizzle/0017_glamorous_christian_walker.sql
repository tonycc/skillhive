CREATE TABLE "application_discovery_configs" (
	"application_key" varchar(64) PRIMARY KEY NOT NULL,
	"trigger_phrases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "trigger_phrases" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "application_discovery_configs" ADD CONSTRAINT "application_discovery_configs_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;