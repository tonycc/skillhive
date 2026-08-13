import { McpServer, type RegisteredPrompt } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseSkillMd } from "@skillhive/skill-schema";

export const REGISTRY_URL = process.env.SKILLHIVE_REGISTRY_URL ?? "http://localhost:3001";

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

/** 已鉴权的调用者身份（PAT 解析结果） */
export interface CallerIdentity {
  id: string;
  email: string;
  name: string;
}

/** 埋点上报（fire-and-forget，失败不影响主流程） */
function reportEvent(
  slug: string,
  event: "view" | "invoke",
  client = "mcp",
  userId?: string,
): void {
  void fetch(`${REGISTRY_URL}/api/skills/${slug}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, client, userId }),
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

/** 从 Registry 拉取当前已发布的 skill 列表 */
async function fetchPublishedSkills(): Promise<SkillListItem[]> {
  const res = await fetch(`${REGISTRY_URL}/api/skills`);
  if (!res.ok) throw new Error(`Registry 返回 ${res.status}`);
  const { data } = (await res.json()) as { data: SkillListItem[] };
  return data;
}

/**
 * 将平台最新 skill 列表增量同步到 server 的 prompts 注册表：
 * - 新增：注册为快捷指令
 * - 名称/摘要变化：原地 update
 * - 已下架：remove
 *
 * 对已连接的客户端，每个变更都会自动触发 notifications/prompts/list_changed，
 * 客户端收到通知后重新拉取 prompts/list 即可看到最新列表（无需断线重连）。
 * server 未连接时（如 createServer 初始化阶段）通知自动跳过，安全可重入。
 */
export async function refreshSkillPrompts(
  server: McpServer,
  registered: Map<string, RegisteredPrompt>,
  identity?: CallerIdentity,
): Promise<void> {
  const skills = await fetchPublishedSkills();
  const platformSlugs = new Set(skills.map((s) => s.slug));

  // 新增 / 更新
  for (const s of skills) {
    const existing = registered.get(s.slug);
    if (!existing) {
      const handle = server.registerPrompt(
        s.slug,
        { title: s.name, description: s.summary },
        async () => {
          const body = await loadSkillBody(s.slug);
          reportEvent(s.slug, "invoke", "mcp", identity?.id);
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
      registered.set(s.slug, handle);
    } else if (existing.title !== s.name || existing.description !== s.summary) {
      existing.update({ title: s.name, description: s.summary });
    }
  }

  // 下架清理
  for (const [slug, handle] of registered) {
    if (!platformSlugs.has(slug)) {
      handle.remove();
      registered.delete(slug);
    }
  }
}

/** createServer 的返回：server 实例 + 该实例已注册的 skill prompt 句柄表 */
export interface SkillHiveServer {
  server: McpServer;
  /** 已注册的 skill prompt 句柄，供 refreshSkillPrompts 增量维护 */
  skillPrompts: Map<string, RegisteredPrompt>;
}

/**
 * 创建 MCP Server 实例（stdio / http 两种传输共用）。
 *
 * 每个已发布的 skill 会同时以两种形态暴露：
 * - tools：供模型自主检索与调用（search/list/get，每次现查 Registry，永远实时）
 * - prompts：供用户在客户端主动点选（WorkBuddy 快捷指令）
 *
 * prompts 在实例创建时从 Registry 加载；实例存活期间若平台发布/下架 skill，
 * 由 /internal/prompts-changed 触发 refreshSkillPrompts 增量刷新并通知客户端。
 *
 * identity 为 PAT 鉴权解析出的调用者，用于埋点归属；stdio 本地模式可为空。
 */
export async function createServer(identity?: CallerIdentity): Promise<SkillHiveServer> {
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
      reportEvent(slug, "invoke", "mcp", identity?.id);
      return { content: [{ type: "text", text: body }] };
    },
  );

  // ---------- prompts（每个已发布 skill 注册为快捷指令） ----------

  const skillPrompts = new Map<string, RegisteredPrompt>();
  try {
    await refreshSkillPrompts(server, skillPrompts, identity);
  } catch (err) {
    // Registry 不可用时降级为仅提供 tools
    console.error("[skillhive] 加载 skill prompts 失败，仅提供 tools：", err);
  }

  return { server, skillPrompts };
}
