const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const REQUIRED_EXPLORATION_TOOLS = [
  "get_connector_status",
  "start_exploration",
  "list_my_explorations",
  "get_exploration",
  "save_exploration",
  "submit_exploration",
  "abandon_exploration",
  "get_skill_file",
];
const REQUIRED_ENTERPRISE_SKILL_TOOLS = [
  "search_capabilities",
  "list_capabilities",
  "search_skills",
  "list_skills",
  "get_skill",
  "list_skill_files",
  "get_skill_file",
  ...REQUIRED_EXPLORATION_TOOLS.filter((tool) => tool !== "get_skill_file"),
];

function fail(message) {
  throw new Error(message);
}

function requireText(value, field, file) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${file} 缺少非空字段：${field}`);
  }
}

function requireExamples(value, field) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 5
    || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    fail(`connector-meta.json 的 ${field} 必须包含 2—5 条非空自然语言示例`);
  }
}

export function validateConnectorMeta(meta) {
  for (const field of [
    "name",
    "name_en",
    "description",
    "description_zh",
    "description_en",
    "source",
    "version",
    "minWorkbuddyVersion",
  ]) requireText(meta?.[field], field, "connector-meta.json");

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.source)) {
    fail("connector-meta.json 的 source 必须使用 kebab-case");
  }
  if (meta.type !== "mcp" || meta.auth_mode !== "token") {
    fail("connector-meta.json 必须声明 MCP Token 认证模式");
  }
  if (!SEMVER.test(meta.version) || !SEMVER.test(meta.minWorkbuddyVersion)) {
    fail("连接器版本和最低 WorkBuddy 版本必须使用语义化版本");
  }
  requireExamples(meta.examples_zh, "examples_zh");
  requireExamples(meta.examples_en, "examples_en");
}

function validateMcp(mcp, expectedUrl, label) {
  const serverEntries = Object.entries(mcp?.mcpServers ?? {});
  if (serverEntries.length !== 1) fail("mcp.json 必须且只能配置一个 MCP Server");
  const [serverName, server] = serverEntries[0];
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(serverName)) fail("MCP Server 名称必须使用 kebab-case");
  if (server?.type !== "streamableHttp" || server.url !== expectedUrl) {
    fail(`MCP 必须使用${label}的 streamableHttp 传输`);
  }
  if (server.headers?.Authorization !== "Bearer ${SKILLHIVE_PAT}") {
    fail("MCP Authorization 必须引用员工令牌变量，不能写入真实凭证");
  }
  if (!Number.isInteger(server.timeout) || server.timeout <= 0 || server.timeout > 30_000) {
    fail("MCP timeout 必须是 1—30000 毫秒的整数");
  }
}

export function validateMcpTemplate(mcp) {
  validateMcp(mcp, "__SKILLHIVE_MCP_URL__", "带构建期企业地址占位符");
}

export function validateBuiltMcp(mcp, expectedUrl) {
  validateMcp(mcp, expectedUrl, "获批企业地址");
}

export function validateTokenSchema(token) {
  requireText(token?.title, "title", "token-schema.json");
  requireText(token?.description, "description", "token-schema.json");
  if (!Array.isArray(token.fields) || token.fields.length !== 1) {
    fail("token-schema.json 必须且只能包含员工令牌输入项");
  }
  const [field] = token.fields;
  requireText(field?.label, "fields[0].label", "token-schema.json");
  if (field?.key !== "SKILLHIVE_PAT" || field.type !== "password" || field.required !== true) {
    fail("token-schema.json 必须声明必填的密码型 SKILLHIVE_PAT 字段");
  }
}

export function parseSkillFrontmatter(skill) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skill);
  if (!match) fail("入口 SKILL.md 缺少 YAML frontmatter");
  const values = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return values;
}

export function validateEntrySkill(skill) {
  const frontmatter = parseSkillFrontmatter(skill);
  for (const field of ["description", "description_zh", "description_en", "version", "author"]) {
    requireText(frontmatter[field], field, "入口 SKILL.md frontmatter");
  }
  if (!SEMVER.test(frontmatter.version)) fail("入口 Skill 版本必须使用语义化版本");
  if (frontmatter["user-invocable"] !== "true") fail("入口 Skill 必须允许员工主动调用");

  const allowedTools = new Set((frontmatter["allowed-tools"] ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  for (const tool of REQUIRED_EXPLORATION_TOOLS) {
    if (!allowedTools.has(tool) || !skill.includes(`\`${tool}\``)) {
      fail(`入口 Skill 未完整声明工具：${tool}`);
    }
  }
  if (!skill.includes("@references/tool-contracts.md")) {
    fail("入口 Skill 必须引用稳定的工具参数、回执和错误恢复契约");
  }
  if (!skill.includes("activeRevision") || !skill.includes("activeContent") || !skill.includes("explorationId")) {
    fail("入口 Skill 未声明按服务器有效修订和探索编号恢复内容");
  }
  if (
    !skill.includes("锁定的应用 Skill")
    || !skill.includes("当前 frontier")
    || !skill.includes("不设置固定问题数量")
    || !skill.includes("重新计算 frontier")
  ) {
    fail("入口 Skill 必须服从锁定应用 Skill 的完整 Grill Me frontier 协议，不能限制每轮问题数量");
  }
}

export function validateEnterpriseSkillAssistant(skill) {
  const frontmatter = parseSkillFrontmatter(skill);
  for (const field of ["description", "description_zh", "description_en", "version", "author"]) {
    requireText(frontmatter[field], field, "企业 Skill 助手 frontmatter");
  }
  if (!SEMVER.test(frontmatter.version)) fail("企业 Skill 助手版本必须使用语义化版本");
  if (frontmatter["user-invocable"] !== "true") fail("企业 Skill 助手必须允许员工主动调用");

  const allowedTools = new Set((frontmatter["allowed-tools"] ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  for (const tool of REQUIRED_ENTERPRISE_SKILL_TOOLS) {
    if (!allowedTools.has(tool) || !skill.includes(`\`${tool}\``)) {
      fail(`企业 Skill 助手未完整声明工具：${tool}`);
    }
  }
  if (!skill.includes("@references/tool-contracts.md")) {
    fail("企业 Skill 助手必须引用稳定的检索和资源读取契约");
  }
  if (!skill.includes("entryType") || !skill.includes("applicationKey") || !skill.includes("requirement-exploration")) {
    fail("企业 Skill 助手未声明普通 Skill 与应用的路由边界");
  }
}

export { REQUIRED_ENTERPRISE_SKILL_TOOLS, REQUIRED_EXPLORATION_TOOLS };
