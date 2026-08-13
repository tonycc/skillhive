ALTER TABLE "users" ADD COLUMN "session_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
WITH "duplicates" AS (
	SELECT "id", row_number() OVER (
		PARTITION BY "skill_id", "version"
		ORDER BY "created_at" DESC, "id" DESC
	) AS "position"
	FROM "skill_versions"
)
DELETE FROM "skill_versions"
USING "duplicates"
WHERE "skill_versions"."id" = "duplicates"."id"
	AND "duplicates"."position" > 1;--> statement-breakpoint
WITH "duplicates" AS (
	SELECT "id", row_number() OVER (
		PARTITION BY "version_id", "path"
		ORDER BY "created_at" DESC, "id" DESC
	) AS "position"
	FROM "skill_version_files"
)
DELETE FROM "skill_version_files"
USING "duplicates"
WHERE "skill_version_files"."id" = "duplicates"."id"
	AND "duplicates"."position" > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_version_files_version_path_unique" ON "skill_version_files" USING btree ("version_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_versions_skill_version_unique" ON "skill_versions" USING btree ("skill_id","version");
