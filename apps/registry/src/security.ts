import { createHash } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
let operations = 0;

function compactBuckets(now: number): void {
  // 避免攻击者通过随机 key 令开发期的内存限流表无限增长。
  if (++operations % 256 !== 0 && buckets.size < 10_000) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  if (buckets.size > 20_000) {
    const excess = buckets.size - 20_000;
    let deleted = 0;
    for (const key of buckets.keys()) {
      buckets.delete(key);
      if (++deleted >= excess) break;
    }
  }
}

export function consumeRateLimit(
  namespace: string,
  identity: string,
  limit: number,
  windowMs: number,
): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  compactBuckets(now);
  // 不将邮箱、用户 ID 等原值保留在进程内存 key 中。
  const digest = createHash("sha256").update(identity).digest("hex");
  const key = `${namespace}:${digest}`;
  const existing = buckets.get(key);
  const bucket = !existing || existing.resetAt <= now
    ? { count: 0, resetAt: now + windowMs }
    : existing;
  bucket.count += 1;
  buckets.set(key, bucket);
  return {
    allowed: bucket.count <= limit,
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

export function clientAddress(c: Context): string {
  // 只有显式声明存在受信反向代理时才采用可伪造的转发头。
  if (process.env.TRUST_PROXY === "1") {
    return c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
      || c.req.header("x-real-ip")
      || "unknown";
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Cookie 会话的写请求校验同源 Origin；Bearer / 内部服务调用不受影响。 */
export const requireSameOriginForCookieWrites: MiddlewareHandler = async (c, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
  if (c.req.header("Authorization")?.startsWith("Bearer ")) return next();
  if (c.req.header("X-SkillHive-Internal-Token")) return next();

  const cookieHeader = c.req.header("Cookie") ?? "";
  const usesSessionCookie = cookieHeader
    .split(";")
    .some((part) => part.trim().startsWith("skillhive_session="));
  if (!usesSessionCookie) return next();

  // Cookie 鉴权写请求必须有 Origin；非浏览器 CLI 应使用 Bearer。
  const origin = c.req.header("Origin");
  if (!origin) return c.json({ error: "Cookie 写请求缺少 Origin" }, 403);
  try {
    const expectedHost = c.req.header("x-forwarded-host") ?? c.req.header("host");
    const expectedProto = c.req.header("x-forwarded-proto")
      ?? (process.env.NODE_ENV === "production" ? "https" : "http");
    const parsedOrigin = new URL(origin);
    if (
      !expectedHost
      || parsedOrigin.host !== expectedHost
      || parsedOrigin.protocol !== `${expectedProto}:`
    ) {
      return c.json({ error: "拒绝跨站写请求" }, 403);
    }
  } catch {
    return c.json({ error: "无效的 Origin 请求头" }, 403);
  }
  return next();
};
