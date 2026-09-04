ALTER TABLE "employees" DROP CONSTRAINT "employees_employee_no_unique";--> statement-breakpoint
ALTER TABLE "employees" DROP CONSTRAINT "employees_legacy_user_id_users_id_fk";
--> statement-breakpoint
DROP INDEX "employees_legacy_user_unique";--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "phone" varchar(16);--> statement-breakpoint
ALTER TABLE "employees" DROP COLUMN "employee_no";--> statement-breakpoint
ALTER TABLE "employees" DROP COLUMN "legacy_user_id";--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_phone_unique" UNIQUE("phone");