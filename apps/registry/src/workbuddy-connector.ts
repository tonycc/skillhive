import { isIP } from "node:net";

const RESERVED_SUFFIXES = [".example", ".invalid", ".localhost", ".test"];
const RESERVED_EXAMPLE_DOMAINS = ["example.com", "example.net", "example.org"];

function isReservedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost"
    || isIP(normalized) !== 0
    || RESERVED_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
    || RESERVED_EXAMPLE_DOMAINS.some(
      (domain) => normalized === domain || normalized.endsWith(`.${domain}`),
    );
}

export function optionalEnterpriseHttpsUrl(
  raw: string | undefined,
  requiredPath?: string,
): { value: string | null; valid: boolean } {
  if (!raw?.trim()) return { value: null, valid: false };
  try {
    const url = new URL(raw.trim());
    const valid = url.protocol === "https:"
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && !isReservedHostname(url.hostname)
      && (!requiredPath || url.pathname === requiredPath);
    return { value: valid ? url.toString() : null, valid };
  } catch {
    return { value: null, valid: false };
  }
}

export interface WorkBuddyReadinessInput {
  mcpUrlValid: boolean;
  environment: string;
  reviewStatus: string;
  marketUrlValid: boolean;
  verifiedClientVersion: string | null;
  verifiedOs: string | null;
  verifiedAt: string | null;
}

export function workBuddyConnectorReadiness(input: WorkBuddyReadinessInput) {
  const packageIssues = input.mcpUrlValid ? [] : ["尚未配置合法的非示例 HTTPS /mcp 企业地址"];
  const clientTestIssues = [
    ...packageIssues,
    ...(!["test", "production"].includes(input.environment) ? ["部署环境必须标记为测试或生产"] : []),
  ];
  const launchIssues = [
    ...packageIssues,
    ...(input.environment !== "production" ? ["部署环境尚未标记为生产"] : []),
    ...(input.reviewStatus !== "approved" ? ["WorkBuddy 平台审核尚未通过"] : []),
    ...(!input.marketUrlValid ? ["尚未登记有效的正式市场入口"] : []),
    ...(!input.verifiedClientVersion ? ["尚未登记真实实测客户端版本"] : []),
    ...(!input.verifiedOs ? ["尚未登记真实实测操作系统"] : []),
    ...(!input.verifiedAt ? ["尚未登记有效的真实实测时间"] : []),
  ];
  return {
    readyForPackageBuild: packageIssues.length === 0,
    readyForClientTest: clientTestIssues.length === 0,
    readyForLaunch: launchIssues.length === 0,
    packageIssues,
    clientTestIssues,
    launchIssues,
  };
}
