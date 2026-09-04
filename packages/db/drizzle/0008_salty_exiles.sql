CREATE TABLE "requirement_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requirement_id" uuid NOT NULL,
	"submission" integer NOT NULL,
	"review_revision" integer NOT NULL,
	"status" "requirement_review_status" NOT NULL,
	"public_feedback" text,
	"internal_note" text,
	"reviewed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "employee_tokens" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "employee_tokens" ADD COLUMN "delivery_channel" varchar(64);--> statement-breakpoint
ALTER TABLE "explorations" ADD COLUMN "rule_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "explorations" ADD COLUMN "department_id" uuid;--> statement-breakpoint
ALTER TABLE "requirement_reviews" ADD CONSTRAINT "requirement_reviews_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_reviews" ADD CONSTRAINT "requirement_reviews_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "requirement_reviews_revision_unique" ON "requirement_reviews" USING btree ("requirement_id","review_revision");--> statement-breakpoint
CREATE INDEX "requirement_reviews_requirement_idx" ON "requirement_reviews" USING btree ("requirement_id","created_at");--> statement-breakpoint
ALTER TABLE "explorations" ADD CONSTRAINT "explorations_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;