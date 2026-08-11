import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db, skills } from "@skillhive/db";
import { eq, desc } from "drizzle-orm";
import { parseSkillMd } from "@skillhive/skill-schema";

const app = new Hono();

/** GET /api/skills — 技能市场列表（按更新时间倒序） */
app.get("/", async (c) => {
  // TODO: 接入鉴权后按用户部门过滤可见性
  const list = await db
    .select({
      id: skills.id,
      slug: skills.slug,
      name: skills.name,
      summary: skills.summary,
      category: skills.category,
      status: skills.status,
      updatedAt: skills.updatedAt,
    })
    .from(skills)
    .where(eq(skills.status, "published"))
    .orderBy(desc(skills.updatedAt));
  return c.json({ data: list });
});

/** GET /api/skills/:slug — skill 详情（含最新版本内容） */
app.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  const skill = await db.query.skills.findFirst({
    where: eq(skills.slug, slug),
  });
  if (!skill) return c.json({ error: "skill 不存在" }, 404);
  // TODO: 关联查询最新版本内容、调用量、评分
  return c.json({ data: skill });
});

const publishSchema = z.object({
  /** SKILL.md 全文（含 frontmatter） */
  content: z.string().min(1),
  changelog: z.string().default(""),
});

/** POST /api/skills/publish — IT 发布新版本（CLI 调用此接口） */
app.post("/publish", zValidator("json", publishSchema), async (c) => {
  const { content, changelog } = c.req.valid("json");

  // 1. 校验 SKILL.md 格式（不合法会直接抛错，由 zodValidator 之外的异常处理兜底）
  let parsed;
  try {
    parsed = parseSkillMd(content);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  // TODO: 2. 鉴权 —— 仅 publisher/admin 角色可发布
  // TODO: 3. upsert skill + 写入 skill_versions（同事务）
  // TODO: 4. 按 frontmatter.departments 更新可见性

  return c.json(
    {
      data: {
        slug: parsed.frontmatter.name,
        version: parsed.frontmatter.version ?? "0.1.0",
        changelog,
      },
      message: "格式校验通过（持久化逻辑待实现）",
    },
    201,
  );
});

export default app;
