import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { McpServer, RegisteredPrompt } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer, refreshSkillPrompts, type CallerIdentity } from "./server.js";
import { getInternalToken, resolvePat, validatePatSession } from "./registry.js";
import { parsePublicMcpUrl } from "./public-url.js";

const INTERNAL_TOKEN = getInternalToken();
const AUTH_HINT =
  "缺少或无效的接入令牌：请在 SkillHive Console「接入设置」生成令牌，并为 MCP 请求配置 Authorization: Bearer <令牌>";
const PUBLIC_MCP_URL = process.env.PUBLIC_MCP_URL?.trim();
const FORCE_HTTPS = process.env.NODE_ENV === "production" && process.env.SKILLHIVE_ALLOW_HTTP !== "1";
const { messagesPath: publicMessagesPath } = parsePublicMcpUrl(
  PUBLIC_MCP_URL,
  process.env.NODE_ENV === "production",
);
const MAX_SSE_SESSIONS = boundedInteger(process.env.MCP_MAX_SSE_SESSIONS, 100, 1, 1_000);
const MAX_SSE_SESSIONS_PER_USER = boundedInteger(
  process.env.MCP_MAX_SSE_SESSIONS_PER_USER,
  5,
  1,
  50,
);
const SSE_MAX_AGE_MS = boundedInteger(
  process.env.MCP_SSE_MAX_AGE_MS,
  8 * 60 * 60 * 1_000,
  60_000,
  24 * 60 * 60 * 1_000,
);

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function safeEqual(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualDigest = createHash("sha256").update(actual).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function isInternalRequest(req: express.Request): boolean {
  return safeEqual(req.get("X-SkillHive-Internal-Token"), INTERNAL_TOKEN);
}

function extractBearer(req: express.Request): string | null {
  const header = req.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{32,512})$/.exec(header);
  return match?.[1] ?? null;
}

async function resolveCaller(req: express.Request): Promise<CallerIdentity | null> {
  const token = extractBearer(req);
  return token ? resolvePat(token) : null;
}

/** 有界的内存限流器，限制对 PAT 解析端点的暴力请求；生产多副本可在网关再加全局限流。 */
function createRateLimiter(windowMs: number, max: number) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const now = Date.now();
    let key = req.ip || req.socket.remoteAddress || "unknown";
    if (buckets.size >= 10_000 && !buckets.has(key)) {
      for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
      if (buckets.size >= 10_000) key = "__overflow__";
    }
    const current = buckets.get(key);
    const bucket = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
    bucket.count += 1;
    buckets.set(key, bucket);
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, max - bucket.count)));
    if (bucket.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1_000)));
      res.status(429).json({ error: "请求过于频繁，请稍后重试" });
      return;
    }
    next();
  };
}

const app = express();
app.disable("x-powered-by");
if (process.env.TRUST_PROXY === "1") app.set("trust proxy", 1);
app.use(express.json({ limit: "256kb", strict: true }));

app.use((req, res, next) => {
  if (!FORCE_HTTPS || req.path === "/health" || req.path.startsWith("/internal/")) {
    next();
    return;
  }
  const isSecure = req.secure;
  if (!isSecure) {
    res.status(426).json({ error: "生产环境 MCP 仅接受 HTTPS，请通过受信 TLS 反向代理访问" });
    return;
  }
  next();
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "skillhive-mcp",
    transports: ["streamable-http:/mcp", "sse:/sse"],
  });
});

const authRateLimit = createRateLimiter(60_000, 60);
const internalRateLimit = createRateLimiter(60_000, 120);

// ---------- 新版 Streamable HTTP（无状态，每个请求重新校验 PAT） ----------

app.all("/mcp", authRateLimit, async (req, res, next) => {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      res.status(405).json({ error: "该 MCP 端点仅接受 POST 请求" });
      return;
    }
    const caller = await resolveCaller(req);
    if (!caller) {
      res.status(401).json({ error: AUTH_HINT });
      return;
    }
    const { server } = await createServer(caller);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    next(error);
  }
});

// ---------- 经典 SSE 传输（有状态，按 sessionId 管理连接） ----------

interface SseSession {
  transport: SSEServerTransport;
  server: McpServer;
  skillPrompts: Map<string, RegisteredPrompt>;
  caller: CallerIdentity;
  createdAt: number;
  lastActivityAt: number;
}

const sseSessions = new Map<string, SseSession>();
let pendingSseSessions = 0;
const pendingSseSessionsByUser = new Map<string, number>();

async function closeSseSession(sessionId: string): Promise<void> {
  const session = sseSessions.get(sessionId);
  if (!session) return;
  sseSessions.delete(sessionId);
  await Promise.allSettled([session.transport.close(), session.server.close()]);
}

app.get("/sse", authRateLimit, async (req, res, next) => {
  try {
    const caller = await resolveCaller(req);
    if (!caller) {
      res.status(401).json({ error: AUTH_HINT });
      return;
    }
    if (sseSessions.size + pendingSseSessions >= MAX_SSE_SESSIONS) {
      res.status(503).json({ error: "当前 MCP 会话已满，请稍后重试" });
      return;
    }
    const userSessions = [...sseSessions.values()].filter(
      (session) => session.caller.id === caller.id,
    ).length + (pendingSseSessionsByUser.get(caller.id) ?? 0);
    if (userSessions >= MAX_SSE_SESSIONS_PER_USER) {
      res.status(429).json({ error: "该账号的 MCP 会话数已达上限" });
      return;
    }

    pendingSseSessions += 1;
    pendingSseSessionsByUser.set(caller.id, (pendingSseSessionsByUser.get(caller.id) ?? 0) + 1);
    let created: Awaited<ReturnType<typeof createServer>>;
    try {
      created = await createServer(caller);
    } finally {
      pendingSseSessions -= 1;
      const userPending = (pendingSseSessionsByUser.get(caller.id) ?? 1) - 1;
      if (userPending === 0) pendingSseSessionsByUser.delete(caller.id);
      else pendingSseSessionsByUser.set(caller.id, userPending);
    }
    const { server, skillPrompts } = created;
    const transport = new SSEServerTransport(publicMessagesPath, res);
    const now = Date.now();
    sseSessions.set(transport.sessionId, {
      transport,
      server,
      skillPrompts,
      caller,
      createdAt: now,
      lastActivityAt: now,
    });

    res.on("close", () => void closeSseSession(transport.sessionId));
    await server.connect(transport);
  } catch (error) {
    next(error);
  }
});

app.post("/messages", authRateLimit, async (req, res, next) => {
  try {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "";
    const session = sseSessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: "MCP 会话不存在或已失效，请重新连接" });
      return;
    }
    const caller = await resolveCaller(req);
    if (
      !caller ||
      caller.id !== session.caller.id ||
      !safeEqual(caller.tokenId, session.caller.tokenId)
    ) {
      res.status(401).json({ error: AUTH_HINT });
      return;
    }
    if (!(await validatePatSession(session.caller))) {
      await closeSseSession(sessionId);
      res.status(401).json({ error: "接入令牌已失效，请重新连接" });
      return;
    }
    session.lastActivityAt = Date.now();
    await session.transport.handlePostMessage(req, res, req.body);
  } catch (error) {
    next(error);
  }
});

// ---------- 内部接口（服务间调用，不对客户端开放） ----------

app.post("/internal/prompts-changed", internalRateLimit, async (req, res) => {
  if (!isInternalRequest(req)) {
    res.status(401).json({ error: "未授权的内部调用" });
    return;
  }
  let refreshed = 0;
  let closed = 0;
  let failed = 0;
  await Promise.all(
    [...sseSessions].map(async ([sessionId, session]) => {
      try {
        if (!(await validatePatSession(session.caller))) {
          await closeSseSession(sessionId);
          closed += 1;
          return;
        }
        await refreshSkillPrompts(session.server, session.skillPrompts, session.caller);
        refreshed += 1;
      } catch {
        failed += 1;
      }
    }),
  );
  res.json({ ok: true, sessions: sseSessions.size, refreshed, closed, failed });
});

app.post("/internal/token-revoked", internalRateLimit, async (req, res) => {
  if (!isInternalRequest(req)) {
    res.status(401).json({ error: "未授权的内部调用" });
    return;
  }
  const tokenId = typeof req.body?.tokenId === "string" ? req.body.tokenId : "";
  if (!/^[0-9a-f-]{36}$/i.test(tokenId)) {
    res.status(400).json({ error: "请求参数无效" });
    return;
  }
  const targets = [...sseSessions]
    .filter(([, session]) => session.caller.tokenId === tokenId)
    .map(([sessionId]) => sessionId);
  const results = await Promise.allSettled(targets.map(closeSseSession));
  const closed = results.filter((result) => result.status === "fulfilled").length;
  res.json({ ok: true, closed });
});

app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const status =
      typeof error === "object" && error !== null && "status" in error
        ? Number(error.status)
        : 500;
    if (!res.headersSent && (status === 400 || status === 413 || status === 415)) {
      res.status(status).json({
        error: status === 413 ? "请求体超过大小上限" : "请求格式无效",
      });
      return;
    }
    console.error(
      "[skillhive] MCP 请求失败：",
      error instanceof Error ? error.message : "未知错误",
    );
    if (!res.headersSent) res.status(500).json({ error: "MCP 服务暂时不可用" });
  },
);

const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - SSE_MAX_AGE_MS;
  for (const [sessionId, session] of sseSessions) {
    if (session.createdAt <= cutoff || session.lastActivityAt <= cutoff) {
      void closeSseSession(sessionId);
    }
  }
}, Math.min(5 * 60_000, SSE_MAX_AGE_MS));
cleanupTimer.unref();

const port = boundedInteger(process.env.MCP_PORT, 3_100, 1, 65_535);
const host = process.env.MCP_HOST ?? "0.0.0.0";
const httpServer = createHttpServer({ maxHeaderSize: 16 * 1_024 }, app);
httpServer.headersTimeout = 15_000;
httpServer.requestTimeout = 30_000;
httpServer.keepAliveTimeout = 5_000;
httpServer.listen(port, host, () => {
  console.log(`SkillHive MCP Server 已启动：http://${host}:${port}/mcp（SSE: /sse）`);
});
