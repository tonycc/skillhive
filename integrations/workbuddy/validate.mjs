/* global console */
import { access, lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnterpriseMcpUrl } from "./url.mjs";
import {
  validateConnectorMeta,
  validateEnterpriseSkillAssistant,
  validateEntrySkill,
  validateMcpTemplate,
  validatePublicMarketplaceAccessCopy,
  validateTokenSchema,
} from "./manifest-validation.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const source = join(root, "skillhive");

const validBuildUrl = parseEnterpriseMcpUrl("https://mcp.skillhive.corp.cn/mcp");
if (validBuildUrl.pathname !== "/mcp") throw new Error("企业 MCP 地址校验器未保留 /mcp 路径");
for (const unsafeUrl of [
  "http://mcp.skillhive.corp.cn/mcp",
  "https://user:password@mcp.skillhive.corp.cn/mcp",
  "https://localhost/mcp",
  "https://127.0.0.1/mcp",
  "https://company-approved-domain.example/mcp",
  "https://mcp.skillhive.corp.cn/mcp?token=secret",
]) {
  try {
    parseEnterpriseMcpUrl(unsafeUrl);
    throw new Error(`企业 MCP 地址校验器错误接受了不安全地址：${unsafeUrl}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("企业 MCP 地址校验器错误接受")) throw error;
  }
}
async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error(`连接器源目录禁止符号链接：${path}`);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`连接器源目录包含不支持的文件类型：${path}`);
  }
  return files;
}
const json = async (name) => JSON.parse(await readFile(join(source, name), "utf8"));
const meta = await json("connector-meta.json");
const mcp = await json("mcp.template.json");
const token = await json("token-schema.json");
validateConnectorMeta(meta);
validateMcpTemplate(mcp);
validateTokenSchema(token);
validatePublicMarketplaceAccessCopy(meta, token);
await access(join(source, "icon.svg"));
const skill = await readFile(join(source, "skills", "requirement-exploration", "SKILL.md"), "utf8");
validateEntrySkill(skill);
const enterpriseSkillAssistant = await readFile(
  join(source, "skills", "enterprise-skill-assistant", "SKILL.md"),
  "utf8",
);
validateEnterpriseSkillAssistant(enterpriseSkillAssistant);
for (const path of await sourceFiles(source)) {
  const content = await readFile(path, "utf8");
  if (/\bsk-[a-f0-9]{48}\b/i.test(content)) throw new Error(`连接器源文件疑似包含员工令牌：${path}`);
  if (content.includes("SKILLHIVE_INTERNAL_TOKEN") || content.includes("DATABASE_URL=")) {
    throw new Error(`连接器源文件包含服务端秘密配置名：${path}`);
  }
  if (/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])/i.test(content)) {
    throw new Error(`连接器源文件包含本地服务地址：${path}`);
  }
}
console.log("WorkBuddy 连接器源文件校验通过");
