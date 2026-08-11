import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

/**
 * stdio 传输入口 —— 本地开发 / 桌面 Agent 客户端（Claude Code 等）使用。
 * 对接 WorkBuddy 请使用 http.ts（Streamable HTTP 传输）。
 */
const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("SkillHive MCP Server 已通过 stdio 启动");
