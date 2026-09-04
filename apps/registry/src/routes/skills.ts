import { Hono, type Context } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import {
  db,
  departments,
  skillDepartmentVisibility,
  skills,
  skillVersionFiles,
  skillVersions,
  usageEvents,
} from "@skillhive/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  parseSkillMd,
  validateResourceFiles,
  validateResourcePath,
} from "@skillhive/skill-schema";
import {
  requireAdmin,
  requireInternalToken,
  requirePublisher,
  resolveInternalEmployee,
  type SessionUser,
} from "../auth.js";
import { consumeRateLimit } from "../security.js";
import { notifyPromptsChanged } from "../prompt-notifications.js";

class VersionConflictError extends Error {
  constructor(public readonly slug: string, public readonly version: string) {
    super(`skill "${slug}" 的版本 ${version} 已存在，请提升版本号后重新发布`);
  }
}

class PublishForbiddenError extends Error {}

type AppEnv = { Variables: { user: SessionUser } };
const app = new Hono<AppEnv>();

// 列表与内容都带用户/部门可见性，禁止共享缓存保存或串用响应。
app.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "private, no-store");
});

type SkillRow = typeof skills.$inferSelect;

async function visibilityDepartmentIds(skillId: string): Promise<string[]> {
  const rows = await db
    .select({ departmentId: skillDepartmentVisibility.departmentId })
    .from(skillDepartmentVisibility)
    .where(eq(skillDepartmentVisibility.skillId, skillId));
  return rows.map((row) => row.departmentId);
}

/** published 遵守部门范围；非发布内容仅 admin 或资源 owner publisher 可预览。 */
async function canReadSkill(skill: SkillRow, user: SessionUser): Promise<boolean> {
  if (skill.status !== "published") {
    return user.role === "admin" || (user.role === "publisher" && skill.ownerId === user.id);
  }
  const departmentIds = await visibilityDepartmentIds(skill.id);
  return departmentIds.length === 0
    || (user.departmentId !== null && departmentIds.includes(user.departmentId));
}

/**
 * 内部技能接口不仅验证服务间密钥，还绑定发起调用的 PAT。
 * 这样 stdio 等长生命周期进程中的令牌一经吊销，下一个数据请求也会立即失败。
 */
async function resolveInternalCaller(c: Context<AppEnv>): Promise<SessionUser | null> {
  const employee = await resolveInternalEmployee(c);
  if (!employee?.scopes.includes("skills:read")) return null;
  return {
    id: employee.id,
    email: `${employee.id}@employee.invalid`,
    name: employee.name,
    role: "member",
    departmentId: employee.departmentId,
  };
}

async function visiblePublishedSkills(user: SessionUser) {
  const list = await db
    .select({
      id: skills.id,
      slug: skills.slug,
      name: skills.name,
      summary: skills.summary,
      category: skills.category,
      skillType: skills.skillType,
      status: skills.status,
      iconUrl: skills.iconUrl,
      updatedAt: skills.updatedAt,
    })
    .from(skills)
    .where(eq(skills.status, "published"))
    .orderBy(desc(skills.updatedAt));
  if (list.length === 0) return list;

  const restrictions = await db
    .select({
      skillId: skillDepartmentVisibility.skillId,
      departmentId: skillDepartmentVisibility.departmentId,
    })
    .from(skillDepartmentVisibility)
    .where(inArray(skillDepartmentVisibility.skillId, list.map((skill) => skill.id)));
  const bySkill = new Map<string, string[]>();
  for (const row of restrictions) {
    const values = bySkill.get(row.skillId) ?? [];
    values.push(row.departmentId);
    bySkill.set(row.skillId, values);
  }
  const visible = list.filter((skill) => {
    const restrictedTo = bySkill.get(skill.id) ?? [];
    return restrictedTo.length === 0
      || (user.departmentId !== null && restrictedTo.includes(user.departmentId));
  });
  if (visible.length === 0) return visible;

  // tags 随不可变版本存储；列表只暴露每个 Skill 最新版本的标签，供客户端做意图检索。
  const versionRows = await db
    .select({
      skillId: skillVersions.skillId,
      content: skillVersions.content,
    })
    .from(skillVersions)
    .where(inArray(skillVersions.skillId, visible.map((skill) => skill.id)))
    .orderBy(desc(skillVersions.createdAt));
  const tagsBySkill = new Map<string, string[]>();
  for (const version of versionRows) {
    if (tagsBySkill.has(version.skillId)) continue;
    try {
      tagsBySkill.set(version.skillId, parseSkillMd(version.content).frontmatter.tags);
    } catch {
      tagsBySkill.set(version.skillId, []);
    }
  }
  return visible.map((skill) => ({ ...skill, tags: tagsBySkill.get(skill.id) ?? [] }));
}

async function skillDetail(slug: string, user: SessionUser, allowApplication = false) {
  const skill = await db.query.skills.findFirst({ where: eq(skills.slug, slug) });
  if (!skill) return { kind: "missing" as const };
  if (!allowApplication && skill.skillType !== "ordinary") return { kind: "forbidden" as const };
  if (!(await canReadSkill(skill, user))) return { kind: "forbidden" as const };

  const [latest] = await db
    .select({
      id: skillVersions.id,
      version: skillVersions.version,
      content: skillVersions.content,
      changelog: skillVersions.changelog,
      createdAt: skillVersions.createdAt,
    })
    .from(skillVersions)
    .where(eq(skillVersions.skillId, skill.id))
    .orderBy(desc(skillVersions.createdAt))
    .limit(1);
  const files = latest
    ? await db
        .select({
          path: skillVersionFiles.path,
          size: skillVersionFiles.size,
        })
        .from(skillVersionFiles)
        .where(eq(skillVersionFiles.versionId, latest.id))
    : [];
  const visibility = await db
    .select({ name: departments.name })
    .from(skillDepartmentVisibility)
    .innerJoin(departments, eq(skillDepartmentVisibility.departmentId, departments.id))
    .where(eq(skillDepartmentVisibility.skillId, skill.id));
  let body = "";
  let frontmatter: ReturnType<typeof parseSkillMd>["frontmatter"] | null = null;
  if (latest) {
    try {
      const parsed = parseSkillMd(latest.content);
      body = parsed.body;
      frontmatter = parsed.frontmatter;
    } catch {
      // 历史脏数据不应把未经解析的 frontmatter 当作用户可见正文下发。
      body = "该历史版本的 SKILL.md 格式无效，请由负责人重新发布。";
    }
  }
  return {
    kind: "ok" as const,
    data: {
      ...skill,
      latestVersion: latest
        ? {
            version: latest.version,
            changelog: latest.changelog,
            body,
            frontmatter,
            publishedAt: latest.createdAt,
            files,
          }
        : null,
      visibleDepartments: visibility.map((item) => item.name),
    },
  };
}

type SkillFileResult =
  | { kind: "ok"; data: { version: string; path: string; size: number; contentBase64: string } }
  | { kind: "invalid" | "missing" | "forbidden" };

async function skillFile(
  slug: string,
  version: string,
  path: string,
  user: SessionUser,
  allowApplication = false,
): Promise<SkillFileResult> {
  if (!/^\d+\.\d+\.\d+$/.test(version) || version.length > 32) return { kind: "invalid" };
  if (validateResourcePath(path)) return { kind: "invalid" };
  const skill = await db.query.skills.findFirst({ where: eq(skills.slug, slug) });
  if (!skill) return { kind: "missing" };
  if (!allowApplication && skill.skillType !== "ordinary") return { kind: "forbidden" };
  if (!(await canReadSkill(skill, user))) return { kind: "forbidden" };

  const [selectedVersion] = await db
    .select({ id: skillVersions.id })
    .from(skillVersions)
    .where(and(
      eq(skillVersions.skillId, skill.id),
      eq(skillVersions.version, version),
    ))
    .limit(1);
  if (!selectedVersion) return { kind: "missing" };

  const [file] = await db
    .select({
      path: skillVersionFiles.path,
      size: skillVersionFiles.size,
      contentBase64: skillVersionFiles.contentBase64,
    })
    .from(skillVersionFiles)
    .where(and(
      eq(skillVersionFiles.versionId, selectedVersion.id),
      eq(skillVersionFiles.path, path),
    ))
    .limit(1);
  return file ? { kind: "ok", data: { version, ...file } } : { kind: "missing" };
}

function fileResponse(c: Context<AppEnv>, result: SkillFileResult) {
  switch (result.kind) {
    case "invalid": return c.json({ error: "无效或缺失的资源版本/文件路径" }, 400);
    case "forbidden": return c.json({ error: "无权读取该资源文件" }, 403);
    case "missing": return c.json({ error: "资源文件不存在" }, 404);
    case "ok": return c.json({ data: result.data });
  }
}

function detailResponse(c: Context<AppEnv>, result: Awaited<ReturnType<typeof skillDetail>>, slug: string) {
  if (result.kind === "missing") return c.json({ error: `skill "${slug}" 不存在` }, 404);
  if (result.kind === "forbidden") return c.json({ error: "无权查看该 skill" }, 403);
  return c.json({ data: result.data });
}

/** MCP 内部、按 PAT 所属实时用户过滤的列表与详情。 */
app.get("/internal", requireInternalToken, async (c) => {
  const user = await resolveInternalCaller(c);
  if (!user) return c.json({ error: "内部调用身份或接入令牌已失效" }, 401);
  return c.json({
    data: (await visiblePublishedSkills(user)).filter((skill) => skill.skillType === "ordinary"),
  });
});

const eventSchema = z.object({
  event: z.enum(["view", "invoke", "favorite", "rate"]),
  score: z.number().int().min(1).max(5).optional(),
  client: z.string().trim().min(1).max(64).regex(/^[\w.-]+$/).default("unknown"),
}).superRefine((value, ctx) => {
  if (value.event === "rate" && value.score === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["score"], message: "评分事件必须提供 1-5 分" });
  }
  if (value.event !== "rate" && value.score !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["score"], message: "仅评分事件可提供 score" });
  }
});

async function recordEvent(
  c: Context<AppEnv>,
  user: SessionUser,
  slug: string,
  payload: z.infer<typeof eventSchema>,
) {
  const skill = await db.query.skills.findFirst({ where: eq(skills.slug, slug) });
  if (!skill) return c.json({ error: `skill "${slug}" 不存在` }, 404);
  if (skill.skillType !== "ordinary") return c.json({ error: "应用 Skill 只能由应用使用" }, 403);
  if (!(await canReadSkill(skill, user))) return c.json({ error: "无权访问该 skill" }, 403);
  const rate = consumeRateLimit("skill-event", user.id, 120, 60_000);
  if (!rate.allowed) {
    c.header("Retry-After", String(rate.retryAfterSeconds));
    return c.json({ error: "事件上报过于频繁" }, 429);
  }
  await db.insert(usageEvents).values({
    skillId: skill.id,
    event: payload.event,
    score: payload.score === undefined ? null : String(payload.score),
    client: payload.client,
    // employee.id 不属于 users 外键；员工业务行为记录在探索审计表中。
    userId: c.req.header("X-SkillHive-Subject-Type") === "employee" ? null : user.id,
  });
  return c.json({ ok: true }, 201);
}

app.post(
  "/internal/:slug/events",
  requireInternalToken,
  zValidator("json", eventSchema),
  async (c) => {
    const user = await resolveInternalCaller(c);
    if (!user) return c.json({ error: "内部调用身份或接入令牌已失效" }, 401);
    return recordEvent(c, user, c.req.param("slug"), c.req.valid("json"));
  },
);

app.get("/internal/:slug/file", requireInternalToken, async (c) => {
  const user = await resolveInternalCaller(c);
  if (!user) return c.json({ error: "内部调用身份或接入令牌已失效" }, 401);
  return fileResponse(
    c,
    await skillFile(
      c.req.param("slug"),
      c.req.query("version") ?? "",
      c.req.query("path") ?? "",
      user,
    ),
  );
});

app.get("/internal/:slug", requireInternalToken, async (c) => {
  const user = await resolveInternalCaller(c);
  if (!user) return c.json({ error: "内部调用身份或接入令牌已失效" }, 401);
  const slug = c.req.param("slug");
  return detailResponse(c, await skillDetail(slug, user), slug);
});

/** Console 技能管理列表（必须登录，published 且按部门过滤）。 */
app.get("/", requireAdmin, async (c) => c.json({
  data: await visiblePublishedSkills(c.get("user")),
}));

/** Console 埋点：身份只从会话派生。 */
app.post("/:slug/events", requireAdmin, zValidator("json", eventSchema), async (c) =>
  recordEvent(c, c.get("user"), c.req.param("slug"), c.req.valid("json")));

const publishSchema = z.object({
  content: z.string().min(1).max(512 * 1024),
  changelog: z.string().max(8 * 1024).default(""),
  skillType: z.enum(["ordinary", "application"]).default("ordinary"),
  files: z.array(z.object({
    path: z.string().min(1).max(512),
    contentBase64: z.string().max(768 * 1024),
  })).max(20).default([]),
});

/** POST /api/skills/publish — 发布新版本（publisher 只能管理自己的 slug，admin 可管理全部）。 */
app.post("/publish", requirePublisher, zValidator("json", publishSchema), async (c) => {
  const publisher = c.get("user");
  const { content, changelog, files, skillType } = c.req.valid("json");
  let parsed;
  try {
    parsed = parseSkillMd(content);
    validateResourceFiles(files);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
  const slug = parsed.frontmatter.name;
  const version = parsed.frontmatter.version ?? "0.1.0";
  if (skillType === "application" && publisher.role !== "admin") {
    return c.json({ error: "只有管理员可以发布应用 Skill" }, 403);
  }

  try {
    const result = await db.transaction(async (tx) => {
      // 同一 slug 串行发布，避免两个 publisher 同时首次创建时绕过 owner 检查。
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${slug}, 0))`);
      const existing = await tx.query.skills.findFirst({ where: eq(skills.slug, slug) });
      if (existing && existing.skillType !== skillType) {
        throw new PublishForbiddenError(`skill "${slug}" 的用途类型不能在普通 Skill 与应用 Skill 之间变更`);
      }
      if (existing && publisher.role !== "admin" && existing.ownerId !== publisher.id) {
        throw new PublishForbiddenError(`无权发布其他负责人管理的 skill "${slug}"`);
      }

      const [skill] = await tx
        .insert(skills)
        .values({
          slug,
          name: slug,
          summary: parsed.frontmatter.description,
          category: parsed.frontmatter.category ?? "通用",
          skillType,
          status: "published",
          iconUrl: parsed.frontmatter.icon ?? null,
          ownerId: publisher.id,
        })
        .onConflictDoUpdate({
          target: skills.slug,
          set: {
            summary: parsed.frontmatter.description,
            category: parsed.frontmatter.category ?? "通用",
            skillType,
            status: "published",
            iconUrl: parsed.frontmatter.icon ?? null,
          },
        })
        .returning();
      if (!skill) throw new Error("写入 skill 失败");

      const duplicate = await tx.query.skillVersions.findFirst({
        where: and(eq(skillVersions.skillId, skill.id), eq(skillVersions.version, version)),
      });
      if (duplicate) throw new VersionConflictError(slug, version);

      const [skillVersion] = await tx
        .insert(skillVersions)
        .values({ skillId: skill.id, version, content, changelog, publishedBy: publisher.id })
        .returning();
      if (!skillVersion) throw new Error("写入 skill 版本失败");

      if (files.length > 0) {
        await tx.insert(skillVersionFiles).values(files.map((file) => ({
          versionId: skillVersion.id,
          path: file.path,
          contentBase64: file.contentBase64,
          size: decodedBase64Size(file.contentBase64),
        })));
      }

      await tx.delete(skillDepartmentVisibility).where(eq(skillDepartmentVisibility.skillId, skill.id));
      const departmentNames = parsed.frontmatter.departments ?? [];
      if (departmentNames.length > 0) {
        await tx.insert(departments).values(departmentNames.map((name) => ({ name })))
          .onConflictDoNothing({ target: departments.name });
        const departmentRows = await tx.select({ id: departments.id }).from(departments)
          .where(inArray(departments.name, departmentNames));
        if (departmentRows.length !== departmentNames.length) throw new Error("部门可见性写入不完整");
        await tx.insert(skillDepartmentVisibility).values(departmentRows.map((department) => ({
          skillId: skill.id,
          departmentId: department.id,
        })));
      }
      return { skill, skillVersion };
    });

    notifyPromptsChanged();
    return c.json({
      data: {
        slug: result.skill.slug,
        version: result.skillVersion.version,
        status: result.skill.status,
        skillType: result.skill.skillType,
      },
    }, 201);
  } catch (err) {
    if (err instanceof VersionConflictError) return c.json({ error: err.message }, 409);
    if (err instanceof PublishForbiddenError) return c.json({ error: err.message }, 403);
    if (isUniqueViolation(err)) return c.json({ error: `skill "${slug}" 的版本 ${version} 已存在` }, 409);
    console.error("发布失败：", err);
    return c.json({ error: "服务器内部错误" }, 500);
  }
});

/** Console 详情：必须登录；对非 published 内容应用管理预览规则。 */
app.get("/:slug/file", requireAdmin, async (c) => fileResponse(
  c,
  await skillFile(
    c.req.param("slug"),
    c.req.query("version") ?? "",
    c.req.query("path") ?? "",
    c.get("user"),
    true,
  ),
));

app.get("/:slug", requireAdmin, async (c) => {
  const slug = c.req.param("slug");
  return detailResponse(c, await skillDetail(slug, c.get("user"), true), slug);
});

function decodedBase64Size(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return value.length / 4 * 3 - padding;
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: string; cause?: { code?: string } };
  return value.code === "23505" || value.cause?.code === "23505";
}

export default app;
