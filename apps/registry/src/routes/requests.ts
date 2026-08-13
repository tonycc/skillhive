import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db, users, skillRequests, skillRequestVotes } from "@skillhive/db";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { requireAuth, type SessionUser } from "../auth.js";
import { consumeRateLimit } from "../security.js";

const app = new Hono<{ Variables: { user: SessionUser } }>();
app.use("*", requireAuth);

/** GET /api/requests — 许愿列表（身份来自登录会话）。 */
app.get("/", async (c) => {
  const user = c.get("user");
  const rows = await db
    .select({
      id: skillRequests.id,
      title: skillRequests.title,
      description: skillRequests.description,
      status: skillRequests.status,
      createdAt: skillRequests.createdAt,
      requesterName: users.name,
      votes: count(skillRequestVotes.userId),
    })
    .from(skillRequests)
    .leftJoin(users, eq(skillRequests.requesterId, users.id))
    .leftJoin(skillRequestVotes, eq(skillRequestVotes.requestId, skillRequests.id))
    .groupBy(skillRequests.id, users.name)
    .orderBy(desc(count(skillRequestVotes.userId)), desc(skillRequests.createdAt));

  const mine = rows.length === 0
    ? []
    : await db
        .select({ requestId: skillRequestVotes.requestId })
        .from(skillRequestVotes)
        .where(and(
          eq(skillRequestVotes.userId, user.id),
          inArray(skillRequestVotes.requestId, rows.map((row) => row.id)),
        ));
  const myVotes = new Set(mine.map((row) => row.requestId));
  return c.json({ data: rows.map((row) => ({ ...row, votedByMe: myVotes.has(row.id) })) });
});

const createSchema = z.object({
  title: z.string().trim().min(1, "标题不能为空").max(256),
  description: z.string().trim().max(2000).default(""),
});

/** POST /api/requests — requesterId 只取当前登录用户。 */
app.post("/", zValidator("json", createSchema), async (c) => {
  const user = c.get("user");
  const rate = consumeRateLimit("create-request", user.id, 10, 60 * 60_000);
  if (!rate.allowed) {
    c.header("Retry-After", String(rate.retryAfterSeconds));
    return c.json({ error: "提交许愿过于频繁，请稍后再试" }, 429);
  }
  const { title, description } = c.req.valid("json");
  const [request] = await db
    .insert(skillRequests)
    .values({ title, description, requesterId: user.id })
    .returning();
  return c.json({ data: request }, 201);
});

/** POST /api/requests/:id/vote — 登录用户投票/取消投票。 */
app.post("/:id/vote", async (c) => {
  const requestId = c.req.param("id");
  if (!z.string().uuid().safeParse(requestId).success) return c.json({ error: "无效的许愿 ID" }, 400);
  const user = c.get("user");
  const rate = consumeRateLimit("vote-request", user.id, 60, 60_000);
  if (!rate.allowed) {
    c.header("Retry-After", String(rate.retryAfterSeconds));
    return c.json({ error: "投票操作过于频繁" }, 429);
  }

  const request = await db.query.skillRequests.findFirst({ where: eq(skillRequests.id, requestId) });
  if (!request) return c.json({ error: "许愿不存在" }, 404);
  const whereMine = and(
    eq(skillRequestVotes.requestId, requestId),
    eq(skillRequestVotes.userId, user.id),
  );

  const result = await db.transaction(async (tx) => {
    // 同一用户对同一愿望的 toggle 串行化，保证并发双击等价于两次切换。
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`vote:${requestId}:${user.id}`}, 0))`,
    );
    const deleted = await tx.delete(skillRequestVotes).where(whereMine).returning({
      requestId: skillRequestVotes.requestId,
    });
    if (deleted.length === 0) {
      await tx.insert(skillRequestVotes)
        .values({ requestId, userId: user.id })
        .onConflictDoNothing({ target: [skillRequestVotes.requestId, skillRequestVotes.userId] });
    }
    const [mine] = await tx.select({ requestId: skillRequestVotes.requestId })
      .from(skillRequestVotes).where(whereMine).limit(1);
    const [total] = await tx.select({ votes: count() }).from(skillRequestVotes)
      .where(eq(skillRequestVotes.requestId, requestId));
    return { voted: Boolean(mine), votes: total?.votes ?? 0 };
  });

  return c.json({ data: result });
});

export default app;
