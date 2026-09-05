/* global console, process */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { parseEnterpriseMcpUrl } from "../integrations/workbuddy/url.mjs";

const COMMON_SECRETS = new Set([
  "password",
  "postgres",
  "changeme",
  "change-me",
  "secret",
  "skillhive",
]);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/;

export function parseEnvFile(content) {
  const env = {};
  for (const [index, original] of content.split(/\r?\n/).entries()) {
    const line = original.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`.env 第 ${index + 1} 行不是 KEY=VALUE`);
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`.env 第 ${index + 1} 行变量名无效`);
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    env[key] = value;
  }
  return env;
}

function requireText(env, name, issues, rejected = []) {
  const value = env[name]?.trim();
  if (!value || rejected.includes(value)) issues.push(`${name} 未配置正式值`);
  return value ?? "";
}

function validateSecret(env, name, minLength, issues) {
  const value = requireText(env, name, issues);
  if (!value) return;
  if (value.length < minLength) issues.push(`${name} 长度必须至少 ${minLength} 个字符`);
  if (new Set(value).size < 8 || COMMON_SECRETS.has(value.toLowerCase())) {
    issues.push(`${name} 不能使用低复杂度或常见默认值`);
  }
  if (/\s/.test(value)) issues.push(`${name} 不能包含空白字符`);
}

function validateHttpsUrl(raw, name, issues) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error();
  } catch {
    issues.push(`${name} 必须是无 URL 凭据的 HTTPS 地址`);
  }
}

export function validateProductionEnv(env, { phase = "deploy", connectorMeta }) {
  if (!["deploy", "launch"].includes(phase)) throw new Error("phase 只能是 deploy 或 launch");
  const issues = [];

  validateSecret(env, "POSTGRES_PASSWORD", 16, issues);
  validateSecret(env, "SKILLHIVE_SESSION_SECRET", 32, issues);
  validateSecret(env, "SKILLHIVE_INTERNAL_TOKEN", 32, issues);
  if (env.SKILLHIVE_SESSION_SECRET && env.SKILLHIVE_SESSION_SECRET === env.SKILLHIVE_INTERNAL_TOKEN) {
    issues.push("SKILLHIVE_SESSION_SECRET 与 SKILLHIVE_INTERNAL_TOKEN 必须使用不同随机值");
  }

  if (env.SKILLHIVE_ALLOW_HTTP === "1") issues.push("生产环境禁止启用 SKILLHIVE_ALLOW_HTTP=1");
  for (const name of ["EXPLORATION_DRAFT_RETENTION_DAYS", "EXPLORATION_SUBMITTED_RETENTION_DAYS"]) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 3_650) issues.push(`${name} 必须是 1—3650 天的整数`);
  }
  for (const name of ["CONSOLE_BIND_ADDRESS", "REGISTRY_BIND_ADDRESS", "MCP_BIND_ADDRESS"]) {
    const value = env[name] || "127.0.0.1";
    if (!LOOPBACK.has(value)) issues.push(`${name} 必须保持回环地址，由受信 TLS 反向代理对外提供服务`);
  }

  const hasBootstrapField = ["SKILLHIVE_ADMIN_EMAIL", "SKILLHIVE_ADMIN_NAME", "SKILLHIVE_ADMIN_PASSWORD"]
    .some((name) => Boolean(env[name]?.trim()));
  if (hasBootstrapField) {
    requireText(env, "SKILLHIVE_ADMIN_EMAIL", issues);
    requireText(env, "SKILLHIVE_ADMIN_NAME", issues);
    validateSecret(env, "SKILLHIVE_ADMIN_PASSWORD", 12, issues);
  }

  if (phase === "launch") {
    requireText(env, "SKILLHIVE_COMPANY_NAME", issues, ["本企业"]);
    if (env.WORKBUDDY_CONNECTOR_ENVIRONMENT !== "production") {
      issues.push("WORKBUDDY_CONNECTOR_ENVIRONMENT 必须是 production");
    }
    try {
      parseEnterpriseMcpUrl(env.WORKBUDDY_CONNECTOR_MCP_URL ?? "");
    } catch (error) {
      issues.push(`WORKBUDDY_CONNECTOR_MCP_URL 无效：${error instanceof Error ? error.message : "必须是企业 HTTPS /mcp 地址"}`);
    }
    for (const [name, expected] of [
      ["WORKBUDDY_CONNECTOR_SOURCE", connectorMeta.source],
      ["WORKBUDDY_CONNECTOR_VERSION", connectorMeta.version],
      ["WORKBUDDY_MIN_CLIENT_VERSION", connectorMeta.minWorkbuddyVersion],
    ]) {
      if (env[name] !== expected) issues.push(`${name} 必须与连接器源文件一致：${expected}`);
    }
    if (env.WORKBUDDY_CONNECTOR_REVIEW_STATUS !== "approved") {
      issues.push("目标企业全员推广前 WORKBUDDY_CONNECTOR_REVIEW_STATUS 必须是 approved");
    }
    const marketUrl = requireText(env, "WORKBUDDY_CONNECTOR_MARKET_URL", issues);
    if (marketUrl) validateHttpsUrl(marketUrl, "WORKBUDDY_CONNECTOR_MARKET_URL", issues);
    const verifiedVersion = requireText(env, "WORKBUDDY_VERIFIED_CLIENT_VERSION", issues);
    if (verifiedVersion && !SEMVER.test(verifiedVersion)) issues.push("WORKBUDDY_VERIFIED_CLIENT_VERSION 必须以语义化版本开头");
    requireText(env, "WORKBUDDY_VERIFIED_OS", issues);
    const verifiedAt = requireText(env, "WORKBUDDY_VERIFIED_AT", issues);
    if (verifiedAt && Number.isNaN(Date.parse(verifiedAt))) issues.push("WORKBUDDY_VERIFIED_AT 必须是可解析的日期时间");
  }

  return issues;
}

export function parseProductionValidationOptions(rawArgs) {
  const args = rawArgs.filter((value) => value !== "--");
  const seen = new Set();
  let envFile = ".env";
  let phase = "deploy";
  let fromProcess = false;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!["--env-file", "--phase", "--from-process"].includes(option)) throw new Error(`未知参数：${option}`);
    if (seen.has(option)) throw new Error(`${option} 只能提供一次`);
    seen.add(option);
    if (option === "--from-process") {
      fromProcess = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} 缺少参数值`);
    if (option === "--env-file") envFile = value;
    else phase = value;
    index += 1;
  }
  if (fromProcess && seen.has("--env-file")) throw new Error("--from-process 与 --env-file 不能同时使用");
  return { envFile, phase, fromProcess };
}

async function main() {
  const options = parseProductionValidationOptions(process.argv.slice(2));
  const metaContent = await readFile(resolve("integrations/workbuddy/skillhive/connector-meta.json"), "utf8");
  const env = options.fromProcess
    ? process.env
    : parseEnvFile(await readFile(resolve(options.envFile), "utf8"));
  const issues = validateProductionEnv(env, {
    phase: options.phase,
    connectorMeta: JSON.parse(metaContent),
  });
  if (issues.length > 0) {
    console.error(`生产配置校验失败（${issues.length} 项；未输出任何密钥值）：`);
    for (const issue of issues) console.error(`- ${issue}`);
    process.exitCode = 1;
    return;
  }
  console.log(`生产配置校验通过：${options.phase === "launch" ? "目标企业全员推广" : "部署联调"}阶段`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
