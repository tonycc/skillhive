import { Hono } from "hono";
import { db, explorationAuditEvents, explorationRevisions, explorations, requirements, skills, usageEvents } from "@skillhive/db";
import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import { requireAdmin } from "../auth.js";

const app = new Hono();

// 使用统计属于管理端运营数据，仅管理员可查看。
app.use("*", requireAdmin);

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
  const [[started], [saved], [submitted], [needsInformation]] = await Promise.all([
    db.select({ value: count() }).from(explorations),
    db.select({ value: count() }).from(explorationRevisions),
    db.select({ value: count() }).from(requirements),
    db.select({ value: count() }).from(requirements).where(eq(requirements.reviewStatus, "needs_information")),
  ]);
  const startedCount = started?.value ?? 0;
  const submittedCount = submitted?.value ?? 0;

  return c.json({
    data: {
      publishedSkills: skillRow?.value ?? 0,
      ...counts,
      explorationsStarted: startedCount,
      draftsSaved: saved?.value ?? 0,
      requirementsSubmitted: submittedCount,
      needsInformation: needsInformation?.value ?? 0,
      completionRate: startedCount === 0 ? 0 : submittedCount / startedCount,
    },
  });
});

/** GET /api/stats/exploration-errors?days=14 — 仅聚合错误码，不复制需求正文。 */
app.get("/exploration-errors", async (c) => {
  const requestedDays = Number(c.req.query("days") ?? 14);
  const days = Number.isFinite(requestedDays)
    ? Math.min(Math.max(Math.trunc(requestedDays), 1), 90)
    : 14;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1_000);
  const codeExpression = sql<string>`${explorationAuditEvents.metadata}->>'code'`;
  const rows = await db.select({
    code: codeExpression,
    count: count(),
    lastOccurredAt: sql<string | null>`max(${explorationAuditEvents.createdAt})::text`,
  }).from(explorationAuditEvents)
    .where(and(
      eq(explorationAuditEvents.action, "exploration.error"),
      gte(explorationAuditEvents.createdAt, since),
    ))
    .groupBy(codeExpression)
    .orderBy(desc(count()));
  return c.json({
    data: rows
      .filter((row) => Boolean(row.code))
      .map((row) => ({
        ...row,
        lastOccurredAt: row.lastOccurredAt ? new Date(row.lastOccurredAt).toISOString() : null,
      })),
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
  const requestedDays = Number(c.req.query("days") ?? 14);
  const days = Number.isFinite(requestedDays)
    ? Math.min(Math.max(Math.trunc(requestedDays), 1), 90)
    : 14;
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
