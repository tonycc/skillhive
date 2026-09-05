/* global URL */

export function parseMcpUrl(raw) {
  if (!raw?.trim()) throw new Error("缺少企业 MCP 地址");
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("企业 MCP 地址不是合法 URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("企业 MCP 地址仅支持 HTTP 或 HTTPS");
  if (url.username || url.password) throw new Error("企业 MCP 地址禁止包含用户名或密码");
  if (url.pathname !== "/mcp" || url.search || url.hash) {
    throw new Error("企业 MCP 地址路径必须为 /mcp，且不能携带查询参数或片段");
  }
  return url;
}
