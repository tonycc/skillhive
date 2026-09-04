CREATE TYPE "public"."skill_type" AS ENUM('ordinary', 'application');--> statement-breakpoint
DROP INDEX "skills_application_idx";--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "skill_type" "skill_type" DEFAULT 'ordinary' NOT NULL;--> statement-breakpoint
UPDATE "skills" SET "skill_type" = 'application' WHERE "application_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "skills_type_idx" ON "skills" USING btree ("skill_type");--> statement-breakpoint
ALTER TABLE "skills" DROP COLUMN "application_key";
