import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { deleteCookie, setCookie } from "hono/cookie";
import { db, users, userTokens } from "@skillhive/db";
import {
  generatePat,
  hashPassword,
  hashPat,
  issueToken,
  requireAdmin,
  requireAuth,
  requireInternalToken,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  verifyPassword,
  type SessionUser,
} from "../auth.js";
import { clientAddress, consumeRateLimit } from "../security.js";

/** 登录鉴权路由：/api/auth */
const app = new Hono<{ Variables: { user: SessionUser } }>();

const loginSchema = z.object({
  /** 账号（通常是邮箱，也允许 admin 这类短用户名） */
  email: z.string().trim().min(1).max(256),
  password: z.string().min(1).max(1024),
});

const sessionModeSchema = z.enum(["cookie", "bearer"]);

// 生产环境默认要求 HTTPS（Secure Cookie）；试运营无证书时用 SKILLHIVE_ALLOW_HTTP=1 显式放宽
function secureCookie(): boolean {
  return process.env.NODE_ENV === "production" && process.env.SKILLHIVE_ALLOW_HTTP !== "1";
}

function cookieOptions() {
  return {
    httpOnly: true as const,
    secure: secureCookie(),
    sameSite: "Lax" as const,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}

// 用户不存在时仍做一次 scrypt，降低基于响应时间的账号枚举风险。
const dummyPasswordHash = hashPassword("dummy-password-that-is-never-valid");

/** POST /api/auth/login — Console 使用 HttpOnly Cookie；CLI 显式请求 Bearer token。 */
app.post("/login", zValidator("json", loginSchema), async (c) => {
  const { email, password } = c.req.valid("json");
  const normalizedEmail = email.toLowerCase();
  const ipLimit = consumeRateLimit("login-ip", clientAddress(c), 20, 15 * 60_000);
  const accountLimit = consumeRateLimit("login-account", normalizedEmail, 8, 15 * 60_000);
  if (!ipLimit.allowed || !accountLimit.allowed) {
    const retryAfter = Math.max(ipLimit.retryAfterSeconds, accountLimit.retryAfterSeconds);
    c.header("Retry-After", String(retryAfter));
    return c.json({ error: "登录尝试过于频繁，请稍后再试" }, 429);
  }

  const user = await db.query.users.findFirst({ where: eq(users.email, normalizedEmail) });
  const storedHash = user?.passwordHash ?? await dummyPasswordHash;
  const validPassword = await verifyPassword(password, storedHash);
  if (!user?.passwordHash || user.disabledAt !== null || !validPassword) {
    return c.json({ error: "邮箱或密码错误" }, 401);
  }

  const sessionUser = toSessionUser(user);
  const token = await issueToken(sessionUser, user.sessionVersion);
  const requestedMode = c.req.header("X-SkillHive-Session-Mode");
  const parsedMode = sessionModeSchema.safeParse(requestedMode);
  const sessionMode = parsedMode.success ? parsedMode.data : "cookie";
  if (sessionMode === "cookie") {
    setCookie(c, SESSION_COOKIE_NAME, token, cookieOptions());
    // Browser 不接收可被页面脚本读取的 token；会话只存在 HttpOnly Cookie。
    return c.json({ data: { user: sessionUser } });
  }
  // CLI 显式请求 bearer 模式，不设置 Cookie。
  return c.json({ data: { token, user: sessionUser } });
});

app.post("/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE_NAME, {
    path: "/",
    secure: secureCookie(),
    sameSite: "Lax",
  });
  return c.json({ ok: true });
});

/** GET /api/auth/me — 从数据库刷新后的当前用户。 */
app.get("/me", requireAuth, (c) => c.json({ data: c.get("user") }));

// ---------- 个人接入令牌（PAT） ----------

const createTokenSchema = z.object({
  name: z.string().trim().max(128).default(""),
});

/** POST /api/auth/tokens — 生成接入令牌（明文仅此一次返回）。 */
app.post("/tokens", requireAuth, zValidator("json", createTokenSchema), async (c) => {
  const user = c.get("user");
  const rate = consumeRateLimit("create-pat", user.id, 10, 60 * 60_000);
  if (!rate.allowed) {
    c.header("Retry-After", String(rate.retryAfterSeconds));
    return c.json({ error: "创建令牌过于频繁，请稍后再试" }, 429);
  }

  const [active] = await db
    .select({ value: count() })
    .from(userTokens)
    .where(and(eq(userTokens.userId, user.id), isNull(userTokens.revokedAt)));
  if ((active?.value ?? 0) >= 10) {
    return c.json({ error: "每个账号最多保留 10 个有效令牌，请先吊销不再使用的令牌" }, 409);
  }

  const { name } = c.req.valid("json");
  const { token, hash } = generatePat();
  const [row] = await db
    .insert(userTokens)
    .values({ userId: user.id, name, tokenHash: hash })
    .returning({ id: userTokens.id, createdAt: userTokens.createdAt });
  return c.json({ data: { id: row?.id, token, name } }, 201);
});

/** GET /api/auth/tokens — 列出我的令牌（不含明文）。 */
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
  return c.json({ data: rows.map((row) => ({ ...row, revoked: row.revokedAt !== null })) });
});

const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? "http://localhost:3100";

if (process.env.NODE_ENV === "production") {
  try {
    const url = new URL(MCP_SERVER_URL);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
  } catch {
    throw new Error("生产环境 MCP_SERVER_URL 必须是有效的 http(s) URL");
  }
}

function notifyTokenRevoked(tokenId: string): void {
  const internalToken = process.env.SKILLHIVE_INTERNAL_TOKEN?.trim();
  if (!internalToken) return;
  void fetch(`${MCP_SERVER_URL}/internal/token-revoked`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-SkillHive-Internal-Token": internalToken,
    },
    body: JSON.stringify({ tokenId }),
    signal: AbortSignal.timeout(3_000),
  }).then((response) => {
    if (!response.ok) console.warn(`[skillhive] MCP 令牌撤销通知返回 ${response.status}`);
  }).catch((error: unknown) => {
    console.warn("[skillhive] MCP 令牌撤销通知失败：", error instanceof Error ? error.message : error);
  });
}

/** DELETE /api/auth/tokens/:id — 吊销我的令牌（仅本人可操作）。 */
app.delete("/tokens/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  if (!z.string().uuid().safeParse(id).success) return c.json({ error: "无效的令牌 ID" }, 400);
  const [updated] = await db
    .update(userTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(userTokens.id, id), eq(userTokens.userId, user.id), isNull(userTokens.revokedAt)))
    .returning({ id: userTokens.id });
  if (!updated) return c.json({ error: "令牌不存在、已吊销或不属于当前账号" }, 404);
  notifyTokenRevoked(updated.id);
  return c.json({ ok: true });
});

const resolvePatSchema = z.object({ token: z.string().regex(/^sk-[a-f0-9]{48}$/) });

/** POST /api/auth/resolve-pat — MCP Server 专用：校验 PAT 并返回令牌与用户身份。 */
app.post("/resolve-pat", requireInternalToken, zValidator("json", resolvePatSchema), async (c) => {
  const { token } = c.req.valid("json");
  const row = await db.query.userTokens.findFirst({
    where: and(eq(userTokens.tokenHash, hashPat(token)), isNull(userTokens.revokedAt)),
  });
  if (!row) return c.json({ error: "无效或已吊销的接入令牌" }, 401);

  const user = await db.query.users.findFirst({ where: eq(users.id, row.userId) });
  if (!user || user.disabledAt !== null) return c.json({ error: "令牌所属账号不存在或已停用" }, 401);

  void db.update(userTokens).set({ lastUsedAt: new Date() }).where(eq(userTokens.id, row.id)).catch(() => {});
  return c.json({ data: { ...toSessionUser(user), tokenId: row.id } });
});

const validatePatSessionSchema = z.object({
  tokenId: z.string().uuid(),
  userId: z.string().uuid(),
});

/** POST /api/auth/validate-pat-session — 长连接每次消息前确认令牌仍有效。 */
app.post(
  "/validate-pat-session",
  requireInternalToken,
  zValidator("json", validatePatSessionSchema),
  async (c) => {
    const { tokenId, userId } = c.req.valid("json");
    const token = await db.query.userTokens.findFirst({
      where: and(
        eq(userTokens.id, tokenId),
        eq(userTokens.userId, userId),
        isNull(userTokens.revokedAt),
      ),
    });
    if (!token) return c.json({ error: "接入令牌已失效" }, 401);
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user || user.disabledAt !== null) return c.json({ error: "令牌所属账号不存在或已停用" }, 401);
    return c.json({ data: { valid: true, user: toSessionUser(user) } });
  },
);

const accountStatusSchema = z.object({
  disabled: z.boolean(),
});

/** PATCH /api/auth/users/:id/status — 管理员停用/启用账号，停用会撤销所有会话与 PAT。 */
app.patch(
  "/users/:id/status",
  requireAdmin,
  zValidator("json", accountStatusSchema),
  async (c) => {
    const actor = c.get("user");
    const userId = c.req.param("id");
    if (!z.string().uuid().safeParse(userId).success) return c.json({ error: "无效的用户 ID" }, 400);
    const { disabled } = c.req.valid("json");
    if (disabled && userId === actor.id) {
      return c.json({ error: "不能停用当前登录的管理员账号" }, 409);
    }
    const rate = consumeRateLimit("account-status", actor.id, 30, 60 * 60_000);
    if (!rate.allowed) {
      c.header("Retry-After", String(rate.retryAfterSeconds));
      return c.json({ error: "账号状态操作过于频繁" }, 429);
    }

    const result = await db.transaction(async (tx) => {
      // 串行同一账号状态更新，避免停用/启用并发产生不确定结果。
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`user-status:${userId}`}, 0))`);
      const target = await tx.query.users.findFirst({ where: eq(users.id, userId) });
      if (!target) return null;
      const disabledAt = disabled ? target.disabledAt ?? new Date() : null;
      const statusChanged = (target.disabledAt !== null) !== disabled;
      const [updated] = await tx
        .update(users)
        .set({
          disabledAt,
          // 状态切换一律失效现有 Cookie/Bearer，避免启用后旧会话复活。
          sessionVersion: statusChanged
            ? sql`${users.sessionVersion} + 1`
            : target.sessionVersion,
        })
        .where(eq(users.id, userId))
        .returning({ id: users.id, disabledAt: users.disabledAt });
      const revoked = disabled
        ? await tx
            .update(userTokens)
            .set({ revokedAt: new Date() })
            .where(and(eq(userTokens.userId, userId), isNull(userTokens.revokedAt)))
            .returning({ id: userTokens.id })
        : [];
      return { updated, revoked };
    });
    if (!result?.updated) return c.json({ error: "账号不存在" }, 404);
    for (const token of result.revoked) notifyTokenRevoked(token.id);
    return c.json({
      data: {
        id: result.updated.id,
        disabled: result.updated.disabledAt !== null,
        revokedTokens: result.revoked.length,
      },
    });
  },
);

function toSessionUser(user: typeof users.$inferSelect): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    departmentId: user.departmentId,
  };
}

export default app;
