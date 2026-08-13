export const REGISTRY_URL = (process.env.SKILLHIVE_REGISTRY_URL ?? "http://localhost:3001").replace(
  /\/$/,
  "",
);

const REGISTRY_TIMEOUT_MS = 5_000;

/** 已鉴权的调用者身份（Registry 的 PAT 解析结果） */
export interface CallerIdentity {
  id: string;
  email: string;
  name: string;
  role: "admin" | "publisher" | "member";
  departmentId: string | null;
  /** PAT 数据库主键。SSE 会话用它做持续有效性校验和主动吊销。 */
  tokenId: string;
}

export interface SkillListItem {
  id?: string;
  slug: string;
  name: string;
  summary: string;
  category?: string;
  status?: string;
  iconUrl?: string | null;
  updatedAt?: string;
}

/** 详情接口只返回资源元数据，不携带可能很大的 base64 正文。 */
export interface SkillFileMetadata {
  path: string;
  size: number;
}

/** 单文件端点按需返回的完整资源。 */
export interface SkillFile extends SkillFileMetadata {
  version: string;
  contentBase64: string;
}

export interface SkillDetail {
  id?: string;
  slug: string;
  name: string;
  summary: string;
  category?: string;
  status?: string;
  visibleDepartments?: string[];
  latestVersion: {
    version: string;
    body: string;
    frontmatter?: Record<string, unknown> | null;
    changelog?: string;
    publishedAt?: string;
    files: SkillFileMetadata[];
  } | null;
}

export class RegistryError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RegistryError";
  }
}

export function getInternalToken(): string {
  const token = process.env.SKILLHIVE_INTERNAL_TOKEN?.trim();
  if (!token) {
    throw new Error("缺少 SKILLHIVE_INTERNAL_TOKEN，已拒绝启动不安全的内部调用");
  }
  if (token.length < 32) {
    throw new Error("SKILLHIVE_INTERNAL_TOKEN 至少需要 32 个字符");
  }
  return token;
}

async function parseJson<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new RegistryError(res.status, "Registry 返回了无效响应");
  }
}

async function requestRegistry<T>(
  path: string,
  identity: Pick<CallerIdentity, "id" | "tokenId">,
  init: RequestInit = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${REGISTRY_URL}${path}`, {
      ...init,
      redirect: "error",
      headers: {
        Accept: "application/json",
        "X-SkillHive-Internal-Token": getInternalToken(),
        "X-SkillHive-User-Id": identity.id,
        "X-SkillHive-Token-Id": identity.tokenId,
        ...init.headers,
      },
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
  } catch (error) {
    throw new RegistryError(
      503,
      error instanceof Error && error.name === "TimeoutError"
        ? "Registry 请求超时"
        : "Registry 暂时不可用",
    );
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new RegistryError(res.status, "没有权限访问该 skill");
    }
    if (res.status === 404) throw new RegistryError(404, "skill 不存在");
    throw new RegistryError(res.status, `Registry 请求失败（${res.status}）`);
  }
  const json = await parseJson<{ data: T }>(res);
  return json.data;
}

/** 仅走 Registry 的内部、按调用者过滤的技能列表接口。 */
export function fetchVisibleSkills(identity: CallerIdentity): Promise<SkillListItem[]> {
  return requestRegistry<SkillListItem[]>("/api/skills/internal", identity);
}

/** 仅走 Registry 的内部、按调用者过滤的技能详情接口。 */
export function fetchVisibleSkill(slug: string, identity: CallerIdentity): Promise<SkillDetail> {
  return requestRegistry<SkillDetail>(`/api/skills/internal/${encodeURIComponent(slug)}`, identity);
}

/** 仅在 get_skill_file 被调用时读取一个文件的 base64 正文。 */
export async function fetchVisibleSkillFile(
  slug: string,
  path: string,
  version: string,
  identity: CallerIdentity,
): Promise<SkillFile> {
  try {
    return await requestRegistry<SkillFile>(
      `/api/skills/internal/${encodeURIComponent(slug)}/file?version=${encodeURIComponent(version)}&path=${encodeURIComponent(path)}`,
      identity,
    );
  } catch (error) {
    if (error instanceof RegistryError && error.status === 404) {
      throw new RegistryError(404, `资源文件不存在：${path}`);
    }
    throw error;
  }
}

/** 埋点身份始终由可信请求头导出，不接受客户端传入 userId。 */
export async function reportEvent(
  slug: string,
  event: "view" | "invoke",
  identity: CallerIdentity,
  client = "mcp",
): Promise<void> {
  try {
    const res = await fetch(
      `${REGISTRY_URL}/api/skills/internal/${encodeURIComponent(slug)}/events`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-SkillHive-Internal-Token": getInternalToken(),
          "X-SkillHive-User-Id": identity.id,
          "X-SkillHive-Token-Id": identity.tokenId,
        },
        body: JSON.stringify({ event, client }),
        redirect: "error",
        signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      },
    );
    if (!res.ok) throw new RegistryError(res.status, "事件上报失败");
  } catch {
    // 埋点失败不能阻断工具或 prompt 的正常执行。
  }
}

/** 每条 SSE 消息前查询数据库中的 PAT 状态，撤销后立即阻止后续调用。 */
export async function validatePatSession(identity: CallerIdentity): Promise<boolean> {
  let res: Response;
  try {
    res = await fetch(`${REGISTRY_URL}/api/auth/validate-pat-session`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-SkillHive-Internal-Token": getInternalToken(),
      },
      body: JSON.stringify({ tokenId: identity.tokenId, userId: identity.id }),
      redirect: "error",
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
  } catch {
    return false;
  }
  if (!res.ok) return false;
  try {
    const json = (await res.json()) as { data?: { valid?: boolean } };
    return json.data?.valid === true;
  } catch {
    return false;
  }
}

/** Bearer PAT 只发送给内部解析端点；Registry 不会返回 PAT 明文。 */
export async function resolvePat(token: string): Promise<CallerIdentity | null> {
  try {
    const res = await fetch(`${REGISTRY_URL}/api/auth/resolve-pat`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-SkillHive-Internal-Token": getInternalToken(),
      },
      body: JSON.stringify({ token }),
      redirect: "error",
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = await parseJson<Partial<{ data: CallerIdentity }>>(res);
    const caller = json.data;
    if (
      !caller?.id ||
      !caller.email ||
      !caller.name ||
      !caller.tokenId ||
      !["admin", "publisher", "member"].includes(caller.role)
    ) {
      return null;
    }
    return caller;
  } catch {
    return null;
  }
}
