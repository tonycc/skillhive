import { shallowRef } from "vue";

/** Registry API 访问层（开发态经 Vite 代理到 Registry）。 */

export interface SkillCard {
  id: string;
  slug: string;
  name: string;
  summary: string;
  category: string;
  status: string;
}

export interface SkillDetail extends SkillCard {
  latestVersion: {
    version: string;
    changelog: string;
    body: string;
    /** 技能包资源清单；正文通过单文件端点按需读取。 */
    files: SkillFileManifest[];
  } | null;
  visibleDepartments: string[];
}

export interface SkillFileManifest {
  path: string;
  size: number;
}

export interface SkillFile extends SkillFileManifest {
  version: string;
  contentBase64: string;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "publisher" | "member";
  departmentId: string | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * 登录态只保存在内存中。会话凭证由 Registry 写入 HttpOnly Cookie，脚本不可读取，
 * 页面刷新后通过 /me 恢复用户资料。
 */
export const currentUser = shallowRef<AuthUser | null>(null);
let sessionChecked = false;
let sessionRequest: Promise<AuthUser | null> | null = null;
let sessionRequestForce = false;

// 清理旧版本曾写入浏览器的可读 JWT 与匿名投票标识。
try {
  localStorage.removeItem("skillhive-auth");
  localStorage.removeItem("skillhive-voter");
} catch {
  // 隐私模式下 localStorage 可能不可用，不影响 Cookie 会话。
}

function request(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path, { credentials: "same-origin", ...init });
}

async function responseError(res: Response, fallback: string): Promise<ApiError> {
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  return new ApiError(json.error ?? `${fallback}（${res.status}）`, res.status);
}

function handleUnauthorized(res: Response): void {
  if (res.status !== 401) return;
  currentUser.value = null;
  sessionChecked = true;
  if (location.pathname !== "/login") {
    const redirect = encodeURIComponent(location.pathname + location.search);
    location.assign(`/login?redirect=${redirect}`);
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await request(path);
  handleUnauthorized(res);
  if (!res.ok) throw await responseError(res, "请求失败");
  return (await res.json()) as T;
}

/** 在路由进入前恢复/校验 Cookie 会话；并发调用只发出一次请求。 */
export async function refreshSession(force = false): Promise<AuthUser | null> {
  if (sessionChecked && !force) return currentUser.value;
  if (sessionRequest) {
    const pending = await sessionRequest;
    if (!force || sessionRequestForce) return pending;
  }

  sessionRequestForce = force;
  sessionRequest = (async () => {
    try {
      const res = await request("/api/auth/me");
      if (!res.ok) {
        currentUser.value = null;
        sessionChecked = true;
        return null;
      }
      const json = (await res.json()) as {
        data?: AuthUser | { user?: AuthUser };
      };
      const data = json.data;
      if (data && "id" in data) {
        currentUser.value = data;
      } else {
        currentUser.value = data?.user ?? null;
      }
      return currentUser.value;
    } catch {
      // 网络故障不等于会话失效：已登录页面保留当前用户，由具体数据请求展示错误态。
      return currentUser.value;
    } finally {
      sessionRequest = null;
    }
  })();
  return sessionRequest;
}

export async function login(email: string, password: string): Promise<AuthUser> {
  const res = await request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    data?: { user: AuthUser };
    error?: string;
  };
  if (!res.ok || !json.data) {
    throw new ApiError(json.error ?? `登录失败（${res.status}）`, res.status);
  }
  currentUser.value = json.data.user;
  sessionChecked = true;
  return json.data.user;
}

export async function logout(): Promise<void> {
  const res = await request("/api/auth/logout", { method: "POST" });
  if (!res.ok && res.status !== 401) throw await responseError(res, "退出失败");
  currentUser.value = null;
  sessionChecked = true;
}

export async function fetchSkills(): Promise<SkillCard[]> {
  const json = await get<{ data: SkillCard[] }>("/api/skills");
  return json.data;
}

export async function fetchSkillDetail(slug: string): Promise<SkillDetail> {
  const json = await get<{ data: SkillDetail }>(`/api/skills/${encodeURIComponent(slug)}`);
  return json.data;
}

/** 只在用户选择预览时读取一个技能资源文件。 */
export async function fetchSkillFile(
  slug: string,
  path: string,
  version: string,
): Promise<SkillFile> {
  const query = new URLSearchParams({ version, path });
  const json = await get<{ data: SkillFile }>(
    `/api/skills/${encodeURIComponent(slug)}/file?${query.toString()}`,
  );
  return json.data;
}

export async function publishSkill(
  content: string,
  changelog: string,
  files: { path: string; contentBase64: string }[] = [],
): Promise<void> {
  const res = await request("/api/skills/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, changelog, files }),
  });
  handleUnauthorized(res);
  if (!res.ok) throw await responseError(res, "发布失败");
}

// ---------- 个人接入令牌（PAT） ----------

export interface PatInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

export async function fetchTokens(): Promise<PatInfo[]> {
  const json = await get<{ data: PatInfo[] }>("/api/auth/tokens");
  return json.data;
}

export async function createToken(name: string): Promise<{ id: string; token: string }> {
  const res = await request("/api/auth/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  handleUnauthorized(res);
  if (!res.ok) throw await responseError(res, "生成失败");
  const json = (await res.json()) as { data: { id: string; token: string } };
  return json.data;
}

export async function revokeToken(id: string): Promise<void> {
  const res = await request(`/api/auth/tokens/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  handleUnauthorized(res);
  if (!res.ok) throw await responseError(res, "吊销失败");
}

/** 埋点上报（失败不会打断主流程）。 */
export function reportEvent(
  slug: string,
  event: "view" | "favorite" | "rate",
  score?: number,
): void {
  void request(`/api/skills/${encodeURIComponent(slug)}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, client: "console", ...(score === undefined ? {} : { score }) }),
  }).then(handleUnauthorized).catch(() => undefined);
}

// ---------- 数据看板 ----------

export interface StatsOverview {
  publishedSkills: number;
  views: number;
  invokes: number;
  favorites: number;
  rates: number;
}

export interface SkillStats {
  slug: string;
  name: string;
  category: string;
  views: number;
  invokes: number;
  favorites: number;
  rates: number;
}

export interface TrendPoint {
  day: string;
  views: number;
  invokes: number;
  favorites: number;
  rates: number;
}

export async function fetchStatsOverview(): Promise<StatsOverview> {
  return (await get<{ data: StatsOverview }>("/api/stats/overview")).data;
}

export async function fetchSkillStats(): Promise<SkillStats[]> {
  return (await get<{ data: SkillStats[] }>("/api/stats/skills")).data;
}

export async function fetchTrend(days = 14): Promise<TrendPoint[]> {
  return (await get<{ data: TrendPoint[] }>(`/api/stats/trend?days=${days}`)).data;
}

// ---------- 需求许愿 ----------

export type RequestStatus = "open" | "planned" | "done" | "rejected";

export interface SkillRequest {
  id: string;
  title: string;
  description: string;
  status: RequestStatus;
  requesterName: string | null;
  votes: number;
  votedByMe: boolean;
  createdAt: string;
}

export async function fetchRequests(): Promise<SkillRequest[]> {
  return (await get<{ data: SkillRequest[] }>("/api/requests")).data;
}

export async function createRequest(input: {
  title: string;
  description: string;
}): Promise<void> {
  const res = await request("/api/requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  handleUnauthorized(res);
  if (!res.ok) throw await responseError(res, "提交失败");
}

export async function toggleVote(id: string): Promise<{ voted: boolean; votes: number }> {
  const res = await request(`/api/requests/${encodeURIComponent(id)}/vote`, {
    method: "POST",
  });
  handleUnauthorized(res);
  if (!res.ok) throw await responseError(res, "投票失败");
  const json = (await res.json()) as { data: { voted: boolean; votes: number } };
  return json.data;
}
