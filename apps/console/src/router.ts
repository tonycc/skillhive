import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import { refreshSession, type AuthUser } from "./api";

const HomeView = () => import("./views/HomeView.vue");
const SkillDetailView = () => import("./views/SkillDetailView.vue");
const StatsView = () => import("./views/StatsView.vue");
const PublishView = () => import("./views/PublishView.vue");
const RequestsView = () => import("./views/RequestsView.vue");
const SettingsView = () => import("./views/SettingsView.vue");
const LoginView = () => import("./views/LoginView.vue");
const ForbiddenView = () => import("./views/ForbiddenView.vue");

declare module "vue-router" {
  interface RouteMeta {
    title: string;
    roles?: AuthUser["role"][];
    public?: boolean;
  }
}

const routes: RouteRecordRaw[] = [
  { path: "/login", name: "login", component: LoginView, meta: { title: "登录", public: true } },
  { path: "/", name: "home", component: HomeView, meta: { title: "技能市场" } },
  {
    path: "/skills/:slug",
    name: "skill-detail",
    component: SkillDetailView,
    props: true,
    meta: { title: "技能详情" },
  },
  {
    path: "/stats",
    name: "stats",
    component: StatsView,
    meta: { title: "数据看板", roles: ["publisher", "admin"] },
  },
  {
    path: "/publish",
    name: "publish",
    component: PublishView,
    meta: { title: "发布技能", roles: ["publisher", "admin"] },
  },
  { path: "/requests", name: "requests", component: RequestsView, meta: { title: "许愿墙" } },
  { path: "/settings", name: "settings", component: SettingsView, meta: { title: "接入设置" } },
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
