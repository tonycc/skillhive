import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { McpServer, RegisteredPrompt } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer, refreshSkillPrompts, type CallerIdentity } from "./server.js";
import { getInternalToken, resolvePat, validatePatSession } from "./registry.js";
import { parsePublicMcpUrl } from "./public-url.js";
import { createKeyedRateLimiter, type RateLimitResult } from "./request-rate-limit.js";

const INTERNAL_TOKEN = getInternalToken();
const AUTH_HINT =
  "缺少或无效的员工接入令牌：请联系公司 SkillHive 管理员领取或补发，并为 MCP 请求配置 Authorization: Bearer <令牌>";
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
const MAX_REQUESTS_PER_TOKEN = boundedInteger(
  process.env.MCP_MAX_REQUESTS_PER_TOKEN,
  240,
  60,
  10_000,
);
const MAX_PREAUTH_REQUESTS_PER_IP = boundedInteger(
  process.env.MCP_MAX_PREAUTH_REQUESTS_PER_IP,
  10_000,
  1_000,
  100_000,
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

// 前置 IP 限制只挡异常洪泛；无效凭证另计数，认证成功后按令牌隔离正常业务额度。
const preAuthRateLimit = createKeyedRateLimiter(60_000, MAX_PREAUTH_REQUESTS_PER_IP);
const invalidAuthRateLimit = createKeyedRateLimiter(60_000, 60);
const authenticatedRateLimit = createKeyedRateLimiter(60_000, MAX_REQUESTS_PER_TOKEN);
const internalRateLimit = createKeyedRateLimiter(60_000, 120);

function requestAddress(req: express.Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function rejectRateLimited(res: express.Response, rate: RateLimitResult): void {
  res.setHeader("RateLimit-Limit", String(rate.limit));
  res.setHeader("RateLimit-Remaining", String(rate.remaining));
  res.setHeader("Retry-After", String(rate.retryAfterSeconds));
  res.status(429).json({ error: "请求过于频繁，请稍后重试" });
}

function setRateHeaders(res: express.Response, rate: RateLimitResult): void {
  res.setHeader("RateLimit-Limit", String(rate.limit));
  res.setHeader("RateLimit-Remaining", String(rate.remaining));
}

async function resolveRateLimitedCaller(
  req: express.Request,
  res: express.Response,
): Promise<CallerIdentity | null> {
  const address = requestAddress(req);
  const preAuthRate = preAuthRateLimit.consume(address);
  if (!preAuthRate.allowed) {
    rejectRateLimited(res, preAuthRate);
    return null;
  }
  const caller = await resolveCaller(req);
  if (!caller) {
    const invalidRate = invalidAuthRateLimit.consume(address);
    if (!invalidRate.allowed) rejectRateLimited(res, invalidRate);
    else {
      setRateHeaders(res, invalidRate);
      res.status(401).json({ error: AUTH_HINT });
    }
    return null;
  }
  const authenticatedRate = authenticatedRateLimit.consume(caller.tokenId);
  if (!authenticatedRate.allowed) {
    rejectRateLimited(res, authenticatedRate);
    return null;
  }
  setRateHeaders(res, authenticatedRate);
  return caller;
}

function limitInternalRequest(req: express.Request, res: express.Response): boolean {
  const rate = internalRateLimit.consume(requestAddress(req));
  if (!rate.allowed) {
    rejectRateLimited(res, rate);
    return false;
  }
  setRateHeaders(res, rate);
  return true;
}

// ---------- 新版 Streamable HTTP（无状态，每个请求重新校验 PAT） ----------

app.all("/mcp", async (req, res, next) => {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      res.status(405).json({ error: "该 MCP 端点仅接受 POST 请求" });
      return;
    }
    const caller = await resolveRateLimitedCaller(req, res);
    if (!caller) return;
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

app.get("/sse", async (req, res, next) => {
  try {
    const caller = await resolveRateLimitedCaller(req, res);
    if (!caller) return;
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

app.post("/messages", async (req, res, next) => {
  try {
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "";
    const session = sseSessions.get(sessionId);
    if (!session) {
      res.status(404).json({ error: "MCP 会话不存在或已失效，请重新连接" });
      return;
    }
    const caller = await resolveRateLimitedCaller(req, res);
    if (!caller) return;
    if (
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

app.post("/internal/prompts-changed", async (req, res) => {
  if (!limitInternalRequest(req, res)) return;
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

app.post("/internal/token-revoked", async (req, res) => {
  if (!limitInternalRequest(req, res)) return;
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
