export interface PublicMcpEndpoints {
  /** SSE endpoint 事件中使用的同源消息地址。 */
  messagesPath: "/messages";
}

/**
 * 当前部署只为根路径 /sse 与 /messages 配置了路由。显式拒绝路径前缀，避免
 * Console 能连接 SSE、但 SDK 随后把消息投递到不存在地址的半可用配置。
 */
export function parsePublicMcpUrl(
  value: string | undefined,
  production: boolean,
): PublicMcpEndpoints {
  const configured = value?.trim();
  if (!configured) return { messagesPath: "/messages" };
  if (configured.includes("?") || configured.includes("#")) {
    throw new Error("PUBLIC_MCP_URL 配置无效：不能包含查询参数或片段");
  }

  let parsed: URL;
  try {
    if (configured.startsWith("/") && !configured.startsWith("//")) {
      // 不先交给 URL 规范化；反斜杠可能被解释为 authority 分隔符并改变 origin。
      if (configured !== "/sse") {
        throw new Error("当前部署仅支持根路径 /sse");
      }
      parsed = new URL(configured, "http://skillhive.local");
    } else {
      parsed = new URL(configured);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("仅支持 http://、https:// 或同源相对路径");
      }
      if (production && parsed.protocol !== "https:") {
        throw new Error("生产环境必须使用 https:// 或同源相对路径");
      }
    }
  } catch (error) {
    throw new Error(
      `PUBLIC_MCP_URL 配置无效：${error instanceof Error ? error.message : "未知错误"}`,
    );
  }

  if (parsed.username || parsed.password) {
    throw new Error("PUBLIC_MCP_URL 配置无效：不允许在 URL 中包含凭据");
  }
  if (parsed.pathname !== "/sse") {
    throw new Error("PUBLIC_MCP_URL 配置无效：当前部署仅支持根路径 /sse");
  }
  return { messagesPath: "/messages" };
}
