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
