import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import { db, employees, explorationAuditEvents, users } from "@skillhive/db";
import { requireAdmin, type SessionUser } from "../auth.js";

type AppEnv = { Variables: { user: SessionUser } };
const app = new Hono<AppEnv>();
app.use("*", requireAdmin);

const auditListSchema = z.object({
  keyword: z.string().trim().max(128).optional(),
  actorType: z.enum(["admin", "employee", "system"]).optional(),
  action: z.string().trim().max(64).optional(),
  createdFrom: z.coerce.date().optional(),
  createdTo: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).refine((value) => !value.createdFrom || !value.createdTo || value.createdFrom <= value.createdTo, {
  message: "时间起点不能晚于终点",
  path: ["createdFrom"],
});

app.get("/", zValidator("query", auditListSchema), async (c) => {
  const query = c.req.valid("query");
  const conditions = [];
  if (query.keyword) {
    const pattern = `%${query.keyword}%`;
    conditions.push(or(
      ilike(explorationAuditEvents.action, pattern),
      ilike(users.name, pattern),
      ilike(employees.name, pattern),
      ilike(employees.phone, pattern),
      sql`${explorationAuditEvents.metadata}::text ilike ${pattern}`,
    )!);
  }
  if (query.actorType) conditions.push(eq(explorationAuditEvents.actorType, query.actorType));
  if (query.action) conditions.push(eq(explorationAuditEvents.action, query.action));
  if (query.createdFrom) conditions.push(gte(explorationAuditEvents.createdAt, query.createdFrom));
  if (query.createdTo) conditions.push(lte(explorationAuditEvents.createdAt, query.createdTo));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const rows = await db.select({
    id: explorationAuditEvents.id,
    actorType: explorationAuditEvents.actorType,
    actorId: explorationAuditEvents.actorId,
    adminName: users.name,
    employeeName: employees.name,
    employeePhone: employees.phone,
    action: explorationAuditEvents.action,
    explorationId: explorationAuditEvents.explorationId,
    requirementId: explorationAuditEvents.requirementId,
    metadata: explorationAuditEvents.metadata,
    createdAt: explorationAuditEvents.createdAt,
  }).from(explorationAuditEvents)
    .leftJoin(users, and(
      eq(explorationAuditEvents.actorType, "admin"),
      eq(explorationAuditEvents.actorId, users.id),
    ))
    .leftJoin(employees, and(
      eq(explorationAuditEvents.actorType, "employee"),
      eq(explorationAuditEvents.actorId, employees.id),
    ))
    .where(where)
    .orderBy(desc(explorationAuditEvents.createdAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  const [totalRow] = await db.select({ value: count() })
    .from(explorationAuditEvents)
    .leftJoin(users, and(
      eq(explorationAuditEvents.actorType, "admin"),
      eq(explorationAuditEvents.actorId, users.id),
    ))
    .leftJoin(employees, and(
      eq(explorationAuditEvents.actorType, "employee"),
      eq(explorationAuditEvents.actorId, employees.id),
    ))
    .where(where);
  return c.json({ data: {
    items: rows.map(({ adminName, employeeName, employeePhone, ...row }) => ({
      ...row,
      actorName: row.actorType === "employee"
        ? employeeName && employeePhone ? `${employeeName}（${employeePhone}）` : employeePhone ?? employeeName
        : adminName,
    })),
    total: totalRow?.value ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  } });
});

export default app;
