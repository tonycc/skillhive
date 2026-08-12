import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { db, users, skillRequests, skillRequestVotes } from "@skillhive/db";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { requireAuth } from "../auth.js";

const app = new Hono();

// 许愿墙仅 Console 消费，要求登录（skill 内容接口因需下发员工机保持公开）
app.use("*", requireAuth);

/**
 * 将浏览器指纹令牌映射为匿名用户（登录态下的投票身份兜底）。
 * TODO: 后续可将投票身份切换为登录用户。
 */
async function resolveAnonUser(voterToken: string, name = "匿名员工") {
  const email = `anon-${voterToken}@skillhive.local`;
  await db.insert(users).values({ email, name }).onConflictDoNothing({
    target: users.email,
  });
  const [user] = await db.select().from(users).where(eq(users.email, email));
  return user;
}

/** GET /api/requests?voterToken=xxx — 许愿列表（按票数排序） */
app.get("/", async (c) => {
  const voterToken = c.req.query("voterToken");

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
    .orderBy(desc(count(skillRequestVotes.userId)));

  // 当前访客已投过票的许愿
  let myVotes = new Set<string>();
  if (voterToken) {
    const me = await resolveAnonUser(voterToken);
    const mine = await db
      .select({ requestId: skillRequestVotes.requestId })
      .from(skillRequestVotes)
      .where(
        and(
          eq(skillRequestVotes.userId, me.id),
          inArray(
            skillRequestVotes.requestId,
            rows.map((r) => r.id),
          ),
        ),
      );
    myVotes = new Set(mine.map((m) => m.requestId));
  }

  return c.json({
    data: rows.map((r) => ({ ...r, votedByMe: myVotes.has(r.id) })),
  });
});

const createSchema = z.object({
  title: z.string().min(1, "标题不能为空").max(256),
  description: z.string().max(2000).default(""),
  nickname: z.string().max(64).default("匿名员工"),
  voterToken: z.string().min(8).max(64),
});

/** POST /api/requests — 提交许愿 */
app.post("/", zValidator("json", createSchema), async (c) => {
  const { title, description, nickname, voterToken } = c.req.valid("json");
  const me = await resolveAnonUser(voterToken, nickname);

  const [request] = await db
    .insert(skillRequests)
    .values({ title, description, requesterId: me.id })
    .returning();

  return c.json({ data: request }, 201);
});

const voteSchema = z.object({
  voterToken: z.string().min(8).max(64),
});

/** POST /api/requests/:id/vote — 投票/取消投票（开关式） */
app.post("/:id/vote", zValidator("json", voteSchema), async (c) => {
  const requestId = c.req.param("id");
  const { voterToken } = c.req.valid("json");

  const request = await db.query.skillRequests.findFirst({
    where: eq(skillRequests.id, requestId),
  });
  if (!request) return c.json({ error: "许愿不存在" }, 404);

  const me = await resolveAnonUser(voterToken);
  const whereDup = and(
    eq(skillRequestVotes.requestId, requestId),
    eq(skillRequestVotes.userId, me.id),
  );

  const existing = await db
    .select()
    .from(skillRequestVotes)
    .where(whereDup);

  let voted: boolean;
  if (existing.length > 0) {
    await db.delete(skillRequestVotes).where(whereDup);
    voted = false;
  } else {
    await db.insert(skillRequestVotes).values({ requestId, userId: me.id });
    voted = true;
  }

  const [row] = await db
    .select({ votes: count() })
    .from(skillRequestVotes)
    .where(eq(skillRequestVotes.requestId, requestId));

  return c.json({ data: { voted, votes: row?.votes ?? 0 } });
});

// TODO: IT 标记状态（planned/done/rejected）需登录鉴权后开放

export default app;
