/* global URL */
import { isIP } from "node:net";

const RESERVED_SUFFIXES = [".example", ".invalid", ".localhost", ".test"];
const RESERVED_EXAMPLE_DOMAINS = ["example.com", "example.net", "example.org"];

function normalizedHostname(url) {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
}

function isReservedHostname(hostname) {
  return hostname === "localhost"
    || isIP(hostname) !== 0
    || RESERVED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
    || RESERVED_EXAMPLE_DOMAINS.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    );
}

export function parseEnterpriseMcpUrl(raw) {
  if (!raw?.trim()) throw new Error("缺少企业 MCP 地址");
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("企业 MCP 地址不是合法 URL");
  }
  if (url.protocol !== "https:") throw new Error("企业 MCP 地址必须使用 HTTPS");
  if (url.username || url.password) throw new Error("企业 MCP 地址禁止包含用户名或密码");
  if (url.pathname !== "/mcp" || url.search || url.hash) {
    throw new Error("企业 MCP 地址路径必须为 /mcp，且不能携带查询参数或片段");
  }
  if (isReservedHostname(normalizedHostname(url))) {
    throw new Error("企业 MCP 地址禁止使用 IP、本机地址或示例保留域名");
  }
  return url;
}
