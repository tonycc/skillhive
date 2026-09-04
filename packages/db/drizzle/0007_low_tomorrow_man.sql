CREATE TYPE "public"."consent_status" AS ENUM('pending', 'confirmed', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."employee_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."exploration_state" AS ENUM('discussing', 'submitted', 'editing', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."requirement_review_status" AS ENUM('pending_review', 'needs_information', 'in_review', 'accepted', 'deferred', 'rejected');--> statement-breakpoint
CREATE TABLE "employee_consents" (
	"employee_id" uuid PRIMARY KEY NOT NULL,
	"status" "consent_status" DEFAULT 'pending' NOT NULL,
	"notice_version" varchar(64),
	"channel" varchar(64),
	"evidence_ref" varchar(512),
	"verified_by" uuid,
	"confirmed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employee_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"name" varchar(128) DEFAULT 'WorkBuddy' NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"scopes" text[] NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"issued_by" uuid,
	CONSTRAINT "employee_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_no" varchar(64) NOT NULL,
	"name" varchar(128) NOT NULL,
	"email" varchar(256),
	"department_id" uuid,
	"status" "employee_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employees_employee_no_unique" UNIQUE("employee_no")
);
--> statement-breakpoint
CREATE TABLE "exploration_audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_type" varchar(16) NOT NULL,
	"actor_id" uuid,
	"action" varchar(64) NOT NULL,
	"exploration_id" uuid,
	"requirement_id" uuid,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exploration_idempotency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"operation" varchar(64) NOT NULL,
	"key" varchar(128) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"response" jsonb NOT NULL,
	"status_code" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exploration_policies" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	"skill_id" uuid,
	"skill_version_id" uuid,
	"notice_version" varchar(64) DEFAULT '1.0' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exploration_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exploration_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"content" jsonb NOT NULL,
	"created_by_token_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "explorations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" varchar(40) NOT NULL,
	"employee_id" uuid NOT NULL,
	"skill_id" uuid,
	"skill_version_id" uuid,
	"rule_content_hash" varchar(64),
	"title" varchar(128) DEFAULT '未命名需求探索' NOT NULL,
	"state" "exploration_state" DEFAULT 'discussing' NOT NULL,
	"current_revision" integer DEFAULT 0 NOT NULL,
	"last_submitted_revision" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"abandoned_at" timestamp with time zone,
	CONSTRAINT "explorations_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "requirement_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requirement_id" uuid NOT NULL,
	"exploration_revision_id" uuid NOT NULL,
	"submission" integer NOT NULL,
	"submitted_by_token_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" varchar(40) NOT NULL,
	"exploration_id" uuid NOT NULL,
	"review_status" "requirement_review_status" DEFAULT 'pending_review' NOT NULL,
	"current_submission" integer DEFAULT 1 NOT NULL,
	"review_revision" integer DEFAULT 0 NOT NULL,
	"public_feedback" text,
	"internal_note" text,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requirements_number_unique" UNIQUE("number"),
	CONSTRAINT "requirements_exploration_id_unique" UNIQUE("exploration_id")
);
--> statement-breakpoint
ALTER TABLE "employee_consents" ADD CONSTRAINT "employee_consents_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_consents" ADD CONSTRAINT "employee_consents_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_tokens" ADD CONSTRAINT "employee_tokens_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_tokens" ADD CONSTRAINT "employee_tokens_issued_by_users_id_fk" FOREIGN KEY ("issued_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exploration_audit_events" ADD CONSTRAINT "exploration_audit_events_exploration_id_explorations_id_fk" FOREIGN KEY ("exploration_id") REFERENCES "public"."explorations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exploration_audit_events" ADD CONSTRAINT "exploration_audit_events_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exploration_idempotency" ADD CONSTRAINT "exploration_idempotency_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exploration_policies" ADD CONSTRAINT "exploration_policies_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exploration_policies" ADD CONSTRAINT "exploration_policies_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exploration_policies" ADD CONSTRAINT "exploration_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exploration_revisions" ADD CONSTRAINT "exploration_revisions_exploration_id_explorations_id_fk" FOREIGN KEY ("exploration_id") REFERENCES "public"."explorations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exploration_revisions" ADD CONSTRAINT "exploration_revisions_created_by_token_id_employee_tokens_id_fk" FOREIGN KEY ("created_by_token_id") REFERENCES "public"."employee_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "explorations" ADD CONSTRAINT "explorations_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "explorations" ADD CONSTRAINT "explorations_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "explorations" ADD CONSTRAINT "explorations_skill_version_id_skill_versions_id_fk" FOREIGN KEY ("skill_version_id") REFERENCES "public"."skill_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_submissions" ADD CONSTRAINT "requirement_submissions_requirement_id_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_submissions" ADD CONSTRAINT "requirement_submissions_exploration_revision_id_exploration_revisions_id_fk" FOREIGN KEY ("exploration_revision_id") REFERENCES "public"."exploration_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_submissions" ADD CONSTRAINT "requirement_submissions_submitted_by_token_id_employee_tokens_id_fk" FOREIGN KEY ("submitted_by_token_id") REFERENCES "public"."employee_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_exploration_id_explorations_id_fk" FOREIGN KEY ("exploration_id") REFERENCES "public"."explorations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employee_tokens_employee_idx" ON "employee_tokens" USING btree ("employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_email_unique" ON "employees" USING btree ("email");--> statement-breakpoint
CREATE INDEX "employees_department_idx" ON "employees" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "exploration_audit_time_idx" ON "exploration_audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "exploration_idempotency_key_unique" ON "exploration_idempotency" USING btree ("employee_id","operation","key");--> statement-breakpoint
CREATE INDEX "exploration_idempotency_expiry_idx" ON "exploration_idempotency" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "exploration_revisions_number_unique" ON "exploration_revisions" USING btree ("exploration_id","revision");--> statement-breakpoint
CREATE INDEX "exploration_revisions_exploration_idx" ON "exploration_revisions" USING btree ("exploration_id","created_at");--> statement-breakpoint
CREATE INDEX "explorations_employee_updated_idx" ON "explorations" USING btree ("employee_id","updated_at");--> statement-breakpoint
CREATE INDEX "explorations_state_updated_idx" ON "explorations" USING btree ("state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "requirement_submissions_number_unique" ON "requirement_submissions" USING btree ("requirement_id","submission");--> statement-breakpoint
CREATE UNIQUE INDEX "requirement_submissions_revision_unique" ON "requirement_submissions" USING btree ("exploration_revision_id");--> statement-breakpoint
CREATE INDEX "requirements_status_updated_idx" ON "requirements" USING btree ("review_status","updated_at");