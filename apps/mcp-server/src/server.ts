import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const REGISTRY_URL = process.env.SKILLHIVE_REGISTRY_URL ?? "http://localhost:3001";

/** 创建并注册全部工具的 MCP Server 实例（stdio / http 两种传输共用） */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "skillhive",
    version: "0.1.0",
  });

  /** 搜索 skill */
  server.tool(
    "search_skills",
    "按关键词搜索企业内可用的 AI skill",
    { query: z.string().describe("搜索关键词，如：周报、邮件、翻译") },
    async ({ query }) => {
      // TODO: 改为调用带语义搜索的 /api/skills?query=
      const res = await fetch(`${REGISTRY_URL}/api/skills`);
      const { data } = (await res.json()) as {
        data: Array<{ name: string; summary: string; slug: string }>;
      };
      const matched = data.filter(
        (s) => s.name.includes(query) || s.summary.includes(query),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(matched, null, 2) }],
      };
    },
  );

  /** 列出全部 skill */
  server.tool("list_skills", "列出企业内所有已发布的 AI skill", {}, async () => {
    const res = await fetch(`${REGISTRY_URL}/api/skills`);
    const json = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  });

  /** 获取 skill 完整内容（SKILL.md 正文，供模型执行） */
  server.tool(
    "get_skill",
    "获取指定 skill 的完整内容",
    { slug: z.string().describe("skill 的唯一标识") },
    async ({ slug }) => {
      const res = await fetch(`${REGISTRY_URL}/api/skills/${slug}`);
      if (res.status === 404) {
        return {
          content: [{ type: "text", text: `skill "${slug}" 不存在` }],
          isError: true,
        };
      }
      const json = await res.json();
      // TODO: 上报 usage_events 埋点
      return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
    },
  );

  // TODO: 将已发布的 skill 注册为 prompts 原语（需先确认 WorkBuddy 是否支持）

  return server;
}
