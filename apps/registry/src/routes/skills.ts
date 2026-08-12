import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import {
  db,
  skills,
  skillVersions,
  departments,
  skillDepartmentVisibility,
  usageEvents,
} from "@skillhive/db";
import { and, eq, desc, inArray } from "drizzle-orm";
import { parseSkillMd } from "@skillhive/skill-schema";

/** 版本冲突时抛出，用于在事务外映射为 409 */
class VersionConflictError extends Error {
  constructor(
    public readonly slug: string,
    public readonly version: string,
  ) {
    super(`skill "${slug}" 的版本 ${version} 已存在，请提升版本号后重新发布`);
  }
}

/** MCP Server 内部接口地址（发布/下架后触发 prompts/list_changed 广播） */
const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? "http://localhost:3100";

/**
 * 通知 MCP Server 刷新所有活跃会话的 skill prompts（fire-and-forget）。
 * 通知失败不影响发布结果——客户端下次新建连接仍会拿到最新列表。
 */
function notifyPromptsChanged(): void {
  void fetch(`${MCP_SERVER_URL}/internal/prompts-changed`, { method: "POST" }).catch(
    (err) => {
      console.warn(
        "[skillhive] 通知 MCP Server 失败（不影响本次发布）：",
        err instanceof Error ? err.message : err,
      );
    },
  );
}

const app = new Hono();

/** GET /api/skills — 技能市场列表（按更新时间倒序） */
app.get("/", async (c) => {
  // TODO: 接入鉴权后按用户所在部门过滤可见性
  const list = await db
    .select({
      id: skills.id,
      slug: skills.slug,
      name: skills.name,
      summary: skills.summary,
      category: skills.category,
      status: skills.status,
      iconUrl: skills.iconUrl,
      updatedAt: skills.updatedAt,
    })
    .from(skills)
    .where(eq(skills.status, "published"))
    .orderBy(desc(skills.updatedAt));
  return c.json({ data: list });
});

/** GET /api/skills/:slug — skill 详情（含最新版本内容与可见部门） */
app.get("/:slug", async (c) => {
  const slug = c.req.param("slug");

  const skill = await db.query.skills.findFirst({
    where: eq(skills.slug, slug),
  });
  if (!skill) return c.json({ error: `skill "${slug}" 不存在` }, 404);

  // 最新版本
  const [latest] = await db
    .select()
    .from(skillVersions)
    .where(eq(skillVersions.skillId, skill.id))
    .orderBy(desc(skillVersions.createdAt))
    .limit(1);

  // 可见部门（空数组 = 全员可见）
  const visibility = await db
    .select({ name: departments.name })
    .from(skillDepartmentVisibility)
    .innerJoin(departments, eq(skillDepartmentVisibility.departmentId, departments.id))
    .where(eq(skillDepartmentVisibility.skillId, skill.id));

  // 剥除 frontmatter，仅保留 Markdown 正文（供 Console 渲染 / MCP prompt 使用）
  let body = "";
  if (latest) {
    try {
      body = parseSkillMd(latest.content).body;
    } catch {
      body = latest.content;
    }
  }

  return c.json({
    data: {
      ...skill,
      latestVersion: latest
        ? {
            version: latest.version,
            content: latest.content,
            changelog: latest.changelog,
            body,
            publishedAt: latest.createdAt,
          }
        : null,
      visibleDepartments: visibility.map((v) => v.name),
    },
  });
});

const eventSchema = z.object({
  /** 事件类型：view 浏览 / invoke 调用 / favorite 收藏 / rate 评分 */
  event: z.enum(["view", "invoke", "favorite", "rate"]),
  /** 评分事件的分值（1-5） */
  score: z.string().max(8).optional(),
  /** 来源客户端，如 workbuddy / console / cli */
  client: z.string().max(64).default("unknown"),
});

/** POST /api/skills/:slug/events — 埋点上报（MCP Server / Console 调用） */
app.post("/:slug/events", zValidator("json", eventSchema), async (c) => {
  const slug = c.req.param("slug");
  const skill = await db.query.skills.findFirst({ where: eq(skills.slug, slug) });
  if (!skill) return c.json({ error: `skill "${slug}" 不存在` }, 404);

  const { event, score, client } = c.req.valid("json");
  // TODO: 接入鉴权后记录 userId
  await db.insert(usageEvents).values({ skillId: skill.id, event, score, client });
  return c.json({ ok: true }, 201);
});

const publishSchema = z.object({
  /** SKILL.md 全文（含 frontmatter） */
  content: z.string().min(1),
  changelog: z.string().default(""),
});

/** POST /api/skills/publish — IT 发布新版本（CLI 调用此接口） */
app.post("/publish", zValidator("json", publishSchema), async (c) => {
  const { content, changelog } = c.req.valid("json");

  // 1. 校验 SKILL.md 格式
  let parsed;
  try {
    parsed = parseSkillMd(content);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  const slug = parsed.frontmatter.name;
  const version = parsed.frontmatter.version ?? "0.1.0";

  // TODO: 2. 鉴权 —— 仅 publisher/admin 角色可发布，ownerId/publishedBy 取当前用户

  try {
    const result = await db.transaction(async (tx) => {
      // 3. upsert skill 主记录（已存在则更新摘要与分类，并置为 published）
      const [skill] = await tx
        .insert(skills)
        .values({
          slug,
          name: slug,
          summary: parsed.frontmatter.description,
          category: parsed.frontmatter.category ?? "通用",
          status: "published",
          iconUrl: parsed.frontmatter.icon ?? null,
        })
        .onConflictDoUpdate({
          target: skills.slug,
          set: {
            summary: parsed.frontmatter.description,
            category: parsed.frontmatter.category ?? "通用",
            status: "published",
            iconUrl: parsed.frontmatter.icon ?? null,
          },
        })
        .returning();

      // 4. 版本号防重
      const dup = await tx.query.skillVersions.findFirst({
        where: and(
          eq(skillVersions.skillId, skill.id),
          eq(skillVersions.version, version),
        ),
      });
      if (dup) throw new VersionConflictError(slug, version);

      // 5. 写入新版本
      const [skillVersion] = await tx
        .insert(skillVersions)
        .values({ skillId: skill.id, version, content, changelog })
        .returning();

      // 6. 更新部门可见性：缺省 = 全员可见（清空限制）
      await tx
        .delete(skillDepartmentVisibility)
        .where(eq(skillDepartmentVisibility.skillId, skill.id));

      const deptNames = parsed.frontmatter.departments ?? [];
      if (deptNames.length > 0) {
        // 部门不存在则自动创建（MVP 简化；正式版应来自企业微信组织架构同步）
        await tx
          .insert(departments)
          .values(deptNames.map((name) => ({ name })))
          .onConflictDoNothing({ target: departments.name });

        const deptRows = await tx
          .select({ id: departments.id })
          .from(departments)
          .where(inArray(departments.name, deptNames));

        if (deptRows.length > 0) {
          await tx.insert(skillDepartmentVisibility).values(
            deptRows.map((d) => ({ skillId: skill.id, departmentId: d.id })),
          );
        }
      }

      return { skill, skillVersion };
    });

    // 7. 通知 MCP Server 向活跃会话推送 prompts/list_changed（失败不影响发布）
    notifyPromptsChanged();

    return c.json(
      {
        data: {
          slug: result.skill.slug,
          version: result.skillVersion.version,
          status: result.skill.status,
        },
      },
      201,
    );
  } catch (err) {
    if (err instanceof VersionConflictError) {
      return c.json({ error: err.message }, 409);
    }
    console.error("发布失败：", err);
    return c.json({ error: "服务器内部错误" }, 500);
  }
});

export default app;
