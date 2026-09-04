import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, gte, ilike, lte, or } from "drizzle-orm";
import {
  db,
  departments,
  employees,
  explorationAuditEvents,
  explorationRevisions,
  explorations,
  requirements,
  requirementSubmissions,
  requirementReviews,
  skillVersions,
  users,
} from "@skillhive/db";
import { requireAdmin, type SessionUser } from "../auth.js";

type AppEnv = { Variables: { user: SessionUser } };
const app = new Hono<AppEnv>();
app.use("*", requireAdmin);

const reviewSchema = z.object({
  expectedRevision: z.number().int().min(0),
  expectedSubmission: z.number().int().min(1),
  status: z.enum([
    "pending_review",
    "needs_information",
    "in_review",
    "accepted",
    "deferred",
    "rejected",
  ]),
  publicFeedback: z.string().trim().max(8_000).nullish(),
  internalNote: z.string().trim().max(8_000).nullish(),
}).superRefine((value, ctx) => {
  if (["needs_information", "accepted", "deferred", "rejected"].includes(value.status) && !value.publicFeedback) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["publicFeedback"],
      message: "待补充或结论状态必须填写员工可见的理由",
    });
  }
});
const requirementListSchema = z.object({
  keyword: z.string().trim().max(128).optional(),
  reviewStatus: z.enum([
    "pending_review",
    "needs_information",
    "in_review",
    "accepted",
    "deferred",
    "rejected",
  ]).optional(),
  employee: z.string().trim().max(128).optional(),
  departmentId: z.string().uuid().optional(),
  skillVersion: z.string().trim().max(64).optional(),
  submittedFrom: z.coerce.date().optional(),
  submittedTo: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).refine((value) => !value.submittedFrom || !value.submittedTo || value.submittedFrom <= value.submittedTo, {
  message: "提交时间起点不能晚于终点",
  path: ["submittedFrom"],
});

app.get("/", zValidator("query", requirementListSchema), async (c) => {
  const query = c.req.valid("query");
  const conditions = [];
  if (query.keyword) {
    const pattern = `%${query.keyword}%`;
    conditions.push(or(
      ilike(requirements.number, pattern),
      ilike(explorations.number, pattern),
      ilike(explorations.title, pattern),
      ilike(employees.phone, pattern),
      ilike(employees.name, pattern),
      ilike(departments.name, pattern),
      ilike(skillVersions.version, pattern),
    )!);
  }
  if (query.reviewStatus) conditions.push(eq(requirements.reviewStatus, query.reviewStatus));
  if (query.employee) {
    const pattern = `%${query.employee}%`;
    conditions.push(or(ilike(employees.phone, pattern), ilike(employees.name, pattern))!);
  }
  if (query.departmentId) conditions.push(eq(explorations.departmentId, query.departmentId));
  if (query.skillVersion) conditions.push(eq(skillVersions.version, query.skillVersion));
  if (query.submittedFrom) conditions.push(gte(requirementSubmissions.createdAt, query.submittedFrom));
  if (query.submittedTo) conditions.push(lte(requirementSubmissions.createdAt, query.submittedTo));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const rows = await db.select({
    id: requirements.id,
    number: requirements.number,
    reviewStatus: requirements.reviewStatus,
    currentSubmission: requirements.currentSubmission,
    reviewRevision: requirements.reviewRevision,
    publicFeedback: requirements.publicFeedback,
    updatedAt: requirements.updatedAt,
    explorationId: explorations.id,
    explorationNumber: explorations.number,
    title: explorations.title,
    explorationState: explorations.state,
    currentRevision: explorations.currentRevision,
    submittedRevision: explorations.lastSubmittedRevision,
    employeeId: employees.id,
    employeePhone: employees.phone,
    employeeName: employees.name,
    departmentName: departments.name,
    skillVersion: skillVersions.version,
    submittedAt: requirementSubmissions.createdAt,
  }).from(requirements)
    .innerJoin(explorations, eq(requirements.explorationId, explorations.id))
    .innerJoin(employees, eq(explorations.employeeId, employees.id))
    .innerJoin(requirementSubmissions, and(
      eq(requirementSubmissions.requirementId, requirements.id),
      eq(requirementSubmissions.submission, requirements.currentSubmission),
    ))
    .leftJoin(departments, eq(explorations.departmentId, departments.id))
    .leftJoin(skillVersions, eq(explorations.skillVersionId, skillVersions.id))
    .where(where)
    .orderBy(desc(requirements.updatedAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  const [totalRow] = await db.select({ value: count() })
    .from(requirements)
    .innerJoin(explorations, eq(requirements.explorationId, explorations.id))
    .innerJoin(employees, eq(explorations.employeeId, employees.id))
    .innerJoin(requirementSubmissions, and(
      eq(requirementSubmissions.requirementId, requirements.id),
      eq(requirementSubmissions.submission, requirements.currentSubmission),
    ))
    .leftJoin(departments, eq(explorations.departmentId, departments.id))
    .leftJoin(skillVersions, eq(explorations.skillVersionId, skillVersions.id))
    .where(where);
  return c.json({ data: {
    items: rows.map((row) => ({
      ...row,
      hasUnsubmittedChanges: row.explorationState === "editing",
    })),
    total: totalRow?.value ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  } });
});

app.get("/:id", async (c) => {
  const id = c.req.param("id");
  if (!z.string().uuid().safeParse(id).success) return c.json({ error: "无效的需求 ID" }, 400);
  const [row] = await db.select({
    id: requirements.id,
    number: requirements.number,
    reviewStatus: requirements.reviewStatus,
    currentSubmission: requirements.currentSubmission,
    reviewRevision: requirements.reviewRevision,
    publicFeedback: requirements.publicFeedback,
    internalNote: requirements.internalNote,
    reviewedAt: requirements.reviewedAt,
    createdAt: requirements.createdAt,
    updatedAt: requirements.updatedAt,
    explorationId: explorations.id,
    explorationNumber: explorations.number,
    title: explorations.title,
    explorationState: explorations.state,
    currentRevision: explorations.currentRevision,
    submittedRevision: explorations.lastSubmittedRevision,
    employeeId: employees.id,
    employeePhone: employees.phone,
    employeeName: employees.name,
    departmentName: departments.name,
    skillVersion: skillVersions.version,
  }).from(requirements)
    .innerJoin(explorations, eq(requirements.explorationId, explorations.id))
    .innerJoin(employees, eq(explorations.employeeId, employees.id))
    .leftJoin(departments, eq(explorations.departmentId, departments.id))
    .leftJoin(skillVersions, eq(explorations.skillVersionId, skillVersions.id))
    .where(eq(requirements.id, id)).limit(1);
  if (!row) return c.json({ error: "需求不存在" }, 404);
  const submissions = await db.select({
    id: requirementSubmissions.id,
    submission: requirementSubmissions.submission,
    submittedAt: requirementSubmissions.createdAt,
    revision: explorationRevisions.revision,
    content: explorationRevisions.content,
  }).from(requirementSubmissions)
    .innerJoin(explorationRevisions, eq(requirementSubmissions.explorationRevisionId, explorationRevisions.id))
    .where(eq(requirementSubmissions.requirementId, id))
    .orderBy(desc(requirementSubmissions.submission));
  const reviews = await db.select({
    id: requirementReviews.id,
    submission: requirementReviews.submission,
    reviewRevision: requirementReviews.reviewRevision,
    status: requirementReviews.status,
    publicFeedback: requirementReviews.publicFeedback,
    internalNote: requirementReviews.internalNote,
    reviewedBy: requirementReviews.reviewedBy,
    reviewerName: users.name,
    createdAt: requirementReviews.createdAt,
  }).from(requirementReviews)
    .leftJoin(users, eq(requirementReviews.reviewedBy, users.id))
    .where(eq(requirementReviews.requirementId, id))
    .orderBy(desc(requirementReviews.reviewRevision));
  await db.insert(explorationAuditEvents).values({
    actorType: "admin",
    actorId: c.get("user").id,
    action: "requirement.viewed",
    explorationId: row.explorationId,
    requirementId: id,
    metadata: { currentSubmission: row.currentSubmission },
  });
  return c.json({ data: {
    ...row,
    hasUnsubmittedChanges: row.explorationState === "editing",
    submissions,
    reviews,
  } });
});

function transitionAllowed(from: typeof requirements.$inferSelect.reviewStatus, to: typeof requirements.$inferSelect.reviewStatus): boolean {
  if (from === to) return true;
  const allowed: Record<typeof from, typeof requirements.$inferSelect.reviewStatus[]> = {
    pending_review: ["in_review", "needs_information", "accepted", "deferred", "rejected"],
    needs_information: ["in_review", "deferred", "rejected"],
    in_review: ["needs_information", "accepted", "deferred", "rejected"],
    accepted: ["in_review"],
    deferred: ["in_review", "rejected"],
    rejected: ["in_review"],
  };
  return allowed[from].includes(to);
}

app.post("/:id/review", zValidator("json", reviewSchema), async (c) => {
  const id = c.req.param("id");
  if (!z.string().uuid().safeParse(id).success) return c.json({ error: "无效的需求 ID" }, 400);
  const actor = c.get("user");
  const input = c.req.valid("json");
  const result = await db.transaction(async (tx) => {
    const current = await tx.query.requirements.findFirst({ where: eq(requirements.id, id) });
    if (!current) return { kind: "missing" as const };
    if (current.reviewRevision !== input.expectedRevision || current.currentSubmission !== input.expectedSubmission) {
      return { kind: "conflict" as const, currentRevision: current.reviewRevision, currentSubmission: current.currentSubmission };
    }
    if (!transitionAllowed(current.reviewStatus, input.status)) {
      return { kind: "invalid" as const, from: current.reviewStatus, to: input.status };
    }
    const now = new Date();
    const [row] = await tx.update(requirements).set({
      reviewStatus: input.status,
      publicFeedback: input.publicFeedback ?? null,
      internalNote: input.internalNote ?? null,
      reviewedBy: actor.id,
      reviewedAt: now,
      reviewRevision: input.expectedRevision + 1,
      updatedAt: now,
    }).where(and(
      eq(requirements.id, id),
      eq(requirements.reviewRevision, input.expectedRevision),
      eq(requirements.currentSubmission, input.expectedSubmission),
    )).returning();
    if (!row) return { kind: "conflict" as const, currentRevision: current.reviewRevision, currentSubmission: current.currentSubmission };
    await tx.insert(requirementReviews).values({
      requirementId: row.id,
      submission: row.currentSubmission,
      reviewRevision: row.reviewRevision,
      status: row.reviewStatus,
      publicFeedback: row.publicFeedback,
      internalNote: row.internalNote,
      reviewedBy: actor.id,
      createdAt: now,
    });
    await tx.insert(explorationAuditEvents).values({
      actorType: "admin",
      actorId: actor.id,
      action: "requirement.reviewed",
      explorationId: row.explorationId,
      requirementId: row.id,
      metadata: { status: row.reviewStatus, reviewRevision: row.reviewRevision, submission: row.currentSubmission },
    });
    return { kind: "ok" as const, row };
  });
  if (result.kind === "missing") return c.json({ error: "需求不存在" }, 404);
  if (result.kind === "conflict") return c.json({
    error: "需求提交或评审记录已被更新，请刷新后重试",
    currentRevision: result.currentRevision,
    currentSubmission: result.currentSubmission,
  }, 409);
  if (result.kind === "invalid") return c.json({ error: `不允许从 ${result.from} 直接变更为 ${result.to}` }, 409);
  return c.json({ data: result.row });
});

export default app;
