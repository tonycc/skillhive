import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { db, users } from "@skillhive/db";
import { issueToken, requireAuth, verifyPassword, type SessionUser } from "../auth.js";

/** 登录鉴权路由：/api/auth */
const app = new Hono<{ Variables: { user: SessionUser } }>();

const loginSchema = z.object({
  email: z.string().email(),
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

export default app;
