import { Hono } from "hono";
import { db, skills, usageEvents } from "@skillhive/db";
import { count, eq, gte, sql } from "drizzle-orm";
import { requireAuth } from "../auth.js";

const app = new Hono();

// 看板数据仅 Console 消费，要求登录（skill 内容接口因需下发员工机保持公开）
app.use("*", requireAuth);

interface EventCounts {
  views: number;
  invokes: number;
  favorites: number;
  rates: number;
}

function emptyCounts(): EventCounts {
  return { views: 0, invokes: 0, favorites: 0, rates: 0 };
}

function accumulate(counts: EventCounts, event: string | null, value: number): void {
  if (event === "view") counts.views += value;
  else if (event === "invoke") counts.invokes += value;
  else if (event === "favorite") counts.favorites += value;
  else if (event === "rate") counts.rates += value;
}

/** GET /api/stats/overview — 全局概览（看板顶部数字卡片） */
app.get("/overview", async (c) => {
  const [skillRow] = await db
    .select({ value: count() })
    .from(skills)
    .where(eq(skills.status, "published"));

  const eventRows = await db
    .select({ event: usageEvents.event, value: count() })
    .from(usageEvents)
    .groupBy(usageEvents.event);

  const counts = emptyCounts();
  for (const r of eventRows) accumulate(counts, r.event, r.value);

  return c.json({
    data: {
      publishedSkills: skillRow?.value ?? 0,
      ...counts,
    },
  });
});

/** GET /api/stats/skills — 按 skill 维度的使用统计（看板表格） */
app.get("/skills", async (c) => {
  const rows = await db
    .select({
      slug: skills.slug,
      name: skills.name,
      category: skills.category,
      event: usageEvents.event,
      value: count(),
    })
    .from(skills)
    .leftJoin(usageEvents, eq(usageEvents.skillId, skills.id))
    .where(eq(skills.status, "published"))
    .groupBy(skills.id, usageEvents.event);

  const map = new Map<string, EventCounts & { slug: string; name: string; category: string }>();
  for (const r of rows) {
    const item = map.get(r.slug) ?? {
      slug: r.slug,
      name: r.name,
      category: r.category,
      ...emptyCounts(),
    };
    accumulate(item, r.event, r.value);
    map.set(r.slug, item);
  }

  const data = [...map.values()].sort((a, b) => b.invokes - a.invokes);
  return c.json({ data });
});

/** GET /api/stats/trend?days=14 — 每日使用趋势（看板柱状图） */
app.get("/trend", async (c) => {
  const days = Math.min(Number(c.req.query("days") ?? 14) || 14, 90);
  const since = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000);
  since.setHours(0, 0, 0, 0);

  const rows = await db
    .select({
      day: sql<string>`date_trunc('day', ${usageEvents.createdAt})::date`,
      event: usageEvents.event,
      value: count(),
    })
    .from(usageEvents)
    .where(gte(usageEvents.createdAt, since))
    .groupBy(sql`date_trunc('day', ${usageEvents.createdAt})::date`, usageEvents.event);

  // 按天聚合
  const byDay = new Map<string, EventCounts>();
  for (const r of rows) {
    const key = String(r.day).slice(0, 10);
    const item = byDay.get(key) ?? emptyCounts();
    accumulate(item, r.event, r.value);
    byDay.set(key, item);
  }

  // 补齐没有数据的日期，保证图表连续
  const data: Array<{ day: string } & EventCounts> = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(since.getTime() + i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    data.push({ day: key, ...(byDay.get(key) ?? emptyCounts()) });
  }

  return c.json({ data });
});

export default app;
