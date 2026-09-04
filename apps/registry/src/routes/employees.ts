import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import {
  db,
  departments,
  employees,
  employeeTokens,
  explorationAuditEvents,
} from "@skillhive/db";
import { generatePat, requireAdmin, type SessionUser } from "../auth.js";
import { consumeRateLimit } from "../security.js";

type AppEnv = { Variables: { user: SessionUser } };
const app = new Hono<AppEnv>();
app.use("*", requireAdmin);

export const EMPLOYEE_TOKEN_SCOPES = [
  "skills:read",
  "explorations:read:self",
  "explorations:write:self",
] as const;

const phoneSchema = z.string().trim().regex(/^\+?[0-9]{7,15}$/, "手机号应为 7—15 位数字，可使用 + 国际区号");

const employeeInput = z.object({
  phone: phoneSchema,
  name: z.string().trim().min(1).max(128),
  email: z.string().trim().email().max(256).nullish(),
  departmentId: z.string().uuid().nullish(),
});

const employeePatch = employeeInput.partial().extend({
  status: z.enum(["active", "disabled"]).optional(),
});

const tokenInput = z.object({
  name: z.string().trim().min(1).max(128).default("WorkBuddy"),
  expiresInDays: z.number().int().min(1).max(365).default(90),
  scopes: z.array(z.enum(EMPLOYEE_TOKEN_SCOPES)).min(1).default([...EMPLOYEE_TOKEN_SCOPES]),
}).superRefine((value, ctx) => {
  if (
    value.scopes.includes("explorations:write:self")
    && (!value.scopes.includes("explorations:read:self") || !value.scopes.includes("skills:read"))
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["scopes"],
      message: "探索写权限必须同时包含技能读取和本人探索读取权限",
    });
  }
});
const employeeListQuery = z.object({
  keyword: z.string().trim().max(128).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  departmentId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

function notifyTokenRevoked(tokenId: string): void {
  const internalToken = process.env.SKILLHIVE_INTERNAL_TOKEN?.trim();
  if (!internalToken) return;
  const base = process.env.MCP_SERVER_URL ?? "http://localhost:3100";
  void fetch(`${base}/internal/token-revoked`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-SkillHive-Internal-Token": internalToken },
    body: JSON.stringify({ tokenId }),
    signal: AbortSignal.timeout(3_000),
  }).catch(() => undefined);
}

async function referenceError(departmentId: string | null | undefined): Promise<string | null> {
  if (departmentId) {
    const department = await db.query.departments.findFirst({ where: eq(departments.id, departmentId) });
    if (!department) return "所选部门不存在";
  }
  return null;
}

app.get("/", zValidator("query", employeeListQuery), async (c) => {
  const query = c.req.valid("query");
  const conditions = [];
  if (query.keyword) {
    const pattern = `%${query.keyword}%`;
    conditions.push(or(
      ilike(employees.phone, pattern),
      ilike(employees.name, pattern),
      ilike(employees.email, pattern),
    )!);
  }
  if (query.status) conditions.push(eq(employees.status, query.status));
  if (query.departmentId) conditions.push(eq(employees.departmentId, query.departmentId));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const rows = await db
    .select({
      id: employees.id,
      phone: employees.phone,
      name: employees.name,
      email: employees.email,
      departmentId: employees.departmentId,
      departmentName: departments.name,
      status: employees.status,
      createdAt: employees.createdAt,
      updatedAt: employees.updatedAt,
    })
    .from(employees)
    .leftJoin(departments, eq(employees.departmentId, departments.id))
    .where(where)
    .orderBy(desc(employees.updatedAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  const [totalRow] = await db.select({ value: count() })
    .from(employees)
    .where(where);
  const tokenRows = rows.length === 0 ? [] : await db
    .select({ employeeId: employeeTokens.employeeId, lastUsedAt: employeeTokens.lastUsedAt })
    .from(employeeTokens)
    .where(and(
      inArray(employeeTokens.employeeId, rows.map((row) => row.id)),
      isNull(employeeTokens.revokedAt),
      sql`${employeeTokens.expiresAt} > now()`,
    ));
  const tokenSummary = new Map<string, { count: number; lastUsedAt: Date | null }>();
  for (const token of tokenRows) {
    const current = tokenSummary.get(token.employeeId) ?? { count: 0, lastUsedAt: null };
    current.count += 1;
    if (token.lastUsedAt && (!current.lastUsedAt || token.lastUsedAt > current.lastUsedAt)) {
      current.lastUsedAt = token.lastUsedAt;
    }
    tokenSummary.set(token.employeeId, current);
  }
  return c.json({ data: {
    items: rows.map((row) => ({
      ...row,
      activeTokens: tokenSummary.get(row.id)?.count ?? 0,
      lastConnectedAt: tokenSummary.get(row.id)?.lastUsedAt ?? null,
    })),
    total: totalRow?.value ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  } });
});

app.get("/departments", async (c) => {
  const rows = await db.select({ id: departments.id, name: departments.name })
    .from(departments).orderBy(departments.name);
  return c.json({ data: rows });
});

app.post("/", zValidator("json", employeeInput), async (c) => {
  try {
    const input = c.req.valid("json");
    const invalidReference = await referenceError(input.departmentId);
    if (invalidReference) return c.json({ error: invalidReference }, 400);
    const row = await db.transaction(async (tx) => {
      const [created] = await tx.insert(employees).values({
        ...input,
        email: input.email?.toLowerCase() ?? null,
        departmentId: input.departmentId ?? null,
      }).returning();
      if (!created) throw new Error("创建员工失败");
      await tx.insert(explorationAuditEvents).values({
        actorType: "admin", actorId: c.get("user").id, action: "employee.created",
        metadata: { employeeId: created.id, phone: created.phone },
      });
      return created;
    });
    return c.json({ data: row }, 201);
  } catch (error) {
    if (isUniqueViolation(error)) return c.json({ error: "手机号或邮箱已存在" }, 409);
    throw error;
  }
});

app.patch("/:id", zValidator("json", employeePatch), async (c) => {
  const id = c.req.param("id");
  if (!z.string().uuid().safeParse(id).success) return c.json({ error: "无效的员工 ID" }, 400);
  const input = c.req.valid("json");
  const invalidReference = await referenceError(input.departmentId);
  if (invalidReference) return c.json({ error: invalidReference }, 400);
  let result;
  try {
    result = await db.transaction(async (tx) => {
      if (input.status === "disabled") {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`employee-token:${id}`}, 0))`);
      }
      const [row] = await tx.update(employees).set({
        ...input,
        ...(input.email === undefined ? {} : { email: input.email?.toLowerCase() ?? null }),
        ...(input.departmentId === undefined ? {} : { departmentId: input.departmentId ?? null }),
        updatedAt: new Date(),
      }).where(eq(employees.id, id)).returning();
      if (!row) return null;
      const revokedTokens = input.status === "disabled"
        ? await tx.update(employeeTokens)
            .set({ revokedAt: new Date() })
            .where(and(eq(employeeTokens.employeeId, id), isNull(employeeTokens.revokedAt)))
            .returning({ id: employeeTokens.id })
        : [];
      await tx.insert(explorationAuditEvents).values({
        actorType: "admin", actorId: c.get("user").id, action: "employee.updated",
        metadata: { employeeId: id, fields: Object.keys(input), revokedTokens: revokedTokens.length },
      });
      return { row, revokedTokenIds: revokedTokens.map((item) => item.id) };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return c.json({ error: "手机号或邮箱已存在" }, 409);
    throw error;
  }
  if (!result) return c.json({ error: "员工不存在" }, 404);
  for (const tokenId of result.revokedTokenIds) notifyTokenRevoked(tokenId);
  return c.json({ data: { ...result.row, revokedTokens: result.revokedTokenIds.length } });
});

app.get("/:id/tokens", async (c) => {
  const employeeId = c.req.param("id");
  if (!z.string().uuid().safeParse(employeeId).success) return c.json({ error: "无效的员工 ID" }, 400);
  const rows = await db.select({
    id: employeeTokens.id,
    name: employeeTokens.name,
    scopes: employeeTokens.scopes,
    expiresAt: employeeTokens.expiresAt,
    createdAt: employeeTokens.createdAt,
    lastUsedAt: employeeTokens.lastUsedAt,
    revokedAt: employeeTokens.revokedAt,
  }).from(employeeTokens).where(eq(employeeTokens.employeeId, employeeId)).orderBy(desc(employeeTokens.createdAt));
  return c.json({ data: rows });
});

app.post("/:id/tokens", zValidator("json", tokenInput), async (c) => {
  const actor = c.get("user");
  const employeeId = c.req.param("id");
  if (!z.string().uuid().safeParse(employeeId).success) return c.json({ error: "无效的员工 ID" }, 400);
  const rate = consumeRateLimit("admin-create-employee-token", actor.id, 30, 60 * 60_000);
  if (!rate.allowed) return c.json({ error: "令牌创建过于频繁，请稍后再试" }, 429);
  const input = c.req.valid("json");
  const { token, hash } = generatePat();
  const expiresAt = new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1_000);
  const result = await db.transaction(async (tx) => {
    // 与员工停用串行化，避免校验后状态在签发前改变。
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`employee-token:${employeeId}`}, 0))`);
    const employee = await tx.query.employees.findFirst({ where: eq(employees.id, employeeId) });
    if (!employee || employee.status !== "active") return { kind: "employee-blocked" as const };
    const [activeCount] = await tx.select({ count: sql<number>`count(*)::int` }).from(employeeTokens).where(and(
      eq(employeeTokens.employeeId, employeeId),
      isNull(employeeTokens.revokedAt),
      sql`${employeeTokens.expiresAt} > now()`,
    ));
    if ((activeCount?.count ?? 0) >= 10) return { kind: "limit" as const };

    const [row] = await tx.insert(employeeTokens).values({
      employeeId,
      name: input.name,
      tokenHash: hash,
      scopes: [...new Set(input.scopes)],
      expiresAt,
      issuedBy: actor.id,
    }).returning({ id: employeeTokens.id, expiresAt: employeeTokens.expiresAt });
    if (!row) throw new Error("创建员工令牌失败");
    await tx.insert(explorationAuditEvents).values({
      actorType: "admin", actorId: actor.id, action: "employee.token_issued",
      metadata: { employeeId, tokenId: row.id, scopes: input.scopes, expiresAt },
    });
    return { kind: "created" as const, row };
  });
  if (result.kind === "employee-blocked") return c.json({ error: "员工不存在或已停用" }, 409);
  if (result.kind === "limit") return c.json({ error: "该员工最多保留 10 个有效令牌" }, 409);
  return c.json({ data: { id: result.row.id, token, name: input.name, scopes: input.scopes, expiresAt } }, 201);
});

app.delete("/:employeeId/tokens/:tokenId", async (c) => {
  const { employeeId, tokenId } = c.req.param();
  if (!z.string().uuid().safeParse(employeeId).success || !z.string().uuid().safeParse(tokenId).success) {
    return c.json({ error: "无效的员工或令牌 ID" }, 400);
  }
  const row = await db.transaction(async (tx) => {
    const [revoked] = await tx.update(employeeTokens).set({ revokedAt: new Date() }).where(and(
      eq(employeeTokens.id, tokenId),
      eq(employeeTokens.employeeId, employeeId),
      isNull(employeeTokens.revokedAt),
    )).returning({ id: employeeTokens.id });
    if (!revoked) return null;
    await tx.insert(explorationAuditEvents).values({
      actorType: "admin", actorId: c.get("user").id, action: "employee.token_revoked",
      metadata: { employeeId, tokenId: revoked.id },
    });
    return revoked;
  });
  if (!row) return c.json({ error: "令牌不存在或已吊销" }, 404);
  notifyTokenRevoked(row.id);
  return c.json({ ok: true });
});

function isUniqueViolation(error: unknown): boolean {
  const value = error as { code?: string; cause?: { code?: string } } | null;
  return value?.code === "23505" || value?.cause?.code === "23505";
}

export default app;
