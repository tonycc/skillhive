import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { getInternalToken, resolvePat } from "./registry.js";
import { bindPatValidation } from "./authenticated-transport.js";

/**
 * stdio 传输入口 —— 本地开发 / 桌面 Agent 客户端（Claude Code 等）使用。
 * 对接 WorkBuddy 请使用 http.ts（Streamable HTTP 传输）。
 */
getInternalToken();
const token = process.env.SKILLHIVE_PAT?.trim();
if (!token) {
  throw new Error("stdio 模式需要通过 SKILLHIVE_PAT 提供员工连接器令牌");
}
const caller = await resolvePat(token);
if (!caller) throw new Error("SKILLHIVE_PAT 无效或已撤销");
const { server } = await createServer(caller);
const transport = bindPatValidation(new StdioServerTransport(), caller);
await server.connect(transport);
console.error("SkillHive MCP Server 已通过 stdio 启动");
