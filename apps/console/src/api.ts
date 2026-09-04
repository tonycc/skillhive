import { shallowRef } from "vue";

/** Registry API 访问层（开发态经 Vite 代理到 Registry）。 */

export interface SkillCard {
  id: string;
  slug: string;
  name: string;
  summary: string;
  category: string;
  status: string;
  skillType: "ordinary" | "application";
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

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

function withQuery(path: string, input: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
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
  skillType: "ordinary" | "application" = "ordinary",
): Promise<void> {
  const res = await request("/api/skills/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, changelog, files, skillType }),
  });
  handleUnauthorized(res);
  if (!res.ok) throw await responseError(res, "发布失败");
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
  explorationsStarted: number;
  draftsSaved: number;
  requirementsSubmitted: number;
  needsInformation: number;
  completionRate: number;
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

// ---------- 管理员：员工连接器身份 ----------

export type EmployeeStatus = "active" | "disabled";
export interface EmployeeInfo {
  id: string;
  phone: string | null;
  name: string;
  email: string | null;
  departmentId: string | null;
  departmentName: string | null;
  status: EmployeeStatus;
  activeTokens: number;
  lastConnectedAt: string | null;
  updatedAt: string;
}

export interface DepartmentInfo { id: string; name: string }
export async function fetchDepartments(): Promise<DepartmentInfo[]> {
  return (await get<{ data: DepartmentInfo[] }>("/api/admin/employees/departments")).data;
}

export async function fetchEmployees(input: {
  keyword?: string;
  status?: EmployeeStatus;
  departmentId?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<PageResult<EmployeeInfo>> {
  const path = withQuery("/api/admin/employees", input);
  return (await get<{ data: PageResult<EmployeeInfo> }>(path)).data;
}

export async function createEmployee(input: {
  phone: string;
  name: string;
  email?: string | null;
  departmentId?: string | null;
}): Promise<EmployeeInfo> {
  const res = await request("/api/admin/employees", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  handleUnauthorized(res);
  if (!res.ok) throw await responseError(res, "创建员工失败");
  return ((await res.json()) as { data: EmployeeInfo }).data;
}

export async function updateEmployee(
  id: string,
  input: Partial<{ phone: string; name: string; email: string | null; departmentId: string | null; status: EmployeeStatus }>,
): Promise<void> {
  const res = await request(`/api/admin/employees/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  handleUnauthorized(res);
  if (!res.ok) throw await responseError(res, "更新员工失败");
}

export async function createEmployeeToken(
  id: string,
  input: { name: string; expiresInDays: number },
): Promise<{ id: string; token: string; expiresAt: string; scopes: string[] }> {
  const res = await request(`/api/admin/employees/${encodeURIComponent(id)}/tokens`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  handleUnauthorized(res);
  if (!res.ok) throw await responseError(res, "发放令牌失败");
  return ((await res.json()) as { data: { id: string; token: string; expiresAt: string; scopes: string[] } }).data;
}

export interface EmployeeTokenInfo {
  id: string;
  name: string;
  scopes: string[];
  expiresAt: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export async function fetchEmployeeTokens(id: string): Promise<EmployeeTokenInfo[]> {
  return (await get<{ data: EmployeeTokenInfo[] }>(`/api/admin/employees/${encodeURIComponent(id)}/tokens`)).data;
}

export async function revokeEmployeeToken(employeeId: string, tokenId: string): Promise<void> {
  const res = await request(`/api/admin/employees/${encodeURIComponent(employeeId)}/tokens/${encodeURIComponent(tokenId)}`, { method: "DELETE" });
  handleUnauthorized(res);
  if (!res.ok) throw await responseError(res, "吊销员工令牌失败");
}

// ---------- 管理员：探索记录与正式需求 ----------

export interface ExplorationListItem {
  id: string;
  number: string;
  title: string;
  state: "discussing" | "submitted" | "editing" | "abandoned";
  currentRevision: number;
  lastSubmittedRevision: number | null;
  updatedAt: string;
  employeePhone: string | null;
  employeeName: string;
  departmentName: string | null;
  skillVersion: string | null;
  reviewStatus: RequirementStatus | null;
  requirementNumber: string | null;
}

export type RequirementStatus =
  | "pending_review" | "needs_information" | "in_review"
  | "accepted" | "deferred" | "rejected";

export interface ExplorationContent {
  title: string;
  problemDescription?: string;
  targetUsers?: string;
  currentProcess?: string;
  painAndEvidence: Array<{
    pain: string;
    evidence?: string;
    evidenceStatus: "employee_statement" | "to_verify";
  }>;
  objectivesAndBenefits?: string;
  scope?: string;
  nonGoals?: string;
  acceptanceCriteria: string[];
  constraintsAndRisks: string[];
  pendingQuestions: string[];
  summary?: string;
}

export interface ExplorationRevision {
  revision: number;
  content: ExplorationContent;
  createdAt: string;
}

export interface ExplorationAdminDetail {
  id: string;
  number: string;
  title: string;
  state: ExplorationListItem["state"];
  currentRevision: number;
  activeRevision: number;
  lastSubmittedRevision: number | null;
  updatedAt: string;
  skillVersion: string | null;
  reviewStatus: RequirementStatus | null;
  publicFeedback: string | null;
  requirementNumber: string | null;
  activeContent: ExplorationContent | null;
  revisions: ExplorationRevision[];
  ruleSnapshot: {
    slug?: string;
    version?: string;
    content?: string;
    resources: Array<{ path: string; size: number }>;
  } | null;
  employee: {
    id: string;
    phone: string | null;
    name: string;
    email: string | null;
    departmentId: string | null;
    status: EmployeeStatus;
  } | null;
}

export async function fetchExplorations(input: {
  keyword?: string;
  state?: ExplorationListItem["state"];
  employee?: string;
  departmentId?: string;
  skillVersion?: string;
  updatedFrom?: string;
  updatedTo?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<PageResult<ExplorationListItem>> {
  const path = withQuery("/api/admin/explorations", input);
  return (await get<{ data: PageResult<ExplorationListItem> }>(path)).data;
}

export async function fetchExplorationAdmin(id: string): Promise<ExplorationAdminDetail> {
  return (await get<{ data: ExplorationAdminDetail }>(`/api/admin/explorations/${encodeURIComponent(id)}`)).data;
}

export interface RequirementListItem {
  id: string;
  number: string;
  reviewStatus: RequirementStatus;
  currentSubmission: number;
  reviewRevision: number;
  publicFeedback: string | null;
  updatedAt: string;
  submittedAt: string;
  explorationId: string;
  explorationNumber: string;
  explorationState: ExplorationListItem["state"];
  title: string;
  submittedRevision: number;
  currentRevision: number;
  hasUnsubmittedChanges: boolean;
  employeePhone: string | null;
  employeeName: string;
  departmentName: string | null;
  skillVersion: string | null;
}

export interface RequirementSubmission {
  id: string;
  submission: number;
  submittedAt: string;
  revision: number;
  content: ExplorationContent;
}

export interface RequirementReview {
  id: string;
  submission: number;
  reviewRevision: number;
  status: RequirementStatus;
  publicFeedback: string | null;
  internalNote: string | null;
  reviewedBy: string;
  reviewerName: string | null;
  createdAt: string;
}

export interface RequirementAdminDetail {
  id: string;
  number: string;
  reviewStatus: RequirementStatus;
  currentSubmission: number;
  reviewRevision: number;
  publicFeedback: string | null;
  internalNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  explorationId: string;
  explorationNumber: string;
  title: string;
  explorationState: ExplorationListItem["state"];
  currentRevision: number;
  submittedRevision: number | null;
  employeeId: string;
  employeePhone: string | null;
  employeeName: string;
  departmentName: string | null;
  skillVersion: string | null;
  hasUnsubmittedChanges: boolean;
  submissions: RequirementSubmission[];
  reviews: RequirementReview[];
}

export async function fetchRequirements(input: {
  keyword?: string;
  reviewStatus?: RequirementStatus;
  employee?: string;
  departmentId?: string;
  skillVersion?: string;
  submittedFrom?: string;
  submittedTo?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<PageResult<RequirementListItem>> {
  const path = withQuery("/api/admin/requirements", input);
  return (await get<{ data: PageResult<RequirementListItem> }>(path)).data;
}

export async function fetchRequirementAdmin(id: string): Promise<RequirementAdminDetail> {
  return (await get<{ data: RequirementAdminDetail }>(`/api/admin/requirements/${encodeURIComponent(id)}`)).data;
}

export async function reviewRequirement(id: string, input: {
  expectedRevision: number;
  expectedSubmission: number;
  status: RequirementStatus;
  publicFeedback: string | null;
  internalNote: string | null;
}): Promise<void> {
  const res = await request(`/api/admin/requirements/${encodeURIComponent(id)}/review`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  handleUnauthorized(res);
  if (!res.ok) throw await responseError(res, "保存评审失败");
}

export interface ExplorationPolicy {
  key: string;
  skillId: string | null;
  skillVersionId: string | null;
  enabled: boolean;
  blockedSkillVersionIds: string[];
  updatedAt: string;
}

export interface ExplorationPolicyOption {
  skillId: string;
  slug: string;
  skillName: string;
  skillVersionId: string;
  version: string;
  publishedAt: string;
}

export interface WorkBuddyConnectorInfo {
  source: string;
  packageVersion: string;
  minClientVersion: string;
  protocolVersion: string;
  mcpUrl: string | null;
  environment: string;
  reviewStatus: string;
  marketUrl: string | null;
  verifiedClientVersion: string | null;
  verifiedOs: string | null;
  verifiedAt: string | null;
  readyForPackageBuild: boolean;
  readyForClientTest: boolean;
  readyForLaunch: boolean;
  packageIssues: string[];
  clientTestIssues: string[];
  launchIssues: string[];
  configurationIssues: string[];
}

export async function fetchExplorationPolicy(): Promise<ExplorationPolicy | null> {
  return (await get<{ data: ExplorationPolicy | null }>("/api/admin/explorations/policy")).data;
}

export async function fetchExplorationPolicyOptions(): Promise<ExplorationPolicyOption[]> {
  return (await get<{ data: ExplorationPolicyOption[] }>("/api/admin/explorations/policy/options")).data;
}

export async function fetchWorkBuddyConnectorInfo(): Promise<WorkBuddyConnectorInfo> {
  return (await get<{ data: WorkBuddyConnectorInfo }>("/api/admin/explorations/connector")).data;
}

export async function updateExplorationPolicy(input: {
  skillId: string;
  skillVersionId: string;
  blockedSkillVersionIds: string[];
  enabled: boolean;
}): Promise<void> {
  const res = await request("/api/admin/explorations/policy", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  handleUnauthorized(res);
  if (!res.ok) throw await responseError(res, "更新探索规则失败");
}

export interface ApplicationSummary {
  key: "requirement-exploration";
  name: string;
  description: string;
  type: "built_in";
  initialized: boolean;
  enabled: boolean;
  activeVersion: string | null;
}

export interface RequirementExplorationApplication extends Omit<ApplicationSummary, "enabled" | "activeVersion"> {
  skill: {
    id: string;
    slug: string;
    latestVersion: {
      id: string;
      version: string;
      description: string;
      body: string;
      changelog: string;
      publishedAt: string;
      files: SkillFileManifest[];
    } | null;
    versions: Array<{
      id: string;
      version: string;
      changelog: string;
      publishedAt: string;
    }>;
  } | null;
  policy: ExplorationPolicy | null;
}

export async function fetchApplications(): Promise<ApplicationSummary[]> {
  return (await get<{ data: ApplicationSummary[] }>("/api/admin/applications")).data;
}

export async function fetchRequirementExplorationApplication(): Promise<RequirementExplorationApplication> {
  return (await get<{ data: RequirementExplorationApplication }>(
    "/api/admin/applications/requirement-exploration",
  )).data;
}

export async function initializeRequirementExplorationSkill(): Promise<RequirementExplorationApplication> {
  const res = await request("/api/admin/applications/requirement-exploration/initialize", {
    method: "POST",
  });
  handleUnauthorized(res);
  if (!res.ok) throw await responseError(res, "初始化内置规则失败");
  return ((await res.json()) as { data: RequirementExplorationApplication }).data;
}

export interface AuditEvent {
  id: string;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  explorationId: string | null;
  requirementId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ExplorationErrorStat {
  code: string;
  count: number;
  lastOccurredAt: string | null;
}

export async function fetchExplorationErrorStats(days = 14): Promise<ExplorationErrorStat[]> {
  return (await get<{ data: ExplorationErrorStat[] }>(
    `/api/stats/exploration-errors?days=${encodeURIComponent(String(days))}`,
  )).data;
}

export async function fetchAuditEvents(input: {
  keyword?: string;
  actorType?: "admin" | "employee" | "system";
  action?: string;
  createdFrom?: string;
  createdTo?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<PageResult<AuditEvent>> {
  const path = withQuery("/api/admin/audit", input);
  return (await get<{ data: PageResult<AuditEvent> }>(path)).data;
}
