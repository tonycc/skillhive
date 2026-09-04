ALTER TABLE "employees" ADD COLUMN "legacy_user_id" uuid;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_legacy_user_id_users_id_fk" FOREIGN KEY ("legacy_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "employees_legacy_user_unique" ON "employees" USING btree ("legacy_user_id");