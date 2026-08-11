import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseSkillMd } from "@skillhive/skill-schema";

const REGISTRY_URL = process.env.SKILLHIVE_REGISTRY_URL ?? "http://localhost:3001";

interface SkillListItem {
  slug: string;
  name: string;
  summary: string;
}

interface SkillDetail {
  data: {
    latestVersion?: { content?: string } | null;
  };
}

/** 埋点上报（fire-and-forget，失败不影响主流程） */
function reportEvent(slug: string, event: "view" | "invoke", client = "mcp"): void {
  void fetch(`${REGISTRY_URL}/api/skills/${slug}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, client }),
  }).catch(() => {});
}

/** 从 Registry 拉取 skill 正文（剥除 frontmatter） */
async function loadSkillBody(slug: string): Promise<string | null> {
  const res = await fetch(`${REGISTRY_URL}/api/skills/${slug}`);
  if (!res.ok) return null;
  const detail = (await res.json()) as SkillDetail;
  const raw = detail.data.latestVersion?.content ?? "";
  try {
    return parseSkillMd(raw).body;
  } catch {
    return raw;
  }
}

/**
 * 创建 MCP Server 实例（stdio / http 两种传输共用）。
 *
 * 每个已发布的 skill 会同时以两种形态暴露：
 * - tools：供模型自主检索与调用（search/list/get）
 * - prompts：供用户在客户端主动点选（WorkBuddy 快捷指令）
 *
 * 注意：prompts 在 server 实例创建时从 Registry 动态加载，
 * 因此新建的 SSE 连接总是拿到最新的 skill 列表。
 */
export async function createServer(): Promise<McpServer> {
  const server = new McpServer({
    name: "skillhive",
    version: "0.1.0",
  });

  // ---------- tools ----------

  server.tool(
    "search_skills",
    "按关键词搜索企业内可用的 AI skill",
    { query: z.string().describe("搜索关键词，如：周报、邮件、翻译") },
    async ({ query }) => {
      // TODO: 改为调用带语义搜索的 /api/skills?query=
      const res = await fetch(`${REGISTRY_URL}/api/skills`);
      const { data } = (await res.json()) as { data: SkillListItem[] };
      const matched = data.filter(
        (s) => s.name.includes(query) || s.summary.includes(query),
      );
      return {
        content: [{ type: "text", text: JSON.stringify(matched, null, 2) }],
      };
    },
  );

  server.tool("list_skills", "列出企业内所有已发布的 AI skill", {}, async () => {
    const res = await fetch(`${REGISTRY_URL}/api/skills`);
    const json = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  });

  server.tool(
    "get_skill",
    "获取指定 skill 的完整内容",
    { slug: z.string().describe("skill 的唯一标识") },
    async ({ slug }) => {
      const body = await loadSkillBody(slug);
      if (body === null) {
        return {
          content: [{ type: "text", text: `skill "${slug}" 不存在` }],
          isError: true,
        };
      }
      reportEvent(slug, "invoke");
      return { content: [{ type: "text", text: body }] };
    },
  );

  // ---------- prompts（每个已发布 skill 注册为快捷指令） ----------

  try {
    const res = await fetch(`${REGISTRY_URL}/api/skills`);
    if (res.ok) {
      const { data } = (await res.json()) as { data: SkillListItem[] };
      for (const s of data) {
        server.registerPrompt(
          s.slug,
          { title: s.name, description: s.summary },
          async () => {
            const body = await loadSkillBody(s.slug);
            reportEvent(s.slug, "invoke");
            return {
              messages: [
                {
                  role: "user" as const,
                  content: {
                    type: "text" as const,
                    text: body ?? `skill "${s.slug}" 加载失败`,
                  },
                },
              ],
            };
          },
        );
      }
    }
  } catch (err) {
    // Registry 不可用时降级为仅提供 tools
    console.error("[skillhive] 加载 skill prompts 失败，仅提供 tools：", err);
  }

  return server;
}
