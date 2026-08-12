import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import type { McpServer, RegisteredPrompt } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer, refreshSkillPrompts } from "./server.js";

/**
 * 远程传输入口（对接 WorkBuddy 等 MCP 客户端），同时暴露两种协议：
 *
 * - POST /mcp        —— 新版 Streamable HTTP（无状态）
 * - GET  /sse        —— 经典 SSE 传输（WorkBuddy 文档示例使用此模式）
 *   POST /messages     （SSE 模式的消息回传端点，由客户端按 endpoint 事件回调）
 *
 * POC 阶段：鉴权未实现。正式版需校验 Authorization: Bearer <token>，
 * 并按 token 对应的用户身份过滤可见 skill。
 */
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "skillhive-mcp",
    transports: ["streamable-http:/mcp", "sse:/sse"],
  });
});

// ---------- 新版 Streamable HTTP（无状态） ----------

app.all("/mcp", async (req, res) => {
  const { server } = await createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// ---------- 经典 SSE 传输（有状态，按 sessionId 管理连接） ----------

/** 活跃 SSE 会话：transport + server 实例 + 已注册 skill prompt 句柄 */
interface SseSession {
  transport: SSEServerTransport;
  server: McpServer;
  skillPrompts: Map<string, RegisteredPrompt>;
}

const sseSessions = new Map<string, SseSession>();

app.get("/sse", async (_req, res) => {
  const { server, skillPrompts } = await createServer();
  const transport = new SSEServerTransport("/messages", res);
  sseSessions.set(transport.sessionId, { transport, server, skillPrompts });

  res.on("close", () => {
    sseSessions.delete(transport.sessionId);
    void server.close();
  });

  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const session = sseSessions.get(sessionId);
  if (!session) {
    res.status(400).json({ error: `未知 sessionId: ${sessionId}（连接可能已断开）` });
    return;
  }
  await session.transport.handlePostMessage(req, res, req.body);
});

// ---------- 内部接口（服务间调用，不对客户端开放） ----------

/** 内部接口共享密钥：Registry 调用时携带；未配置 = 开发模式放行（启动时告警） */
const INTERNAL_TOKEN = process.env.SKILLHIVE_INTERNAL_TOKEN;
if (!INTERNAL_TOKEN) {
  console.warn(
    "[skillhive] ⚠️ 未配置 SKILLHIVE_INTERNAL_TOKEN，/internal/* 接口处于无鉴权开发模式（正式部署必须配置）",
  );
}

/**
 * POST /internal/prompts-changed —— Registry 发布/下架 skill 后调用。
 * 对所有活跃 SSE 会话增量刷新 prompt 注册表，SDK 会自动向客户端推送
 * notifications/prompts/list_changed，客户端无需断线重连即可看到最新快捷指令。
 * 需携带 X-SkillHive-Internal-Token 头（与 SKILLHIVE_INTERNAL_TOKEN 一致）。
 */
app.post("/internal/prompts-changed", async (req, res) => {
  if (INTERNAL_TOKEN && req.headers["x-skillhive-internal-token"] !== INTERNAL_TOKEN) {
    res.status(401).json({ error: "未授权的内部调用（缺少或错误的内部令牌）" });
    return;
  }
  let refreshed = 0;
  let failed = 0;
  for (const session of sseSessions.values()) {
    try {
      await refreshSkillPrompts(session.server, session.skillPrompts);
      refreshed++;
    } catch (err) {
      failed++;
      console.error("[skillhive] 刷新会话 prompts 失败：", err);
    }
  }
  res.json({ ok: true, sessions: sseSessions.size, refreshed, failed });
});

const port = Number(process.env.MCP_PORT ?? 3100);
app.listen(port, () => {
  console.log(`SkillHive MCP Server 已启动：`);
  console.log(`  - Streamable HTTP: http://localhost:${port}/mcp`);
  console.log(`  - SSE:             http://localhost:${port}/sse`);
});
