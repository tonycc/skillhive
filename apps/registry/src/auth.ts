import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Context, MiddlewareHandler } from "hono";
import { sign, verify } from "hono/jwt";

/**
 * 登录鉴权模块。
 *
 * - 账号：users 表（email + scrypt 密码哈希 + 角色）
 * - 会话：JWT（HS256，7 天有效期），密钥取 SKILLHIVE_SESSION_SECRET；
 *   未配置时每次启动随机生成（重启即全部会话失效），正式部署必须配置
 * - 保护范围：发布/管理接口要求 publisher 或 admin 角色；
 *   读取路径（市场浏览、sync、MCP）保持公开
 */

const scryptAsync = promisify(scrypt);

// ---------- 密码哈希 ----------

/** 生成 scrypt 密码哈希，存储格式：scrypt:salt:hash（base64） */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt:${salt.toString("base64")}:${derived.toString("base64")}`;
}

/** 校验密码与存储的哈希是否匹配 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split(":");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

// ---------- 会话（JWT） ----------

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "publisher" | "member";
}

const SESSION_TTL_SECONDS = 7 * 24 * 3600; // 7 天

const SESSION_SECRET =
  process.env.SKILLHIVE_SESSION_SECRET ??
  (() => {
    const generated = randomBytes(32).toString("hex");
    console.warn(
      "[skillhive] ⚠️ 未配置 SKILLHIVE_SESSION_SECRET，已生成临时密钥（重启后所有登录态失效，正式部署必须配置）",
    );
    return generated;
  })();

/** 为用户签发会话令牌 */
export async function issueToken(user: SessionUser): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    {
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      iat: now,
      exp: now + SESSION_TTL_SECONDS,
    },
    SESSION_SECRET,
  );
}

/** 从请求头解析并校验会话令牌，无效返回 null */
async function resolveSession(c: Context): Promise<SessionUser | null> {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!token) return null;
  try {
    const payload = await verify(token, SESSION_SECRET, "HS256");
    if (typeof payload.sub !== "string") return null;
    return {
      id: payload.sub,
      email: String(payload.email ?? ""),
      name: String(payload.name ?? ""),
      role: payload.role as SessionUser["role"],
    };
  } catch {
    return null;
  }
}

/** 要求已登录（任意角色），会话用户写入 c.set("user") */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const user = await resolveSession(c);
  if (!user) {
    return c.json({ error: "未登录或登录已过期（请先登录）" }, 401);
  }
  c.set("user", user);
  return next();
};

/** 要求 publisher 或 admin 角色（发布/管理接口） */
export const requirePublisher: MiddlewareHandler = async (c, next) => {
  const user = await resolveSession(c);
  if (!user) {
    return c.json({ error: "未登录或登录已过期（CLI 请执行 skillhive login）" }, 401);
  }
  if (user.role !== "publisher" && user.role !== "admin") {
    return c.json({ error: "无发布权限（需要 publisher 或 admin 角色）" }, 403);
  }
  c.set("user", user);
  return next();
};
