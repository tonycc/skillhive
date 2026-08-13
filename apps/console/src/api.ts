/** Registry API 访问层（开发态经 Vite 代理到 Registry） */

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
    /** 技能包资源文件（scripts/ references/ assets/） */
    files: { path: string; contentBase64: string; size: number }[];
  } | null;
  visibleDepartments: string[];
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: authHeaders() });
  handleUnauthorized(res);
  if (!res.ok) throw new Error(`请求失败：${res.status}`);
  return (await res.json()) as T;
}

export async function fetchSkills(): Promise<SkillCard[]> {
  const json = await get<{ data: SkillCard[] }>("/api/skills");
  return json.data;
}

export async function fetchSkillDetail(slug: string): Promise<SkillDetail> {
  const json = await get<{ data: SkillDetail }>(`/api/skills/${slug}`);
  return json.data;
}

// ---------- 登录态（localStorage 持久化，7 天有效） ----------

const AUTH_KEY = "skillhive-auth";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "publisher" | "member";
}

export function getAuth(): { token: string; user: AuthUser } | null {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    return raw ? (JSON.parse(raw) as { token: string; user: AuthUser }) : null;
  } catch {
    return null;
  }
}

export function clearAuth(): void {
  localStorage.removeItem(AUTH_KEY);
}

/** 构造带登录态的请求头（未登录为空对象） */
function authHeaders(): Record<string, string> {
  const auth = getAuth();
  return auth ? { Authorization: `Bearer ${auth.token}` } : {};
}

/** 401 统一处理：清除失效登录态并跳转登录页（带上回跳地址） */
function handleUnauthorized(res: Response): void {
  if (res.status === 401 && location.pathname !== "/login") {
    clearAuth();
    const redirect = encodeURIComponent(location.pathname + location.search);
    location.href = `/login?redirect=${redirect}`;
  }
}

/** 邮箱 + 密码登录，成功则保存登录态并返回用户 */
export async function login(email: string, password: string): Promise<AuthUser> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    data?: { token: string; user: AuthUser };
    error?: string;
  };
  if (!res.ok || !json.data) throw new Error(json.error ?? `登录失败（${res.status}）`);
  localStorage.setItem(AUTH_KEY, JSON.stringify(json.data));
  return json.data.user;
}

/** 发布 skill（SKILL.md 全文 + 可选资源文件，需登录且具备 publisher/admin 角色） */
export async function publishSkill(
  content: string,
  changelog: string,
  files: { path: string; contentBase64: string }[] = [],
): Promise<void> {
  const auth = getAuth();
  const res = await fetch("/api/skills/publish", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${auth.token}` } : {}),
    },
    body: JSON.stringify({ content, changelog, files }),
  });
  if (!res.ok) {
    handleUnauthorized(res); // 401 时清除登录态并跳登录页
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(json.error ?? `发布失败（${res.status}）`);
  }
}

// ---------- 个人接入令牌（PAT） ----------

export interface PatInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

/** 列出我的接入令牌 */
export async function fetchTokens(): Promise<PatInfo[]> {
  const json = await get<{ data: PatInfo[] }>("/api/auth/tokens");
  return json.data;
}

/** 生成接入令牌（明文仅此一次返回） */
export async function createToken(name: string): Promise<{ id: string; token: string }> {
  const res = await fetch("/api/auth/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ name }),
  });
  handleUnauthorized(res);
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(json.error ?? `生成失败（${res.status}）`);
  }
  const json = (await res.json()) as { data: { id: string; token: string } };
  return json.data;
}

/** 吊销接入令牌 */
export async function revokeToken(id: string): Promise<void> {
  const res = await fetch(`/api/auth/tokens/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  handleUnauthorized(res);
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(json.error ?? `吊销失败（${res.status}）`);
  }
}

/** 埋点上报（fire-and-forget） */
export function reportEvent(slug: string, event: "view" | "favorite" | "rate"): void {
  void fetch(`/api/skills/${slug}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ event, client: "console" }),
  }).catch(() => {});
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
  const json = await get<{ data: StatsOverview }>("/api/stats/overview");
  return json.data;
}

export async function fetchSkillStats(): Promise<SkillStats[]> {
  const json = await get<{ data: SkillStats[] }>("/api/stats/skills");
  return json.data;
}

export async function fetchTrend(days = 14): Promise<TrendPoint[]> {
  const json = await get<{ data: TrendPoint[] }>(`/api/stats/trend?days=${days}`);
  return json.data;
}

// ---------- 需求许愿 ----------

/** 浏览器指纹令牌（无登录体系的过渡方案，存 localStorage） */
export function getVoterToken(): string {
  let token = localStorage.getItem("skillhive-voter");
  if (!token) {
    token = crypto.randomUUID();
    localStorage.setItem("skillhive-voter", token);
  }
  return token;
}

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
  const json = await get<{ data: SkillRequest[] }>(
    `/api/requests?voterToken=${getVoterToken()}`,
  );
  return json.data;
}

export async function createRequest(input: {
  title: string;
  description: string;
  nickname: string;
}): Promise<void> {
  const res = await fetch("/api/requests", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ ...input, voterToken: getVoterToken() }),
  });
  handleUnauthorized(res);
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(json.error ?? `提交失败（${res.status}）`);
  }
}

export async function toggleVote(id: string): Promise<{ voted: boolean; votes: number }> {
  const res = await fetch(`/api/requests/${id}/vote`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ voterToken: getVoterToken() }),
  });
  handleUnauthorized(res);
  if (!res.ok) throw new Error(`投票失败（${res.status}）`);
  const json = (await res.json()) as { data: { voted: boolean; votes: number } };
  return json.data;
}
