import { createHash, randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, gte, ilike, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  db,
  departments,
  employees,
  employeeTokens,
  explorationAuditEvents,
  explorationIdempotency,
  explorationPolicies,
  explorationRevisions,
  explorations,
  requirements,
  requirementSubmissions,
  requirementReviews,
  skillDepartmentVisibility,
  skills,
  skillVersionFiles,
  skillVersions,
} from "@skillhive/db";
import { requireAdmin, requireInternalToken, type SessionUser } from "../auth.js";
import { consumeRateLimit } from "../security.js";
import {
  explorationContentSchema,
  payloadSize,
  validateSubmission,
} from "../exploration-data.js";
import { optionalMcpUrl, optionalPublicHttpsUrl, workBuddyConnectorReadiness } from "../workbuddy-connector.js";
import { parseSkillMd, validateResourcePath, type SkillResourceFile } from "@skillhive/skill-schema";
import { validateRequirementExplorationApplicationSkill } from "../built-in-applications.js";

type EmployeeCaller = {
  id: string;
  tokenId: string;
  name: string;
  phone: string | null;
  departmentId: string | null;
  scopes: string[];
};
type InternalEnv = { Variables: { employee: EmployeeCaller } };
type AdminEnv = { Variables: { user: SessionUser } };
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const internal = new Hono<InternalEnv>();
const admin = new Hono<AdminEnv>();

const idempotencyKey = z.string().trim().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const uuid = z.string().uuid();
const startSchema = z.object({
  initialProblem: z.string().trim().max(8_000).optional(),
  idempotencyKey,
  protocolVersion: z.literal("1.0").default("1.0"),
});
const saveSchema = z.object({
  expectedRevision: z.number().int().min(0),
  content: explorationContentSchema,
  idempotencyKey,
}).superRefine((value, ctx) => {
  if (payloadSize(value.content) > 64 * 1024) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["content"], message: "结构化草稿不能超过 64 KiB" });
  }
});
const transitionSchema = z.object({ expectedRevision: z.number().int().min(0), idempotencyKey });
const listSchema = z.object({
  state: z.enum(["discussing", "submitted", "editing", "abandoned"]).optional(),
  keyword: z.string().trim().max(128).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
const detailQuerySchema = z.object({
  submission: z.coerce.number().int().min(1).optional(),
});
const ruleFileQuerySchema = z.object({
  slug: z.string().min(1).max(128).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  version: z.string().max(32).regex(/^\d+\.\d+\.\d+$/),
  path: z.string().min(1).max(512).refine((path) => validateResourcePath(path) === null),
});
const adminListSchema = z.object({
  keyword: z.string().trim().max(128).optional(),
  state: z.enum(["discussing", "submitted", "editing", "abandoned"]).optional(),
  employee: z.string().trim().max(128).optional(),
  departmentId: z.string().uuid().optional(),
  skillVersion: z.string().trim().max(64).optional(),
  updatedFrom: z.coerce.date().optional(),
  updatedTo: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
}).refine((value) => !value.updatedFrom || !value.updatedTo || value.updatedFrom <= value.updatedTo, {
  message: "更新时间起点不能晚于终点",
  path: ["updatedFrom"],
});

function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function recordNumber(prefix: "EXP" | "REQ"): string {
  return `${prefix}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomBytes(5).toString("hex").toUpperCase()}`;
}

function hasScope(employee: EmployeeCaller, scope: string): boolean {
  return employee.scopes.includes(scope);
}

function errorCode(status: number, payload?: Record<string, unknown>): string {
  if (typeof payload?.code === "string") return payload.code;
  if (status === 400) return "INVALID_ARGUMENT";
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 422) return "VALIDATION_FAILED";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "TEMPORARILY_UNAVAILABLE";
  return "REQUEST_FAILED";
}

function monitoredPath(path: string): string {
  return path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, ":id");
}

function errorBody(
  code: string,
  message: string,
  nextStep: string,
  details: Record<string, unknown> = {},
) {
  return { error: message, code, retryable: false, nextStep, ...details };
}

type WriteBlockReason = { code: string; message: string; nextStep: string };

async function recordExplorationError(
  employee: EmployeeCaller,
  status: number,
  method: string,
  path: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(explorationAuditEvents).values({
      actorType: "employee",
      actorId: employee.id,
      action: "exploration.error",
      metadata: {
        code: errorCode(status, payload),
        status,
        method,
        path: monitoredPath(path),
        retryable: payload?.retryable === true || status === 429 || status >= 500,
      },
    });
  } catch {
    // 监控写入失败不能覆盖原始业务错误。
  }
}

async function writeBlockReason(
  tx: Transaction,
  employee: EmployeeCaller,
  skillId: string | null,
  skillVersionId: string | null,
): Promise<WriteBlockReason | null> {
  const policy = await tx.query.explorationPolicies.findFirst({
    where: eq(explorationPolicies.key, "requirement-exploration"),
  });
  if (!policy?.enabled) return {
    code: "RULE_DISABLED",
    message: "需求探索当前已停用，请联系管理员",
    nextStep: "保留最后成功内容并联系管理员；恢复后先查询连接器状态",
  };
  if (skillVersionId && policy.blockedSkillVersionIds.includes(skillVersionId)) {
    return {
      code: "RULE_VERSION_BLOCKED",
      message: "该探索使用的规则版本已被管理员紧急停用；已有内容仍可查看，请联系管理员重新开始",
      nextStep: "不要继续写入该探索；联系管理员确认是否按安全版本重新开始",
    };
  }
  if (!skillId) return {
    code: "RULE_UNAVAILABLE",
    message: "该探索关联的规则已不可用；已有内容仍可查看",
    nextStep: "联系管理员恢复规则或确认是否新建探索",
  };
  const skill = await tx.query.skills.findFirst({ where: eq(skills.id, skillId) });
  if (!skill || skill.status !== "published") {
    return {
      code: "RULE_UNAVAILABLE",
      message: "该探索关联的规则已停止发布；已有内容仍可查看",
      nextStep: "联系管理员恢复规则或确认是否新建探索",
    };
  }
  const visibility = await tx.select({ departmentId: skillDepartmentVisibility.departmentId })
    .from(skillDepartmentVisibility)
    .where(eq(skillDepartmentVisibility.skillId, skillId));
  if (
    visibility.length > 0
    && (employee.departmentId === null || !visibility.some((item) => item.departmentId === employee.departmentId))
  ) {
    return {
      code: "DEPARTMENT_NOT_ALLOWED",
      message: "当前员工所属部门已不在该规则的可用范围内；已有内容仍可查看",
      nextStep: "联系管理员核对员工部门和规则可见范围",
    };
  }
  return null;
}

async function resolveInternalEmployee(c: Context<InternalEnv>): Promise<EmployeeCaller | null> {
  const employeeId = c.req.header("X-SkillHive-Employee-Id") ?? "";
  const tokenId = c.req.header("X-SkillHive-Token-Id") ?? "";
  if (!uuid.safeParse(employeeId).success || !uuid.safeParse(tokenId).success) return null;
  const [row] = await db.select({
    id: employees.id,
    tokenId: employeeTokens.id,
    name: employees.name,
    phone: employees.phone,
    departmentId: employees.departmentId,
    scopes: employeeTokens.scopes,
  }).from(employeeTokens).innerJoin(employees, eq(employeeTokens.employeeId, employees.id)).where(and(
    eq(employeeTokens.id, tokenId),
    eq(employeeTokens.employeeId, employeeId),
    eq(employees.status, "active"),
    isNull(employeeTokens.revokedAt),
    sql`${employeeTokens.expiresAt} > now()`,
  )).limit(1);
  return row ?? null;
}

internal.use("*", requireInternalToken, async (c, next) => {
  const employee = await resolveInternalEmployee(c);
  if (!employee) return c.json({ error: "员工身份或接入令牌已失效" }, 401);
  const rate = consumeRateLimit("employee-exploration", employee.id, 240, 60_000);
  if (!rate.allowed) {
    c.header("Retry-After", String(rate.retryAfterSeconds));
    const payload = {
      error: "需求探索调用过于频繁，请稍后重试",
      code: "RATE_LIMITED",
      retryable: true,
      nextStep: "等待 Retry-After 指示的秒数后，使用原幂等键重试写操作",
    };
    await recordExplorationError(employee, 429, c.req.method, c.req.path, payload);
    return c.json(payload, 429);
  }
  c.set("employee", employee);
  await next();
  if (c.res.status >= 400) {
    const payload = await c.res.clone().json().catch(() => undefined) as Record<string, unknown> | undefined;
    await recordExplorationError(employee, c.res.status, c.req.method, c.req.path, payload);
  }
});

internal.get("/status", zValidator("query", z.object({ protocolVersion: z.string().max(32).optional() })), async (c) => {
  const employee = c.get("employee");
  const requestedProtocolVersion = c.req.valid("query").protocolVersion;
  const policy = await db.query.explorationPolicies.findFirst({
    where: eq(explorationPolicies.key, "requirement-exploration"),
  });
  const activeVersion = policy?.skillVersionId
    ? await db.query.skillVersions.findFirst({ where: eq(skillVersions.id, policy.skillVersionId) })
    : null;
  const activeSkill = policy?.skillId
    ? await db.query.skills.findFirst({ where: eq(skills.id, policy.skillId) })
    : null;
  const visibility = activeSkill
    ? await db.select({ departmentId: skillDepartmentVisibility.departmentId })
        .from(skillDepartmentVisibility)
        .where(eq(skillDepartmentVisibility.skillId, activeSkill.id))
    : [];
  const activeRuleAccessible = Boolean(activeSkill?.status === "published" && activeVersion) && (
    visibility.length === 0
    || (employee.departmentId !== null && visibility.some((item) => item.departmentId === employee.departmentId))
  );
  const protocolCompatible = !requestedProtocolVersion || requestedProtocolVersion === "1.0";
  return c.json({ data: {
    companyName: process.env.SKILLHIVE_COMPANY_NAME ?? "本企业",
    employee: { id: employee.id, phone: employee.phone, name: employee.name },
    connectorProtocolVersion: "1.0",
    protocolCompatible,
    skillsReadable: hasScope(employee, "skills:read"),
    explorationsReadable: hasScope(employee, "explorations:read:self"),
    explorationsWritable: hasScope(employee, "skills:read")
      && hasScope(employee, "explorations:read:self")
      && hasScope(employee, "explorations:write:self")
      && activeRuleAccessible
      && protocolCompatible
      && policy?.enabled === true
      && !policy.blockedSkillVersionIds.includes(policy.skillVersionId ?? ""),
    policyEnabled: policy?.enabled ?? false,
    activeRuleAccessible,
    activeRule: activeVersion && activeSkill
      ? { slug: activeSkill.slug, version: activeVersion.version }
      : null,
  } });
});

internal.post("/start", zValidator("json", startSchema), async (c) => {
  const employee = c.get("employee");
  if (
    !hasScope(employee, "skills:read")
    || !hasScope(employee, "explorations:read:self")
    || !hasScope(employee, "explorations:write:self")
  ) return c.json(errorBody(
    "TOKEN_SCOPE_REQUIRED",
    "令牌缺少需求探索所需的技能读取、本人读取或写入权限",
    "联系管理员按最小权限重新签发员工专属令牌",
  ), 403);
  const input = c.req.valid("json");
  const hash = requestHash(input);
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${employee.id}:start:${input.idempotencyKey}`}, 0))`);
    const replay = await tx.query.explorationIdempotency.findFirst({ where: and(
      eq(explorationIdempotency.employeeId, employee.id),
      eq(explorationIdempotency.operation, "start"),
      eq(explorationIdempotency.key, input.idempotencyKey),
    ) });
    if (replay) return replay.requestHash === hash
      ? { kind: "ok" as const, data: replay.response }
      : {
          kind: "conflict" as const,
          code: "IDEMPOTENCY_CONFLICT",
          message: "幂等键已用于不同的开始请求",
          nextStep: "为新的开始请求生成新幂等键；重试原请求必须复用原内容",
        };

    const policy = await tx.query.explorationPolicies.findFirst({
      where: eq(explorationPolicies.key, "requirement-exploration"),
    });
    if (!policy?.enabled || !policy.skillId || !policy.skillVersionId) {
      return {
        kind: "blocked" as const,
        code: "RULE_DISABLED",
        message: "需求探索当前未启用，请联系管理员",
        nextStep: "联系管理员激活已验证的需求探索规则",
      };
    }
    const version = await tx.query.skillVersions.findFirst({ where: and(
      eq(skillVersions.id, policy.skillVersionId),
      eq(skillVersions.skillId, policy.skillId),
    ) });
    if (!version) return {
      kind: "blocked" as const,
      code: "RULE_UNAVAILABLE",
      message: "已激活的探索规则版本不存在",
      nextStep: "联系管理员重新选择并激活有效规则版本",
    };
    if (policy.blockedSkillVersionIds.includes(version.id)) {
      return {
        kind: "blocked" as const,
        code: "RULE_VERSION_BLOCKED",
        message: "已激活的探索规则版本已被管理员紧急停用",
        nextStep: "联系管理员回退并激活安全规则版本",
      };
    }
    const skill = await tx.query.skills.findFirst({ where: eq(skills.id, policy.skillId) });
    if (
      !skill
      || skill.status !== "published"
      || skill.skillType !== "application"
    ) {
      return {
        kind: "blocked" as const,
        code: "RULE_UNAVAILABLE",
        message: "已激活的探索规则不可用",
        nextStep: "联系管理员恢复发布状态或激活其他规则版本",
      };
    }
    const visibility = await tx.select({ departmentId: skillDepartmentVisibility.departmentId })
      .from(skillDepartmentVisibility)
      .where(eq(skillDepartmentVisibility.skillId, skill.id));
    if (
      visibility.length > 0
      && (employee.departmentId === null || !visibility.some((item) => item.departmentId === employee.departmentId))
    ) {
      return {
        kind: "blocked" as const,
        code: "DEPARTMENT_NOT_ALLOWED",
        message: "当前员工所属部门不在需求探索规则的可用范围内",
        nextStep: "联系管理员核对员工部门和规则可见范围",
      };
    }
    const resources = await tx.select({
      path: skillVersionFiles.path,
      size: skillVersionFiles.size,
      contentBase64: skillVersionFiles.contentBase64,
    }).from(skillVersionFiles).where(eq(skillVersionFiles.versionId, version.id));
    const ruleSnapshot = {
      slug: skill.slug,
      version: version.version,
      content: version.content,
      resources,
    };
    const [created] = await tx.insert(explorations).values({
      number: recordNumber("EXP"),
      employeeId: employee.id,
      skillId: skill.id,
      skillVersionId: version.id,
      ruleContentHash: createHash("sha256").update(version.content).digest("hex"),
      ruleSnapshot,
      departmentId: employee.departmentId,
      title: input.initialProblem?.slice(0, 128) || "未命名需求探索",
    }).returning();
    if (!created) throw new Error("创建探索失败");
    const data = {
      explorationId: created.id,
      number: created.number,
      revision: 0,
      state: created.state,
      rule: {
        slug: ruleSnapshot.slug,
        version: ruleSnapshot.version,
        content: ruleSnapshot.content,
        resources: ruleSnapshot.resources.map(({ path, size }) => ({ path, size })),
      },
      notice: "阶段性草稿和正式提交都会保存到公司服务器，并可由公司管理员查看；正式提交后才进入评审流程。不会收集其他对话。",
    };
    await tx.insert(explorationIdempotency).values({
      employeeId: employee.id,
      explorationId: created.id,
      operation: "start",
      key: input.idempotencyKey,
      requestHash: hash,
      response: data,
      statusCode: 201,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
    });
    await tx.insert(explorationAuditEvents).values({
      actorType: "employee", actorId: employee.id, action: "exploration.started",
      explorationId: created.id, metadata: { tokenId: employee.tokenId, ruleVersion: version.version },
    });
    return { kind: "ok" as const, data };
  });
  if (result.kind === "conflict") return c.json(errorBody(result.code, result.message, result.nextStep), 409);
  if (result.kind === "blocked") return c.json(errorBody(result.code, result.message, result.nextStep), 409);
  return c.json({ data: result.data }, 201);
});

internal.get("/", zValidator("query", listSchema), async (c) => {
  const employee = c.get("employee");
  if (!hasScope(employee, "explorations:read:self")) return c.json(errorBody(
    "TOKEN_SCOPE_REQUIRED", "令牌没有探索读取权限", "联系管理员重新签发包含本人探索读取权限的员工专属令牌",
  ), 403);
  const query = c.req.valid("query");
  const conditions = [eq(explorations.employeeId, employee.id)];
  if (query.state) conditions.push(eq(explorations.state, query.state));
  if (query.keyword) conditions.push(or(
    ilike(explorations.title, `%${query.keyword}%`),
    ilike(explorations.number, `%${query.keyword}%`),
  )!);
  const rows = await db.select({
    id: explorations.id, number: explorations.number, title: explorations.title,
    state: explorations.state, currentRevision: explorations.currentRevision,
    lastSubmittedRevision: explorations.lastSubmittedRevision,
    updatedAt: explorations.updatedAt,
    reviewStatus: requirements.reviewStatus, publicFeedback: requirements.publicFeedback,
  }).from(explorations).leftJoin(requirements, eq(explorations.id, requirements.explorationId))
    .where(and(...conditions)).orderBy(desc(explorations.updatedAt))
    .limit(query.pageSize + 1).offset((query.page - 1) * query.pageSize);
  return c.json({ data: {
    items: rows.slice(0, query.pageSize),
    page: query.page,
    pageSize: query.pageSize,
    hasMore: rows.length > query.pageSize,
  } });
});

internal.get("/:id/rule-file", zValidator("query", ruleFileQuerySchema), async (c) => {
  const employee = c.get("employee");
  if (!hasScope(employee, "skills:read") || !hasScope(employee, "explorations:read:self")) {
    return c.json(errorBody(
      "TOKEN_SCOPE_REQUIRED",
      "令牌没有读取探索规则资源所需的权限",
      "联系管理员重新签发包含技能和本人探索读取权限的员工专属令牌",
    ), 403);
  }
  const id = c.req.param("id");
  if (!uuid.safeParse(id).success) return c.json(errorBody(
    "INVALID_ARGUMENT", "无效的探索 ID", "使用 start_exploration 或 list_my_explorations 返回的 explorationId",
  ), 400);
  const query = c.req.valid("query");
  const [row] = await db.select({ ruleSnapshot: explorations.ruleSnapshot })
    .from(explorations)
    .where(and(eq(explorations.id, id), eq(explorations.employeeId, employee.id)))
    .limit(1);
  if (!row) return c.json(errorBody(
    "NOT_FOUND", "探索不存在", "重新列出本人探索并使用返回的 explorationId",
  ), 404);
  const snapshot = row.ruleSnapshot as {
    slug?: string;
    version?: string;
    resources?: Array<{ path?: string; size?: number; contentBase64?: string }>;
  } | null;
  const resource = snapshot?.slug === query.slug && snapshot.version === query.version
    ? snapshot.resources?.find((item) => item.path === query.path)
    : undefined;
  if (!resource) return c.json(errorBody(
    "RULE_RESOURCE_FORBIDDEN",
    "资源不属于该探索锁定的规则版本或资源清单",
    "使用当前探索返回的 rule.slug、rule.version 和精确资源路径",
  ), 403);
  if (typeof resource.contentBase64 !== "string" || !Number.isSafeInteger(resource.size)) {
    return c.json(errorBody(
      "RULE_SNAPSHOT_UNAVAILABLE",
      "该历史探索的规则资源快照不完整",
      "联系管理员核查历史数据或使用仍可读取的规则正文继续",
    ), 409);
  }
  return c.json({ data: {
    version: query.version,
    path: query.path,
    size: resource.size,
    contentBase64: resource.contentBase64,
  } });
});

internal.get("/:id", zValidator("query", detailQuerySchema), async (c) => {
  const employee = c.get("employee");
  if (!hasScope(employee, "explorations:read:self")) return c.json(errorBody(
    "TOKEN_SCOPE_REQUIRED", "令牌没有探索读取权限", "联系管理员重新签发包含本人探索读取权限的员工专属令牌",
  ), 403);
  const id = c.req.param("id");
  if (!uuid.safeParse(id).success) return c.json(errorBody(
    "INVALID_ARGUMENT", "无效的探索 ID", "使用 list_my_explorations 返回的 explorationId",
  ), 400);
  const requestedSubmission = c.req.valid("query").submission;
  const result = await employeeExplorationDetail(employee.id, id, false, requestedSubmission);
  if (!result) return c.json(errorBody(
    "NOT_FOUND", "探索不存在", "重新列出本人探索并使用返回的 explorationId",
  ), 404);
  if (requestedSubmission !== undefined && result.requestedSubmission === null) {
    return c.json(errorBody(
      "SUBMISSION_NOT_FOUND", "正式提交版本不存在", "省略 submission 查看当前状态，或使用已有正式提交版本号",
    ), 404);
  }
  return c.json({ data: result });
});

internal.put("/:id", zValidator("json", saveSchema), async (c) => {
  const employee = c.get("employee");
  if (!hasScope(employee, "explorations:write:self")) return c.json(errorBody(
    "TOKEN_SCOPE_REQUIRED", "令牌没有探索写权限", "联系管理员重新签发包含探索写权限的员工专属令牌",
  ), 403);
  const id = c.req.param("id");
  if (!uuid.safeParse(id).success) return c.json(errorBody(
    "INVALID_ARGUMENT", "无效的探索 ID", "使用 start_exploration 或 list_my_explorations 返回的 explorationId",
  ), 400);
  const input = c.req.valid("json");
  const result = await writeRevision(employee, id, input);
  if (result.kind === "missing") return c.json(errorBody(
    "NOT_FOUND", "探索不存在", "重新列出本人探索并确认 explorationId",
  ), 404);
  if (result.kind === "conflict") return c.json(errorBody(
    result.code, result.message, result.nextStep, { currentRevision: result.currentRevision },
  ), 409);
  if (result.kind === "blocked") return c.json(errorBody(result.code, result.message, result.nextStep), 409);
  return c.json({ data: result.data });
});

internal.post("/:id/submit", zValidator("json", transitionSchema), async (c) => {
  const employee = c.get("employee");
  if (!hasScope(employee, "explorations:write:self")) return c.json(errorBody(
    "TOKEN_SCOPE_REQUIRED", "令牌没有探索写权限", "联系管理员重新签发包含探索写权限的员工专属令牌",
  ), 403);
  const id = c.req.param("id");
  if (!uuid.safeParse(id).success) return c.json(errorBody(
    "INVALID_ARGUMENT", "无效的探索 ID", "使用 list_my_explorations 返回的 explorationId",
  ), 400);
  const input = c.req.valid("json");
  const result = await submitRevision(employee, id, input);
  if (result.kind === "missing") return c.json(errorBody(
    "NOT_FOUND", "探索或已保存修订不存在", "重新读取本人探索并确认当前 revision",
  ), 404);
  if (result.kind === "conflict") return c.json(errorBody(
    result.code, result.message, result.nextStep, { currentRevision: result.currentRevision },
  ), 409);
  if (result.kind === "invalid") return c.json(errorBody(
    "SUBMISSION_INCOMPLETE",
    "正式提交缺少必填内容",
    "根据 missingFields 继续讨论，保存完整草稿后再提交",
    { missingFields: result.missing },
  ), 422);
  if (result.kind === "blocked") return c.json(errorBody(result.code, result.message, result.nextStep), 409);
  return c.json({ data: result.data });
});

internal.post("/:id/abandon", zValidator("json", transitionSchema), async (c) => {
  const employee = c.get("employee");
  if (!hasScope(employee, "explorations:write:self")) return c.json(errorBody(
    "TOKEN_SCOPE_REQUIRED", "令牌没有探索写权限", "联系管理员重新签发包含探索写权限的员工专属令牌",
  ), 403);
  const id = c.req.param("id");
  if (!uuid.safeParse(id).success) return c.json(errorBody(
    "INVALID_ARGUMENT", "无效的探索 ID", "使用 list_my_explorations 返回的 explorationId",
  ), 400);
  const input = c.req.valid("json");
  const result = await abandonExploration(employee, id, input);
  if (result.kind === "missing") return c.json(errorBody(
    "NOT_FOUND", "探索不存在", "重新列出本人探索并确认 explorationId",
  ), 404);
  if (result.kind === "conflict") return c.json(errorBody(
    result.code, result.message, result.nextStep, { currentRevision: result.currentRevision },
  ), 409);
  if (result.kind === "blocked") return c.json(errorBody(result.code, result.message, result.nextStep), 409);
  return c.json({ data: result.data });
});

async function writeRevision(employee: EmployeeCaller, explorationId: string, input: z.infer<typeof saveSchema>) {
  const hash = requestHash(input);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${employee.id}:exploration:${explorationId}`}, 0))`);
    const replay = await tx.query.explorationIdempotency.findFirst({ where: and(
      eq(explorationIdempotency.employeeId, employee.id), eq(explorationIdempotency.operation, "save"),
      eq(explorationIdempotency.key, input.idempotencyKey),
    ) });
    if (replay) return replay.requestHash === hash
      ? { kind: "ok" as const, data: replay.response }
      : {
          kind: "conflict" as const,
          code: "IDEMPOTENCY_CONFLICT",
          message: "幂等键已用于不同的保存请求",
          nextStep: "重试原保存必须复用原内容；内容变化时生成新幂等键",
          currentRevision: input.expectedRevision,
        };
    const current = await tx.query.explorations.findFirst({ where: and(
      eq(explorations.id, explorationId), eq(explorations.employeeId, employee.id),
    ) });
    if (!current) return { kind: "missing" as const };
    const blocked = await writeBlockReason(tx, employee, current.skillId, current.skillVersionId);
    if (blocked) return { kind: "blocked" as const, ...blocked };
    if (current.state === "abandoned") return {
      kind: "blocked" as const,
      code: "EXPLORATION_ABANDONED",
      message: "已放弃的探索不能继续保存",
      nextStep: "如需继续讨论，请明确开始一条新的需求探索",
    };
    if (current.currentRevision !== input.expectedRevision) return {
      kind: "conflict" as const,
      code: "REVISION_CONFLICT",
      message: "探索已被另一会话更新，请重新读取后再保存",
      nextStep: "调用 get_exploration 读取最新 revision，让员工确认合并内容后使用新幂等键保存",
      currentRevision: current.currentRevision,
    };
    const revision = current.currentRevision + 1;
    const now = new Date();
    await tx.insert(explorationRevisions).values({
      explorationId, revision, content: input.content, createdByTokenId: employee.tokenId, createdAt: now,
    });
    await tx.update(explorations).set({
      title: input.content.title,
      currentRevision: revision,
      state: current.lastSubmittedRevision === null ? "discussing" : "editing",
      updatedAt: now,
    }).where(eq(explorations.id, explorationId));
    const data = { explorationId, revision, savedAt: now, state: current.lastSubmittedRevision === null ? "discussing" : "editing" };
    await tx.insert(explorationIdempotency).values({
      employeeId: employee.id, explorationId, operation: "save", key: input.idempotencyKey, requestHash: hash,
      response: data, statusCode: 200, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
    });
    await tx.insert(explorationAuditEvents).values({
      actorType: "employee", actorId: employee.id, action: "exploration.saved",
      explorationId, metadata: { tokenId: employee.tokenId, revision },
    });
    return { kind: "ok" as const, data };
  });
}

async function submitRevision(employee: EmployeeCaller, explorationId: string, input: z.infer<typeof transitionSchema>) {
  const hash = requestHash(input);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${employee.id}:exploration:${explorationId}`}, 0))`);
    const replay = await tx.query.explorationIdempotency.findFirst({ where: and(
      eq(explorationIdempotency.employeeId, employee.id), eq(explorationIdempotency.operation, "submit"),
      eq(explorationIdempotency.key, input.idempotencyKey),
    ) });
    if (replay) return replay.requestHash === hash
      ? { kind: "ok" as const, data: replay.response }
      : {
          kind: "conflict" as const,
          code: "IDEMPOTENCY_CONFLICT",
          message: "幂等键已用于不同的提交请求",
          nextStep: "重试原提交必须复用原 revision；提交其他 revision 时生成新幂等键",
          currentRevision: input.expectedRevision,
        };
    const current = await tx.query.explorations.findFirst({ where: and(
      eq(explorations.id, explorationId), eq(explorations.employeeId, employee.id),
    ) });
    if (!current) return { kind: "missing" as const };
    const blocked = await writeBlockReason(tx, employee, current.skillId, current.skillVersionId);
    if (blocked) return { kind: "blocked" as const, ...blocked };
    if (current.state === "abandoned") return {
      kind: "blocked" as const,
      code: "EXPLORATION_ABANDONED",
      message: "已放弃的探索不能提交",
      nextStep: "如需继续讨论，请明确开始一条新的需求探索",
    };
    if (current.currentRevision !== input.expectedRevision) return {
      kind: "conflict" as const,
      code: "REVISION_CONFLICT",
      message: "探索已被另一会话更新，请重新读取后再提交",
      nextStep: "调用 get_exploration 读取最新 revision，确认内容后再提交",
      currentRevision: current.currentRevision,
    };
    if (current.state === "submitted" && current.lastSubmittedRevision === current.currentRevision) {
      return {
        kind: "blocked" as const,
        code: "ALREADY_SUBMITTED",
        message: "当前修订已经正式提交；请先保存新的修改再重新提交",
        nextStep: "查询当前正式提交；只有员工确有补充时才先保存新修订",
      };
    }
    const revision = await tx.query.explorationRevisions.findFirst({ where: and(
      eq(explorationRevisions.explorationId, explorationId),
      eq(explorationRevisions.revision, input.expectedRevision),
    ) });
    if (!revision) return { kind: "missing" as const };
    const parsed = explorationContentSchema.safeParse(revision.content);
    if (!parsed.success) return { kind: "invalid" as const, missing: ["草稿结构无效，请重新保存"] };
    const missing = validateSubmission(parsed.data);
    if (missing.length > 0) return { kind: "invalid" as const, missing };
    const existing = await tx.query.requirements.findFirst({ where: eq(requirements.explorationId, explorationId) });
    const now = new Date();
    let requirement = existing;
    if (!requirement) {
      [requirement] = await tx.insert(requirements).values({
        number: recordNumber("REQ"), explorationId, createdAt: now, updatedAt: now,
      }).returning();
    } else {
      [requirement] = await tx.update(requirements).set({
        currentSubmission: requirement.currentSubmission + 1,
        reviewRevision: requirement.reviewRevision + 1,
        reviewStatus: "pending_review",
        publicFeedback: null,
        internalNote: null,
        reviewedBy: null,
        reviewedAt: null,
        updatedAt: now,
      }).where(eq(requirements.id, requirement.id)).returning();
    }
    if (!requirement) throw new Error("创建正式需求失败");
    await tx.insert(requirementSubmissions).values({
      requirementId: requirement.id,
      explorationRevisionId: revision.id,
      submission: requirement.currentSubmission,
      submittedByTokenId: employee.tokenId,
      createdAt: now,
    });
    await tx.update(explorations).set({
      state: "submitted", lastSubmittedRevision: input.expectedRevision, updatedAt: now,
    }).where(eq(explorations.id, explorationId));
    const data = {
      requirementId: requirement.id, number: requirement.number,
      submittedRevision: input.expectedRevision, submission: requirement.currentSubmission,
      submittedAt: now, reviewStatus: requirement.reviewStatus,
    };
    await tx.insert(explorationIdempotency).values({
      employeeId: employee.id, explorationId, operation: "submit", key: input.idempotencyKey, requestHash: hash,
      response: data, statusCode: 200, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
    });
    await tx.insert(explorationAuditEvents).values({
      actorType: "employee", actorId: employee.id, action: "requirement.submitted",
      explorationId, requirementId: requirement.id,
      metadata: { tokenId: employee.tokenId, revision: input.expectedRevision, submission: requirement.currentSubmission },
    });
    return { kind: "ok" as const, data };
  });
}

async function abandonExploration(employee: EmployeeCaller, explorationId: string, input: z.infer<typeof transitionSchema>) {
  const hash = requestHash(input);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${employee.id}:exploration:${explorationId}`}, 0))`);
    const replay = await tx.query.explorationIdempotency.findFirst({ where: and(
      eq(explorationIdempotency.employeeId, employee.id), eq(explorationIdempotency.operation, "abandon"),
      eq(explorationIdempotency.key, input.idempotencyKey),
    ) });
    if (replay) return replay.requestHash === hash
      ? { kind: "ok" as const, data: replay.response }
      : {
          kind: "conflict" as const,
          code: "IDEMPOTENCY_CONFLICT",
          message: "幂等键已用于不同的放弃请求",
          nextStep: "重试原放弃操作必须复用原 revision；新操作使用新幂等键",
          currentRevision: input.expectedRevision,
        };
    const current = await tx.query.explorations.findFirst({ where: and(
      eq(explorations.id, explorationId), eq(explorations.employeeId, employee.id),
    ) });
    if (!current) return { kind: "missing" as const };
    const blocked = await writeBlockReason(tx, employee, current.skillId, current.skillVersionId);
    if (blocked) return { kind: "blocked" as const, ...blocked };
    if (current.currentRevision !== input.expectedRevision) return {
      kind: "conflict" as const,
      code: "REVISION_CONFLICT",
      message: "探索已被另一会话更新，请重新读取",
      nextStep: "调用 get_exploration 读取最新 revision，再向员工确认是否放弃",
      currentRevision: current.currentRevision,
    };
    const state = current.lastSubmittedRevision === null ? "abandoned" as const : "submitted" as const;
    const now = new Date();
    await tx.update(explorations).set({
      state,
      abandonedAt: state === "abandoned" ? now : null,
      updatedAt: now,
    }).where(eq(explorations.id, explorationId));
    const data = { explorationId, state, revision: current.currentRevision, retainedSubmittedRevision: current.lastSubmittedRevision };
    await tx.insert(explorationIdempotency).values({
      employeeId: employee.id, explorationId, operation: "abandon", key: input.idempotencyKey, requestHash: hash,
      response: data, statusCode: 200, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
    });
    await tx.insert(explorationAuditEvents).values({
      actorType: "employee", actorId: employee.id, action: "exploration.abandoned",
      explorationId, metadata: { tokenId: employee.tokenId, retainedSubmittedRevision: current.lastSubmittedRevision },
    });
    return { kind: "ok" as const, data };
  });
}

async function employeeExplorationDetail(
  employeeId: string,
  explorationId: string,
  includeResourceContent = false,
  requestedSubmissionNumber?: number,
) {
  const [row] = await db.select({
    id: explorations.id, number: explorations.number, title: explorations.title,
    state: explorations.state, currentRevision: explorations.currentRevision,
    lastSubmittedRevision: explorations.lastSubmittedRevision, updatedAt: explorations.updatedAt,
    skillVersion: skillVersions.version, reviewStatus: requirements.reviewStatus,
    ruleSnapshot: explorations.ruleSnapshot,
    publicFeedback: requirements.publicFeedback, requirementNumber: requirements.number,
  }).from(explorations)
    .leftJoin(skillVersions, eq(explorations.skillVersionId, skillVersions.id))
    .leftJoin(requirements, eq(explorations.id, requirements.explorationId))
    .where(and(eq(explorations.id, explorationId), eq(explorations.employeeId, employeeId))).limit(1);
  if (!row) return null;
  const revisions = await db.select({
    revision: explorationRevisions.revision,
    content: explorationRevisions.content,
    createdAt: explorationRevisions.createdAt,
  }).from(explorationRevisions).where(eq(explorationRevisions.explorationId, explorationId))
    .orderBy(desc(explorationRevisions.revision));
  const activeRevision = row.state === "submitted" && row.lastSubmittedRevision !== null
    ? row.lastSubmittedRevision
    : row.currentRevision;
  const activeContent = revisions.find((item) => item.revision === activeRevision)?.content ?? null;
  let requestedSubmission = null;
  if (requestedSubmissionNumber !== undefined) {
    const [snapshot] = await db.select({
      requirementId: requirements.id,
      requirementNumber: requirements.number,
      submission: requirementSubmissions.submission,
      submittedAt: requirementSubmissions.createdAt,
      revision: explorationRevisions.revision,
      content: explorationRevisions.content,
    }).from(requirementSubmissions)
      .innerJoin(requirements, eq(requirementSubmissions.requirementId, requirements.id))
      .innerJoin(explorationRevisions, eq(requirementSubmissions.explorationRevisionId, explorationRevisions.id))
      .where(and(
        eq(requirements.explorationId, explorationId),
        eq(requirementSubmissions.submission, requestedSubmissionNumber),
      )).limit(1);
    if (snapshot) {
      const reviews = await db.select({
        status: requirementReviews.status,
        publicFeedback: requirementReviews.publicFeedback,
        reviewRevision: requirementReviews.reviewRevision,
        reviewedAt: requirementReviews.createdAt,
      }).from(requirementReviews).where(and(
        eq(requirementReviews.requirementId, snapshot.requirementId),
        eq(requirementReviews.submission, requestedSubmissionNumber),
      )).orderBy(desc(requirementReviews.reviewRevision));
      requestedSubmission = { ...snapshot, reviews };
    }
  }
  const snapshot = row.ruleSnapshot as {
    slug?: string;
    version?: string;
    content?: string;
    resources?: Array<{ path: string; size: number; contentBase64?: string }>;
  } | null;
  const ruleSnapshot = !snapshot || includeResourceContent
    ? snapshot
    : {
        ...snapshot,
        resources: snapshot.resources?.map(({ path, size }) => ({ path, size })) ?? [],
      };
  return { ...row, activeRevision, activeContent, ruleSnapshot, revisions, requestedSubmission };
}

// ---------- 管理员只读运营与规则配置 ----------

admin.use("*", requireAdmin);

admin.get("/", zValidator("query", adminListSchema), async (c) => {
  const query = c.req.valid("query");
  const conditions = [];
  if (query.keyword) {
    const pattern = `%${query.keyword}%`;
    conditions.push(or(
      ilike(explorations.number, pattern),
      ilike(explorations.title, pattern),
      ilike(employees.phone, pattern),
      ilike(employees.name, pattern),
      ilike(departments.name, pattern),
      ilike(skillVersions.version, pattern),
    )!);
  }
  if (query.state) conditions.push(eq(explorations.state, query.state));
  if (query.employee) {
    const pattern = `%${query.employee}%`;
    conditions.push(or(ilike(employees.phone, pattern), ilike(employees.name, pattern))!);
  }
  if (query.departmentId) conditions.push(eq(explorations.departmentId, query.departmentId));
  if (query.skillVersion) conditions.push(eq(skillVersions.version, query.skillVersion));
  if (query.updatedFrom) conditions.push(gte(explorations.updatedAt, query.updatedFrom));
  if (query.updatedTo) conditions.push(lte(explorations.updatedAt, query.updatedTo));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const rows = await db.select({
    id: explorations.id, number: explorations.number, title: explorations.title,
    state: explorations.state, currentRevision: explorations.currentRevision,
    lastSubmittedRevision: explorations.lastSubmittedRevision, updatedAt: explorations.updatedAt,
    employeeId: employees.id, employeePhone: employees.phone, employeeName: employees.name,
    departmentName: departments.name, skillVersion: skillVersions.version,
    reviewStatus: requirements.reviewStatus, requirementNumber: requirements.number,
  }).from(explorations).innerJoin(employees, eq(explorations.employeeId, employees.id))
    .leftJoin(departments, eq(explorations.departmentId, departments.id))
    .leftJoin(skillVersions, eq(explorations.skillVersionId, skillVersions.id))
    .leftJoin(requirements, eq(explorations.id, requirements.explorationId))
    .where(where)
    .orderBy(desc(explorations.updatedAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  const [totalRow] = await db.select({ value: count() })
    .from(explorations)
    .innerJoin(employees, eq(explorations.employeeId, employees.id))
    .leftJoin(departments, eq(explorations.departmentId, departments.id))
    .leftJoin(skillVersions, eq(explorations.skillVersionId, skillVersions.id))
    .where(where);
  return c.json({ data: {
    items: rows,
    total: totalRow?.value ?? 0,
    page: query.page,
    pageSize: query.pageSize,
  } });
});

admin.get("/policy", async (c) => {
  const row = await db.query.explorationPolicies.findFirst({
    where: eq(explorationPolicies.key, "requirement-exploration"),
  });
  return c.json({ data: row ?? null });
});

admin.get("/policy/options", async (c) => {
  const rows = await db.select({
    skillId: skills.id,
    slug: skills.slug,
    skillName: skills.name,
    skillVersionId: skillVersions.id,
    version: skillVersions.version,
    publishedAt: skillVersions.createdAt,
    content: skillVersions.content,
  }).from(skillVersions).innerJoin(skills, eq(skillVersions.skillId, skills.id))
    .where(and(
      eq(skills.status, "published"),
      eq(skills.skillType, "application"),
    ))
    .orderBy(desc(skillVersions.createdAt));
  if (rows.length === 0) return c.json({ data: [] });
  const fileRows = await db.select({
    versionId: skillVersionFiles.versionId,
    path: skillVersionFiles.path,
    contentBase64: skillVersionFiles.contentBase64,
  }).from(skillVersionFiles).where(inArray(
    skillVersionFiles.versionId,
    rows.map((row) => row.skillVersionId),
  ));
  const filesByVersion = new Map<string, SkillResourceFile[]>();
  for (const file of fileRows) {
    const files = filesByVersion.get(file.versionId) ?? [];
    files.push({ path: file.path, contentBase64: file.contentBase64 });
    filesByVersion.set(file.versionId, files);
  }
  const compatible = rows.flatMap(({ content, ...row }) => {
    try {
      validateRequirementExplorationApplicationSkill(
        parseSkillMd(content),
        filesByVersion.get(row.skillVersionId) ?? [],
      );
      return [row];
    } catch {
      return [];
    }
  });
  return c.json({ data: compatible });
});

function boundedEnv(name: string, fallback: string, max = 256): string {
  const value = process.env[name]?.trim();
  return value && value.length <= max ? value : fallback;
}

admin.get("/connector", (c) => {
  const mcpUrl = optionalMcpUrl(process.env.WORKBUDDY_CONNECTOR_MCP_URL);
  const marketUrl = optionalPublicHttpsUrl(process.env.WORKBUDDY_CONNECTOR_MARKET_URL);
  const verifiedAtRaw = process.env.WORKBUDDY_VERIFIED_AT?.trim();
  const verifiedAt = verifiedAtRaw && !Number.isNaN(Date.parse(verifiedAtRaw))
    ? new Date(verifiedAtRaw).toISOString()
    : null;
  const environment = boundedEnv("WORKBUDDY_CONNECTOR_ENVIRONMENT", "unconfigured", 32);
  const reviewStatus = boundedEnv("WORKBUDDY_CONNECTOR_REVIEW_STATUS", "not_submitted", 32);
  const verifiedClientVersion = boundedEnv("WORKBUDDY_VERIFIED_CLIENT_VERSION", "", 32) || null;
  const verifiedOs = boundedEnv("WORKBUDDY_VERIFIED_OS", "", 128) || null;
  const readiness = workBuddyConnectorReadiness({
    mcpUrlValid: mcpUrl.valid,
    environment,
    reviewStatus,
    marketUrlValid: marketUrl.valid,
    verifiedClientVersion,
    verifiedOs,
    verifiedAt,
  });
  return c.json({ data: {
    source: boundedEnv("WORKBUDDY_CONNECTOR_SOURCE", "skillhive", 64),
    packageVersion: boundedEnv("WORKBUDDY_CONNECTOR_VERSION", "1.0.0", 32),
    minClientVersion: boundedEnv("WORKBUDDY_MIN_CLIENT_VERSION", "4.24.0", 32),
    protocolVersion: "1.0",
    mcpUrl: mcpUrl.value,
    environment,
    reviewStatus,
    marketUrl: marketUrl.value,
    verifiedClientVersion,
    verifiedOs,
    verifiedAt,
    ...readiness,
    configurationIssues: [
      ...(!mcpUrl.valid ? ["尚未配置合法的 HTTP(S) /mcp 企业地址"] : []),
      ...(process.env.WORKBUDDY_CONNECTOR_MARKET_URL?.trim() && !marketUrl.valid ? ["公开市场入口不是合法 HTTPS 地址"] : []),
      ...(verifiedAtRaw && !verifiedAt ? ["实测时间格式无效"] : []),
    ],
  } });
});

const policySchema = z.object({
  skillId: z.string().uuid(),
  skillVersionId: z.string().uuid(),
  blockedSkillVersionIds: z.array(z.string().uuid()).max(100).default([]),
  enabled: z.boolean(),
});

admin.put("/policy", zValidator("json", policySchema), async (c) => {
  const actor = c.get("user");
  const input = c.req.valid("json");
  const version = await db.query.skillVersions.findFirst({ where: and(
    eq(skillVersions.id, input.skillVersionId), eq(skillVersions.skillId, input.skillId),
  ) });
  if (!version) return c.json({ error: "skill 版本与 skill 不匹配" }, 400);
  const skill = await db.query.skills.findFirst({ where: eq(skills.id, input.skillId) });
  if (
    !skill
    || skill.status !== "published"
    || skill.skillType !== "application"
  ) {
    return c.json({ error: "只能激活已发布的应用 Skill 版本" }, 409);
  }
  const currentPolicy = !input.enabled
    ? await db.query.explorationPolicies.findFirst({ where: eq(explorationPolicies.key, "requirement-exploration") })
    : null;
  const pausingCurrentVersion = !input.enabled
    && currentPolicy?.skillId === input.skillId
    && currentPolicy.skillVersionId === input.skillVersionId;
  // 暂停当前绑定必须始终可用；启用或换绑仍要校验所选版本的完整契约。
  if (!pausingCurrentVersion) {
    const candidateFiles = await db.select({
      path: skillVersionFiles.path,
      contentBase64: skillVersionFiles.contentBase64,
    }).from(skillVersionFiles).where(eq(skillVersionFiles.versionId, version.id));
    try {
      validateRequirementExplorationApplicationSkill(parseSkillMd(version.content), candidateFiles);
    } catch (error) {
      return c.json({
        error: `该应用 Skill 版本与需求探索不兼容：${(error as Error).message}`,
      }, 409);
    }
  }
  const blockedSkillVersionIds = [...new Set(input.blockedSkillVersionIds)];
  if (blockedSkillVersionIds.length > 0) {
    const matching = await db.select({ id: skillVersions.id }).from(skillVersions).where(and(
      eq(skillVersions.skillId, input.skillId),
      inArray(skillVersions.id, blockedSkillVersionIds),
    ));
    if (matching.length !== blockedSkillVersionIds.length) {
      return c.json({ error: "被禁止的规则版本必须属于当前需求探索 Skill" }, 400);
    }
  }
  const values = {
    ...input,
    blockedSkillVersionIds,
    key: "requirement-exploration",
    updatedBy: actor.id,
    updatedAt: new Date(),
  };
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('requirement-exploration-policy', 0))`);
    const [updated] = await tx.insert(explorationPolicies).values(values).onConflictDoUpdate({
      target: explorationPolicies.key, set: values,
    }).returning();
    if (!updated) throw new Error("更新需求探索策略失败");
    await tx.insert(explorationAuditEvents).values({
      actorType: "admin", actorId: actor.id, action: "exploration.policy_updated",
      metadata: {
        skillId: input.skillId,
        skillVersionId: input.skillVersionId,
        blockedSkillVersionIds,
        enabled: input.enabled,
      },
    });
    return updated;
  });
  return c.json({ data: row });
});

admin.get("/:id", async (c) => {
  const id = c.req.param("id");
  if (!uuid.safeParse(id).success) return c.json({ error: "无效的探索 ID" }, 400);
  const exploration = await db.query.explorations.findFirst({ where: eq(explorations.id, id) });
  if (!exploration) return c.json({ error: "探索不存在" }, 404);
  const employee = await db.query.employees.findFirst({ where: eq(employees.id, exploration.employeeId) });
  // 管理详情只需要展示规则版本和资源清单；资源正文仍通过受控的 Skill 文件接口读取，
  // 避免每次查看探索时返回可能较大的 base64 快照。
  const detail = await employeeExplorationDetail(exploration.employeeId, id, false);
  await db.insert(explorationAuditEvents).values({
    actorType: "admin", actorId: c.get("user").id, action: "exploration.viewed",
    explorationId: id, metadata: { employeeId: exploration.employeeId },
  });
  return c.json({ data: { ...detail, employee } });
});

export { admin as adminExplorations };
export default internal;
