import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import { refreshSession, type AuthUser } from "./api";

const HomeView = () => import("./views/HomeView.vue");
const SkillDetailView = () => import("./views/SkillDetailView.vue");
const StatsView = () => import("./views/StatsView.vue");
const RequestsView = () => import("./views/RequestsView.vue");
const SettingsView = () => import("./views/SettingsView.vue");
const LoginView = () => import("./views/LoginView.vue");
const ForbiddenView = () => import("./views/ForbiddenView.vue");
const EmployeesView = () => import("./views/EmployeesView.vue");
const ExplorationsView = () => import("./views/ExplorationsView.vue");
const RequirementsView = () => import("./views/RequirementsView.vue");
const AuditView = () => import("./views/AuditView.vue");
const ApplicationsView = () => import("./views/ApplicationsView.vue");
const RequirementExplorationAppView = () => import("./views/RequirementExplorationAppView.vue");

declare module "vue-router" {
  interface RouteMeta {
    title: string;
    roles?: AuthUser["role"][];
    public?: boolean;
  }
}

const routes: RouteRecordRaw[] = [
  { path: "/login", name: "login", component: LoginView, meta: { title: "登录", public: true } },
  { path: "/", name: "home", component: HomeView, meta: { title: "Skill 管理", roles: ["admin"] } },
  {
    path: "/skills/:slug",
    name: "skill-detail",
    component: SkillDetailView,
    props: true,
    meta: { title: "技能详情", roles: ["admin"] },
  },
  {
    path: "/stats",
    name: "stats",
    component: StatsView,
    meta: { title: "数据看板", roles: ["admin"] },
  },
  { path: "/publish", redirect: { name: "home", query: { tab: "publish" } } },
  { path: "/employees", name: "employees", component: EmployeesView, meta: { title: "员工与令牌", roles: ["admin"] } },
  { path: "/applications", name: "applications", component: ApplicationsView, meta: { title: "应用", roles: ["admin"] } },
  {
    path: "/applications/requirement-exploration",
    name: "requirement-exploration-application",
    component: RequirementExplorationAppView,
    meta: { title: "需求探索应用", roles: ["admin"] },
  },
  { path: "/explorations", name: "explorations", component: ExplorationsView, meta: { title: "探索记录", roles: ["admin"] } },
  { path: "/requirements", name: "requirements", component: RequirementsView, meta: { title: "正式需求池", roles: ["admin"] } },
  { path: "/audit", name: "audit", component: AuditView, meta: { title: "审计日志", roles: ["admin"] } },
  { path: "/requests", name: "requests", component: RequestsView, meta: { title: "历史许愿", roles: ["admin"] } },
  { path: "/settings", name: "settings", component: SettingsView, meta: { title: "WorkBuddy 连接器", roles: ["admin"] } },
  { path: "/forbidden", name: "forbidden", component: ForbiddenView, meta: { title: "无访问权限" } },
  { path: "/:pathMatch(.*)*", redirect: "/" },
];

export const router = createRouter({ history: createWebHistory(), routes });

router.beforeEach(async (to) => {
  // 首次导航从服务端恢复 Cookie 会话；受限路由再强制刷新角色。
  const user = await refreshSession(Boolean(to.meta.roles));
  if (!to.meta.public && !user) {
    return { name: "login", query: { redirect: to.fullPath } };
  }
  if (to.name === "login" && user) return { name: "home" };
  if (user && to.meta.roles && !to.meta.roles.includes(user.role)) {
    return { name: "forbidden" };
  }
  return true;
});

router.afterEach((to) => {
  document.title = `${to.meta.title} · SkillHive`;
});
