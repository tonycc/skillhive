import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./server.js";

/**
 * Streamable HTTP 传输入口 —— 对接 WorkBuddy 等云端 MCP 客户端使用。
 *
 * POC 阶段说明：
 * - 无状态模式（sessionIdGenerator: undefined），每次请求独立，最简化部署
 * - 鉴权未实现：正式版需加 Token/OAuth 校验 + 按部门过滤 skill
 */
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "skillhive-mcp", transport: "streamable-http" });
});

app.all("/mcp", async (req, res) => {
  // 无状态模式：每个请求创建一个临时 server + transport
  const server = createServer();
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

const port = Number(process.env.MCP_PORT ?? 3100);
app.listen(port, () => {
  console.log(`SkillHive MCP Server (Streamable HTTP) 已启动: http://localhost:${port}/mcp`);
});
