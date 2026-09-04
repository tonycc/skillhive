import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull, sql } from "drizzle-orm";
import { deleteCookie, setCookie } from "hono/cookie";
import { db, employees, employeeTokens, explorationAuditEvents, users, userTokens } from "@skillhive/db";
import {
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
  const requestedMode = c.req.header("X-SkillHive-Session-Mode");
  const parsedMode = sessionModeSchema.safeParse(requestedMode);
  const sessionMode = parsedMode.success ? parsedMode.data : "cookie";
  if (sessionMode === "cookie" && user.role !== "admin") {
    return c.json({ error: "SkillHive Web 仅供管理员使用" }, 403);
  }
  const token = await issueToken(sessionUser, user.sessionVersion, sessionMode);
  if (sessionMode === "cookie") {
    await db.insert(explorationAuditEvents).values({
      actorType: "admin",
      actorId: user.id,
      action: "admin.login",
      metadata: {},
    });
    // 先完成审计再下发 Cookie；审计失败时不得留下客户端已登录、服务端无记录的状态。
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

const resolvePatSchema = z.object({ token: z.string().regex(/^sk-[a-f0-9]{48}$/) });

/** POST /api/auth/resolve-pat — MCP Server 专用：只解析员工连接器令牌。 */
app.post("/resolve-pat", requireInternalToken, zValidator("json", resolvePatSchema), async (c) => {
  const { token } = c.req.valid("json");
  const tokenHash = hashPat(token);
  const [employeeRow] = await db.select({
    id: employees.id,
    phone: employees.phone,
    email: employees.email,
    name: employees.name,
    departmentId: employees.departmentId,
    tokenId: employeeTokens.id,
    scopes: employeeTokens.scopes,
    expiresAt: employeeTokens.expiresAt,
  }).from(employeeTokens).innerJoin(employees, eq(employeeTokens.employeeId, employees.id)).where(and(
    eq(employeeTokens.tokenHash, tokenHash),
    isNull(employeeTokens.revokedAt),
    eq(employees.status, "active"),
    sql`${employeeTokens.expiresAt} > now()`,
  )).limit(1);
  if (employeeRow) {
    void db.update(employeeTokens).set({ lastUsedAt: new Date() })
      .where(eq(employeeTokens.id, employeeRow.tokenId)).catch(() => {});
    return c.json({ data: {
      subjectType: "employee",
      ...employeeRow,
      role: "employee",
    } });
  }

  return c.json({ error: "员工接入令牌无效、已吊销或已停用" }, 401);
});

const validatePatSessionSchema = z.object({
  tokenId: z.string().uuid(),
  subjectId: z.string().uuid(),
  subjectType: z.literal("employee"),
});

/** POST /api/auth/validate-pat-session — 长连接每次消息前确认令牌仍有效。 */
app.post(
  "/validate-pat-session",
  requireInternalToken,
  zValidator("json", validatePatSessionSchema),
  async (c) => {
    const { tokenId, subjectId } = c.req.valid("json");
    const [row] = await db.select({ id: employees.id }).from(employeeTokens)
      .innerJoin(employees, eq(employeeTokens.employeeId, employees.id))
      .where(and(
        eq(employeeTokens.id, tokenId), eq(employeeTokens.employeeId, subjectId),
        isNull(employeeTokens.revokedAt), eq(employees.status, "active"),
        sql`${employeeTokens.expiresAt} > now()`,
      )).limit(1);
    if (!row) return c.json({ error: "员工接入令牌已失效" }, 401);
    return c.json({ data: { valid: true } });
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
      // 旧个人 PAT 已不能用于 MCP；保留停用账号时的数据库失效处理，避免历史凭据复活。
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
