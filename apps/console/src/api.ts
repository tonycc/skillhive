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
  } | null;
  visibleDepartments: string[];
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
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

/** 发布 skill（组装好的 SKILL.md 全文，需登录且具备 publisher/admin 角色） */
export async function publishSkill(content: string, changelog: string): Promise<void> {
  const auth = getAuth();
  const res = await fetch("/api/skills/publish", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${auth.token}` } : {}),
    },
    body: JSON.stringify({ content, changelog }),
  });
  if (!res.ok) {
    if (res.status === 401) clearAuth(); // 登录态失效，强制重新登录
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(json.error ?? `发布失败（${res.status}）`);
  }
}

/** 埋点上报（fire-and-forget） */
export function reportEvent(slug: string, event: "view" | "favorite" | "rate"): void {
  void fetch(`/api/skills/${slug}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input, voterToken: getVoterToken() }),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(json.error ?? `提交失败（${res.status}）`);
  }
}

export async function toggleVote(id: string): Promise<{ voted: boolean; votes: number }> {
  const res = await fetch(`/api/requests/${id}/vote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ voterToken: getVoterToken() }),
  });
  if (!res.ok) throw new Error(`投票失败（${res.status}）`);
  const json = (await res.json()) as { data: { voted: boolean; votes: number } };
  return json.data;
}
