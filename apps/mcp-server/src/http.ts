import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createServer } from "./server.js";

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
  const server = await createServer();
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

const sseTransports = new Map<string, SSEServerTransport>();

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  sseTransports.set(transport.sessionId, transport);

  res.on("close", () => {
    sseTransports.delete(transport.sessionId);
  });

  const server = await createServer();
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId as string;
  const transport = sseTransports.get(sessionId);
  if (!transport) {
    res.status(400).json({ error: `未知 sessionId: ${sessionId}（连接可能已断开）` });
    return;
  }
  await transport.handlePostMessage(req, res, req.body);
});

const port = Number(process.env.MCP_PORT ?? 3100);
app.listen(port, () => {
  console.log(`SkillHive MCP Server 已启动：`);
  console.log(`  - Streamable HTTP: http://localhost:${port}/mcp`);
  console.log(`  - SSE:             http://localhost:${port}/sse`);
});
