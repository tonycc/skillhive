const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? "http://localhost:3100";

/** 通知长连接 MCP 会话刷新可用 Skill prompt；失败不影响主事务。 */
export function notifyPromptsChanged(): void {
  const internalToken = process.env.SKILLHIVE_INTERNAL_TOKEN?.trim();
  if (!internalToken) return;
  void fetch(`${MCP_SERVER_URL}/internal/prompts-changed`, {
    method: "POST",
    headers: { "X-SkillHive-Internal-Token": internalToken },
    signal: AbortSignal.timeout(3_000),
  }).then((res) => {
    if (!res.ok) console.warn(`[skillhive] 通知 MCP Server 返回 ${res.status}`);
  }).catch((err: unknown) => {
    console.warn("[skillhive] 通知 MCP Server 失败：", err instanceof Error ? err.message : err);
  });
}
