ALTER TABLE "skills" ADD COLUMN "application_key" varchar(64);--> statement-breakpoint
UPDATE "skills"
SET "application_key" = 'requirement-exploration'
WHERE "slug" = 'requirement-exploration';--> statement-breakpoint
CREATE INDEX "skills_application_idx" ON "skills" USING btree ("application_key");
