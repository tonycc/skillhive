import { McpServer, type RegisteredPrompt } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validateResourcePath } from "@skillhive/skill-schema";
import { z } from "zod";
import {
  fetchVisibleApplications,
  fetchVisibleSkill,
  fetchVisibleSkillFile,
  fetchVisibleSkills,
  fetchExplorationRuleFile,
  abandonExploration,
  getConnectorStatus,
  getExploration,
  listMyExplorations,
  RegistryError,
  reportEvent,
  saveExploration,
  startExploration,
  submitExploration,
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

const explorationIdSchema = z.string().uuid().describe("start_exploration 返回的 explorationId");
const expectedRevisionSchema = z.number().int().min(0).describe("最近一次读取或保存返回的 revision");
const idempotencyKeySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/)
  .describe("本次写操作的唯一键；重试同一操作时必须复用，内容变化时必须换新键");
const longText = z.string().trim().max(8_000);
const explorationContentSchema = z.object({
  title: z.string().trim().min(1).max(128),
  problemDescription: longText.optional(),
  targetUsers: longText.optional(),
  currentProcess: longText.optional(),
  painAndEvidence: z.array(z.object({
    pain: longText.min(1),
    evidence: longText.optional(),
    evidenceStatus: z.enum(["employee_statement", "to_verify"]).default("employee_statement"),
  })).max(20).default([]),
  objectivesAndBenefits: longText.optional(),
  scope: longText.optional(),
  nonGoals: longText.optional(),
  acceptanceCriteria: z.array(longText.min(1)).max(20).default([]),
  constraintsAndRisks: z.array(longText.min(1)).max(20).default([]),
  pendingQuestions: z.array(longText.min(1)).max(20).default([]),
  summary: longText.optional(),
}).strict().describe("当前阶段的完整结构化草稿快照，不要传原始聊天记录");

function toolError(error: unknown, subject = "skill") {
  const message =
    error instanceof RegistryError
      ? error.message
      : error instanceof Error && error.message.startsWith("资源文件")
        ? error.message
        : `${subject} 暂时无法加载`;
  const status = error instanceof RegistryError ? error.status : 500;
  const upstreamCode = error instanceof RegistryError && typeof error.details?.code === "string"
    ? error.details.code
    : null;
  const code = upstreamCode ?? (status === 400 ? "INVALID_ARGUMENT"
    : status === 401 ? "UNAUTHENTICATED"
    : status === 403 ? "FORBIDDEN"
    : status === 404 ? "NOT_FOUND"
    : status === 409 ? "CONFLICT"
    : status === 422 ? "VALIDATION_FAILED"
    : status === 429 ? "RATE_LIMITED"
    : status === 503 ? "TEMPORARILY_UNAVAILABLE"
    : "INTERNAL_ERROR");
  const upstreamNextStep = error instanceof RegistryError && typeof error.details?.nextStep === "string"
    ? error.details.nextStep
    : null;
  const nextStep = upstreamNextStep ?? (status === 401
    ? "联系公司 SkillHive 管理员补发或轮换员工专属令牌"
    : status === 409
      ? "重新读取当前记录或连接器状态，再按最新 revision 继续"
      : status === 422
        ? "根据 missingFields 补齐草稿并先保存，再重新提交"
        : status === 429 || status >= 500
          ? "稍后使用原 idempotencyKey 重试；不确定时先查询最后成功记录"
          : "检查对象编号和当前账号权限");
  const upstreamRetryable = error instanceof RegistryError && typeof error.details?.retryable === "boolean"
    ? error.details.retryable
    : null;
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        error: {
          code,
          message,
          retryable: upstreamRetryable ?? (status === 429 || status >= 500),
          nextStep,
          ...(error instanceof RegistryError && error.details ? { details: error.details } : {}),
        },
      }, null, 2),
    }],
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

function jsonToolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function discoveryItem(skill: Awaited<ReturnType<typeof fetchVisibleSkills>>[number]) {
  const { skillType: _skillType, ...publicSkill } = skill;
  return {
    ...publicSkill,
    entryType: "skill" as const,
    applicationKey: null,
    invocation: "调用 get_skill 获取当前发布版本正文和资源清单，再按该版本执行。",
  };
}

function matchesQuery(
  item: { name: string; summary: string; category?: string; tags?: string[]; keywords?: string[] },
  normalized: string,
): boolean {
  return `${item.name}\n${item.summary}\n${item.category ?? ""}\n${item.tags?.join("\n") ?? ""}\n${item.keywords?.join("\n") ?? ""}`
    .toLocaleLowerCase()
    .includes(normalized);
}

async function capabilityItems(identity: CallerIdentity) {
  const [skills, applications] = await Promise.all([
    fetchVisibleSkills(identity),
    fetchVisibleApplications(identity),
  ]);
  return [...skills.map(discoveryItem), ...applications];
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
    "search_capabilities",
    "按关键词统一搜索当前员工可使用的普通 Skill 和应用；应用内部 Skill 不会出现在结果中",
    { query: z.string().trim().min(1).max(128).describe("任务关键词，如：周报、翻译、需求探索") },
    async ({ query }) => {
      try {
        const normalized = query.toLocaleLowerCase();
        return jsonToolResult((await capabilityItems(identity)).filter((item) => matchesQuery(item, normalized)));
      } catch (error) {
        return toolError(error, "企业能力列表");
      }
    },
  );

  server.tool("list_capabilities", "列出当前员工可使用的普通 Skill 和应用；不返回应用内部 Skill", {}, async () => {
    try {
      return jsonToolResult(await capabilityItems(identity));
    } catch (error) {
      return toolError(error, "企业能力列表");
    }
  });

  server.tool(
    "search_skills",
    "按关键词搜索当前员工有权访问的普通企业 AI Skill；不返回应用或应用 Skill",
    { query: z.string().trim().min(1).max(128).describe("搜索关键词，如：周报、邮件、翻译") },
    async ({ query }) => {
      try {
        const normalized = query.toLocaleLowerCase();
        const matched = (await fetchVisibleSkills(identity)).filter((skill) => matchesQuery(skill, normalized));
        return jsonToolResult(matched.map(discoveryItem));
      } catch (error) {
        return toolError(error, "技能列表");
      }
    },
  );

  if (identity.subjectType === "employee") {
    server.tool(
      "get_connector_status",
      "检查当前员工身份、需求探索权限和服务兼容性；首次接入时先调用",
      { protocolVersion: z.string().max(32).optional().describe("入口 Skill 使用的协议版本，当前为 1.0") },
      async ({ protocolVersion }) => {
        try {
          return jsonToolResult(await getConnectorStatus(identity, protocolVersion));
        } catch (error) {
          return toolError(error, "连接器状态");
        }
      },
    );

    server.tool(
      "start_exploration",
      "开始一条新的企业需求探索",
      {
        initialProblem: z.string().trim().max(8_000).optional().describe("员工当前描述的问题，可为空"),
        idempotencyKey: idempotencyKeySchema,
        protocolVersion: z.literal("1.0").default("1.0"),
      },
      async (input) => {
        try {
          return jsonToolResult(await startExploration(identity, input));
        } catch (error) {
          return toolError(error, "需求探索");
        }
      },
    );

    server.tool(
      "list_my_explorations",
      "列出当前员工本人的需求探索、草稿状态、正式需求编号和评审状态",
      {
        state: z.enum(["discussing", "submitted", "editing", "abandoned"]).optional(),
        keyword: z.string().trim().max(128).optional(),
        page: z.number().int().min(1).default(1),
        pageSize: z.number().int().min(1).max(100).default(20),
      },
      async (query) => {
        try {
          return jsonToolResult(await listMyExplorations(identity, query));
        } catch (error) {
          return toolError(error, "需求探索列表");
        }
      },
    );

    server.tool(
      "get_exploration",
      "读取当前员工本人的某条探索、已保存修订、正式提交状态和员工可见的评审反馈",
      {
        explorationId: explorationIdSchema,
        submission: z.number().int().min(1).optional().describe("要查看的正式提交版本；省略时返回当前草稿和状态"),
      },
      async ({ explorationId, submission }) => {
        try {
          return jsonToolResult(await getExploration(identity, explorationId, submission));
        } catch (error) {
          return toolError(error, "需求探索");
        }
      },
    );

    server.tool(
      "save_exploration",
      "保存当前需求探索的完整结构化草稿快照。只上传阶段性业务总结，不上传整段聊天；成功回执后才能告诉员工已保存",
      {
        explorationId: explorationIdSchema,
        expectedRevision: expectedRevisionSchema,
        content: explorationContentSchema,
        idempotencyKey: idempotencyKeySchema,
      },
      async ({ explorationId, ...input }) => {
        try {
          return jsonToolResult(await saveExploration(identity, explorationId, input));
        } catch (error) {
          return toolError(error, "需求探索草稿");
        }
      },
    );

    server.tool(
      "submit_exploration",
      "把已保存的指定修订正式提交到公司需求池。只有员工明确表达提交意图后才能调用；缺项时继续讨论而不是填造内容",
      {
        explorationId: explorationIdSchema,
        expectedRevision: expectedRevisionSchema,
        idempotencyKey: idempotencyKeySchema,
      },
      async ({ explorationId, ...input }) => {
        try {
          return jsonToolResult(await submitExploration(identity, explorationId, input));
        } catch (error) {
          return toolError(error, "正式需求提交");
        }
      },
    );

    server.tool(
      "abandon_exploration",
      "在员工明确确认后放弃探索。首次提交前会关闭整条探索；已有正式提交时只放弃未提交修改并保留正式版本",
      {
        explorationId: explorationIdSchema,
        expectedRevision: expectedRevisionSchema,
        idempotencyKey: idempotencyKeySchema,
      },
      async ({ explorationId, ...input }) => {
        try {
          return jsonToolResult(await abandonExploration(identity, explorationId, input));
        } catch (error) {
          return toolError(error, "需求探索");
        }
      },
    );
  }

  server.tool("list_skills", "列出当前员工有权访问的所有已发布普通 AI Skill；不返回应用 Skill", {}, async () => {
    try {
      const skills = await fetchVisibleSkills(identity);
      return jsonToolResult(skills.map(discoveryItem));
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
    "读取指定版本的一个资源文件。普通 Skill 使用 get_skill manifest；受管需求探索必须同时传 explorationId，并使用 start/get_exploration 返回的锁定版本与路径",
    {
      slug: slugSchema,
      path: filePathSchema,
      version: versionSchema,
      explorationId: explorationIdSchema.optional().describe("受管需求探索必填；普通 Skill 可省略"),
    },
    async ({ slug, path, version, explorationId }) => {
      try {
        if (identity.subjectType === "employee" && explorationId) {
          const file = validateSkillFileResponse(
            await fetchExplorationRuleFile(explorationId, slug, path, version, identity),
            path,
            version,
          );
          return {
            content: [{ type: "text", text: JSON.stringify(decodeSkillFile(file), null, 2) }],
          };
        }
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
