import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, users, userTokens } from "@skillhive/db";
import {
  generatePat,
  hashPat,
  issueToken,
  requireAuth,
  requireInternalToken,
  verifyPassword,
  type SessionUser,
} from "../auth.js";

/** 登录鉴权路由：/api/auth */
const app = new Hono<{ Variables: { user: SessionUser } }>();

const loginSchema = z.object({
  /** 账号（通常是邮箱，也允许 admin 这类短用户名） */
  email: z.string().min(1),
  password: z.string().min(1),
});

/** POST /api/auth/login — 邮箱 + 密码登录，返回会话令牌 */
app.post("/login", zValidator("json", loginSchema), async (c) => {
  const { email, password } = c.req.valid("json");

  const user = await db.query.users.findFirst({ where: eq(users.email, email) });
  // 用户不存在或密码错误返回同样的提示，避免探测账号是否存在
  if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
    return c.json({ error: "邮箱或密码错误" }, 401);
  }

  const sessionUser: SessionUser = {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  };
  const token = await issueToken(sessionUser);
  return c.json({ data: { token, user: sessionUser } });
});

/** GET /api/auth/me — 校验会话并返回当前用户（CLI whoami / Console 展示用） */
app.get("/me", requireAuth, async (c) => {
  return c.json({ data: c.get("user") });
});

// ---------- 个人接入令牌（PAT） ----------

const createTokenSchema = z.object({
  /** 备注，如“工作 Mac 的 WorkBuddy” */
  name: z.string().max(128).default(""),
});

/** POST /api/auth/tokens — 生成接入令牌（明文仅此一次返回） */
app.post("/tokens", requireAuth, zValidator("json", createTokenSchema), async (c) => {
  const user = c.get("user");
  const { name } = c.req.valid("json");
  const { token, hash } = generatePat();
  const [row] = await db
    .insert(userTokens)
    .values({ userId: user.id, name, tokenHash: hash })
    .returning({ id: userTokens.id, createdAt: userTokens.createdAt });
  return c.json({ data: { id: row?.id, token, name } }, 201);
});

/** GET /api/auth/tokens — 列出我的令牌（不含明文） */
app.get("/tokens", requireAuth, async (c) => {
  const user = c.get("user");
  const rows = await db
    .select({
      id: userTokens.id,
      name: userTokens.name,
      createdAt: userTokens.createdAt,
      lastUsedAt: userTokens.lastUsedAt,
      revokedAt: userTokens.revokedAt,
    })
    .from(userTokens)
    .where(eq(userTokens.userId, user.id))
    .orderBy(desc(userTokens.createdAt));
  return c.json({
    data: rows.map((r) => ({ ...r, revoked: r.revokedAt !== null })),
  });
});

/** DELETE /api/auth/tokens/:id — 吊销我的令牌（仅本人可操作） */
app.delete("/tokens/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const [updated] = await db
    .update(userTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(userTokens.id, id),
        eq(userTokens.userId, user.id),
        isNull(userTokens.revokedAt),
      ),
    )
    .returning({ id: userTokens.id });
  if (!updated) return c.json({ error: "令牌不存在、已吊销或不属于当前账号" }, 404);
  return c.json({ ok: true });
});

const resolvePatSchema = z.object({ token: z.string().min(1) });

/**
 * POST /api/auth/resolve-pat — MCP Server 专用：校验 PAT 并返回令牌所属用户。
 * 内部接口，需 X-SkillHive-Internal-Token 头。
 */
app.post(
  "/resolve-pat",
  requireInternalToken,
  zValidator("json", resolvePatSchema),
  async (c) => {
    const { token } = c.req.valid("json");
    const row = await db.query.userTokens.findFirst({
      where: and(
        eq(userTokens.tokenHash, hashPat(token)),
        isNull(userTokens.revokedAt),
      ),
    });
    if (!row) return c.json({ error: "无效或已吊销的接入令牌" }, 401);

    const user = await db.query.users.findFirst({ where: eq(users.id, row.userId) });
    if (!user) return c.json({ error: "令牌所属账号不存在" }, 401);

    // 更新最近使用时间（fire-and-forget）
    void db
      .update(userTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(userTokens.id, row.id))
      .catch(() => {});

    const sessionUser: SessionUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    };
    return c.json({ data: sessionUser });
  },
);

export default app;
