import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";
import { eq } from "drizzle-orm";
import { db, users } from "@skillhive/db";

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
  departmentId: string | null;
}

export const SESSION_COOKIE_NAME = "skillhive_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 3600;

function loadSessionSecret(): string {
  const configured = process.env.SKILLHIVE_SESSION_SECRET?.trim();
  if (configured && configured.length >= 32) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("生产环境必须配置至少 32 个字符的 SKILLHIVE_SESSION_SECRET");
  }
  const generated = randomBytes(32).toString("hex");
  console.warn(
    configured
      ? "[skillhive] SKILLHIVE_SESSION_SECRET 少于 32 个字符，开发环境已改用临时密钥"
      : "[skillhive] 未配置 SKILLHIVE_SESSION_SECRET，开发环境已生成临时密钥（重启后登录态失效）",
  );
  return generated;
}

const SESSION_SECRET = loadSessionSecret();

/** 为用户签发会话令牌；sessionVersion 变更会使旧令牌立即失效。 */
export async function issueToken(user: SessionUser, sessionVersion: number): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    {
      sub: user.id,
      ver: sessionVersion,
      iat: now,
      exp: now + SESSION_TTL_SECONDS,
    },
    SESSION_SECRET,
  );
}

/** 从 Bearer 或 HttpOnly Cookie 解析会话，并从数据库刷新角色、部门与有效状态。 */
export async function resolveSession(c: Context): Promise<SessionUser | null> {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ")
    ? header.slice("Bearer ".length).trim()
    : getCookie(c, SESSION_COOKIE_NAME) ?? "";
  if (!token) return null;

  try {
    const payload = await verify(token, SESSION_SECRET, "HS256");
    if (typeof payload.sub !== "string" || typeof payload.ver !== "number") return null;
    const user = await db.query.users.findFirst({ where: eq(users.id, payload.sub) });
    if (!user || user.disabledAt !== null || user.sessionVersion !== payload.ver) return null;
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      departmentId: user.departmentId,
    };
  } catch {
    return null;
  }
}

/** 要求已登录（任意角色），会话用户写入 c.set("user")。 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const user = await resolveSession(c);
  if (!user) return c.json({ error: "未登录或登录已过期（请先登录）" }, 401);
  c.set("user", user);
  return next();
};

/** 要求 publisher 或 admin 角色（发布/管理接口）。 */
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

/** 要求 admin 角色（账号与系统管理接口）。 */
export const requireAdmin: MiddlewareHandler = async (c, next) => {
  const user = await resolveSession(c);
  if (!user) return c.json({ error: "未登录或登录已过期（请先登录）" }, 401);
  if (user.role !== "admin") return c.json({ error: "无管理员权限" }, 403);
  c.set("user", user);
  return next();
};

// ---------- 个人接入令牌（PAT，供 MCP 客户端鉴权） ----------

/** PAT 明文格式：sk- + 48 位 hex（高熵随机值，sha256 哈希存储即可）。 */
export function generatePat(): { token: string; hash: string } {
  const token = `sk-${randomBytes(24).toString("hex")}`;
  return { token, hash: hashPat(token) };
}

export function hashPat(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ---------- 服务间内部接口鉴权 ----------

function configuredInternalToken(): string | null {
  const value = process.env.SKILLHIVE_INTERNAL_TOKEN?.trim();
  return value && value.length >= 32 ? value : null;
}

if (process.env.NODE_ENV === "production" && !configuredInternalToken()) {
  throw new Error("生产环境必须配置至少 32 个字符的 SKILLHIVE_INTERNAL_TOKEN");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

/** 内部接口恒为 fail-closed；未配置有效共享密钥时不会放行。 */
export const requireInternalToken: MiddlewareHandler = async (c, next) => {
  const expected = configuredInternalToken();
  const supplied = c.req.header("X-SkillHive-Internal-Token") ?? "";
  if (!expected || !supplied || !constantTimeEqual(supplied, expected)) {
    return c.json({ error: "未授权的内部调用（内部令牌未配置或不匹配）" }, 401);
  }
  return next();
};
