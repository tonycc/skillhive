import { describe, expect, it } from "vitest";
import {
  parseSkillFrontmatter,
  validateBuiltMcp,
  validateConnectorMeta,
  validateEnterpriseSkillAssistant,
  validateEntrySkill,
  validateMcpTemplate,
  validateTokenSchema,
} from "./manifest-validation.mjs";

const meta = {
  name: "SkillHive",
  name_en: "SkillHive",
  description: "Explore requirements.",
  description_zh: "探索需求。",
  description_en: "Explore requirements.",
  source: "skillhive",
  type: "mcp",
  version: "1.0.0",
  minWorkbuddyVersion: "4.24.0",
  auth_mode: "token",
  examples_zh: ["探索需求", "继续讨论"],
  examples_en: ["Explore a requirement", "Continue a discussion"],
};

const mcp = {
  mcpServers: {
    skillhive: {
      type: "streamableHttp",
      url: "__SKILLHIVE_MCP_URL__",
      headers: { Authorization: "Bearer ${SKILLHIVE_PAT}" },
      timeout: 30_000,
    },
  },
};

const token = {
  title: "连接 SkillHive",
  description: "填写员工令牌",
  fields: [{ key: "SKILLHIVE_PAT", label: "员工令牌", type: "password", required: true }],
};

const skill = `---
description: 探索需求
description_zh: 探索需求
description_en: Explore requirements
allowed-tools: get_connector_status, start_exploration, list_my_explorations, get_exploration, save_exploration, submit_exploration, abandon_exploration, get_skill_file
version: 1.0.0
author: SkillHive
user-invocable: true
---
@references/tool-contracts.md
\`get_connector_status\` \`start_exploration\` \`list_my_explorations\` \`get_exploration\` \`save_exploration\` \`submit_exploration\` \`abandon_exploration\` \`get_skill_file\`
Use explorationId, activeRevision and activeContent.
讨论阶段服从锁定的应用 Skill；每轮询问当前 frontier，不设置固定问题数量，并在回答后重新计算 frontier。
`;

const enterpriseSkillAssistant = `---
description: 查找企业 Skill
description_zh: 查找企业 Skill
description_en: Find enterprise skills
allowed-tools: search_capabilities, list_capabilities, search_skills, list_skills, get_skill, list_skill_files, get_skill_file, get_connector_status, start_exploration, list_my_explorations, get_exploration, save_exploration, submit_exploration, abandon_exploration
version: 1.0.0
author: SkillHive
user-invocable: true
---
@references/tool-contracts.md
\`search_capabilities\` \`list_capabilities\` \`search_skills\` \`list_skills\` \`get_skill\` \`list_skill_files\` \`get_skill_file\`
\`get_connector_status\` \`start_exploration\` \`list_my_explorations\` \`get_exploration\` \`save_exploration\` \`submit_exploration\` \`abandon_exploration\`
根据 entryType 和 applicationKey 路由；requirement-exploration 使用应用流程。
`;

describe("WorkBuddy connector manifest validation", () => {
  it("accepts the complete official MCP + Skill shape", () => {
    expect(() => validateConnectorMeta(meta)).not.toThrow();
    expect(() => validateMcpTemplate(mcp)).not.toThrow();
    expect(() => validateTokenSchema(token)).not.toThrow();
    expect(() => validateEntrySkill(skill)).not.toThrow();
    expect(() => validateEnterpriseSkillAssistant(enterpriseSkillAssistant)).not.toThrow();
  });

  it("rejects incomplete marketplace examples", () => {
    expect(() => validateConnectorMeta({ ...meta, examples_zh: ["只有一条"] })).toThrow(/2—5/);
  });

  it("rejects malformed or ambiguous versions", () => {
    expect(() => validateConnectorMeta({ ...meta, version: "v1" })).toThrow(/语义化版本/);
  });

  it("rejects multiple MCP servers", () => {
    expect(() => validateMcpTemplate({ mcpServers: { ...mcp.mcpServers, other: mcp.mcpServers.skillhive } })).toThrow(/只能配置一个/);
  });

  it("accepts only the exact validated URL in the built MCP manifest", () => {
    const expectedUrl = "https://mcp.skillhive.corp.cn/mcp";
    const built = JSON.parse(JSON.stringify(mcp));
    built.mcpServers.skillhive.url = expectedUrl;
    expect(() => validateBuiltMcp(built, expectedUrl)).not.toThrow();
    expect(() => validateBuiltMcp(built, "https://other.corp.cn/mcp")).toThrow(/获批企业地址/);
  });

  it("rejects a visible token field or extra credential inputs", () => {
    expect(() => validateTokenSchema({ ...token, fields: [{ ...token.fields[0], type: "text" }] })).toThrow(/密码型/);
    expect(() => validateTokenSchema({ ...token, fields: [...token.fields, token.fields[0]] })).toThrow(/只能包含/);
  });

  it("rejects a Skill without the stable contract reference", () => {
    expect(() => validateEntrySkill(skill.replace("@references/tool-contracts.md", ""))).toThrow(/工具参数/);
  });

  it("rejects an entry Skill that weakens the Grill Me frontier protocol", () => {
    expect(() => validateEntrySkill(skill.replace("不设置固定问题数量", "每轮只问两个问题")))
      .toThrow(/完整 Grill Me frontier 协议/);
  });

  it("rejects an enterprise Skill assistant without application routing boundaries", () => {
    expect(() => validateEnterpriseSkillAssistant(
      enterpriseSkillAssistant.replace("根据 entryType 和 applicationKey 路由；requirement-exploration 使用应用流程。", ""),
    )).toThrow(/路由边界/);
  });

  it("parses colons inside frontmatter values", () => {
    expect(parseSkillFrontmatter("---\ndescription: 用途: 探索需求\n---\n").description).toBe("用途: 探索需求");
  });
});
