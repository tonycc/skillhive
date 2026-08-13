import { McpServer, type RegisteredPrompt } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validateResourcePath } from "@skillhive/skill-schema";
import { z } from "zod";
import {
  fetchVisibleSkill,
  fetchVisibleSkillFile,
  fetchVisibleSkills,
  RegistryError,
  reportEvent,
  type CallerIdentity,
  type SkillDetail,
} from "./registry.js";
import { decodeSkillFile, validateSkillFileResponse } from "./skill-files.js";

export { REGISTRY_URL, type CallerIdentity } from "./registry.js";

const slugSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug 必须是 kebab-case")
  .describe("skill 的唯一标识，例如 weekly-report");

const filePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((path) => validateResourcePath(path) === null, "必须是合法的技能资源相对路径")
  .describe("list_skill_files 返回的精确相对路径，例如 references/policy.md");

const versionSchema = z
  .string()
  .max(32)
  .regex(/^\d+\.\d+\.\d+$/, "version 必须符合语义化版本格式")
  .describe("get_skill 返回的 version；读取文件时必须原样传回以固定版本");

function toolError(error: unknown, subject = "skill") {
  const message =
    error instanceof RegistryError
      ? error.message
      : error instanceof Error && error.message.startsWith("资源文件")
        ? error.message
        : `${subject} 暂时无法加载`;
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function bodyAndMetadata(detail: SkillDetail) {
  const latest = detail.latestVersion;
  const files = latest?.files ?? [];
  return {
    slug: detail.slug,
    name: detail.name,
    summary: detail.summary,
    category: detail.category,
    version: latest?.version ?? null,
    frontmatter: latest?.frontmatter ?? undefined,
    body: latest?.body ?? "",
    resourceFiles: files.map(({ path, size }) => ({ path, size })),
    resourceAccess:
      files.length > 0
        ? `调用 get_skill_file 时必须同时传入此 manifest 的 version（${latest?.version ?? "未知"}）以及资源 path。`
        : "该版本没有附加资源文件。",
  };
}

/** 从 Registry 拉取正文；prompt 中附带资源读取方法，避免多文件技能静默失真。 */
async function loadPrompt(slug: string, identity: CallerIdentity): Promise<string> {
  const detail = await fetchVisibleSkill(slug, identity);
  if (!detail.latestVersion) throw new RegistryError(404, "skill 没有可用版本");
  const files = detail.latestVersion.files;
  const resourceHint =
    files.length > 0
      ? `\n\n---\n此 skill 还包含 ${files.length} 个资源文件（${files.map((f) => f.path).join("、")}）。如正文要求读取它们，请调用 SkillHive 的 list_skill_files 和 get_skill_file 工具。`
      : "";
  return `${detail.latestVersion.body}${resourceHint}`;
}

/**
 * 将当前调用者可见的已发布 skill 增量同步到 prompt 注册表。
 * 每次刷新都使用会话身份查询，部门不可见或已下架的 prompt 会被移除。
 */
export async function refreshSkillPrompts(
  server: McpServer,
  registered: Map<string, RegisteredPrompt>,
  identity: CallerIdentity,
): Promise<void> {
  const skills = await fetchVisibleSkills(identity);
  const platformSlugs = new Set(skills.map((skill) => skill.slug));

  for (const skill of skills) {
    const existing = registered.get(skill.slug);
    if (!existing) {
      const handle = server.registerPrompt(
        skill.slug,
        { title: skill.name, description: skill.summary },
        async () => {
          const body = await loadPrompt(skill.slug, identity);
          void reportEvent(skill.slug, "invoke", identity);
          return {
            messages: [
              {
                role: "user" as const,
                content: { type: "text" as const, text: body },
              },
            ],
          };
        },
      );
      registered.set(skill.slug, handle);
    } else if (existing.title !== skill.name || existing.description !== skill.summary) {
      existing.update({ title: skill.name, description: skill.summary });
    }
  }

  for (const [slug, handle] of registered) {
    if (!platformSlugs.has(slug)) {
      handle.remove();
      registered.delete(slug);
    }
  }
}

export interface SkillHiveServer {
  server: McpServer;
  skillPrompts: Map<string, RegisteredPrompt>;
}

/** 创建一个身份绑定的 MCP Server；所有 Registry 请求都会按该身份执行可见性过滤。 */
export async function createServer(identity: CallerIdentity): Promise<SkillHiveServer> {
  const server = new McpServer({ name: "skillhive", version: "0.2.0" });

  server.tool(
    "search_skills",
    "按关键词搜索当前员工有权访问的企业 AI skill",
    { query: z.string().trim().min(1).max(128).describe("搜索关键词，如：周报、邮件、翻译") },
    async ({ query }) => {
      try {
        const normalized = query.toLocaleLowerCase();
        const matched = (await fetchVisibleSkills(identity)).filter((skill) =>
          `${skill.name}\n${skill.summary}\n${skill.category ?? ""}`
            .toLocaleLowerCase()
            .includes(normalized),
        );
        return { content: [{ type: "text", text: JSON.stringify(matched, null, 2) }] };
      } catch (error) {
        return toolError(error, "技能列表");
      }
    },
  );

  server.tool("list_skills", "列出当前员工有权访问的所有已发布 AI skill", {}, async () => {
    try {
      const skills = await fetchVisibleSkills(identity);
      return { content: [{ type: "text", text: JSON.stringify(skills, null, 2) }] };
    } catch (error) {
      return toolError(error, "技能列表");
    }
  });

  server.tool(
    "get_skill",
    "获取指定 skill 的元数据、Markdown 正文和资源清单；有资源时继续调用 get_skill_file",
    { slug: slugSchema },
    async ({ slug }) => {
      try {
        const detail = await fetchVisibleSkill(slug, identity);
        if (!detail.latestVersion) return toolError(new RegistryError(404, "skill 没有可用版本"));
        void reportEvent(slug, "invoke", identity);
        return {
          content: [{ type: "text", text: JSON.stringify(bodyAndMetadata(detail), null, 2) }],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.tool(
    "list_skill_files",
    "返回某个 skill 当前 manifest 的版本号及资源路径/大小；读取文件时须把该 version 传给 get_skill_file",
    { slug: slugSchema },
    async ({ slug }) => {
      try {
        const detail = await fetchVisibleSkill(slug, identity);
        const latest = detail.latestVersion;
        const manifest = {
          version: latest?.version ?? null,
          files: (latest?.files ?? []).map(({ path, size }) => ({ path, size })),
        };
        return { content: [{ type: "text", text: JSON.stringify(manifest, null, 2) }] };
      } catch (error) {
        return toolError(error, "资源清单");
      }
    },
  );

  server.tool(
    "get_skill_file",
    "读取 get_skill manifest 指定版本的一个资源文件；必须传回 manifest 的 version；文本返回 UTF-8，二进制返回 base64",
    { slug: slugSchema, path: filePathSchema, version: versionSchema },
    async ({ slug, path, version }) => {
      try {
        const file = validateSkillFileResponse(
          await fetchVisibleSkillFile(slug, path, version, identity),
          path,
          version,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(decodeSkillFile(file), null, 2) }],
        };
      } catch (error) {
        return toolError(error, "资源文件");
      }
    },
  );

  const skillPrompts = new Map<string, RegisteredPrompt>();
  try {
    await refreshSkillPrompts(server, skillPrompts, identity);
  } catch (error) {
    console.error(
      "[skillhive] 加载 skill prompts 失败，仅提供按请求实时查询的 tools：",
      error instanceof Error ? error.message : "未知错误",
    );
  }

  return { server, skillPrompts };
}
