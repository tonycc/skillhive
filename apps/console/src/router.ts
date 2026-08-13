import { createRouter, createWebHistory } from "vue-router";
import HomeView from "./views/HomeView.vue";
import SkillDetailView from "./views/SkillDetailView.vue";
import StatsView from "./views/StatsView.vue";
import PublishView from "./views/PublishView.vue";
import RequestsView from "./views/RequestsView.vue";
import SettingsView from "./views/SettingsView.vue";
import LoginView from "./views/LoginView.vue";
import { getAuth } from "./api";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", name: "login", component: LoginView },
    { path: "/", name: "home", component: HomeView },
    {
      path: "/skills/:slug",
      name: "skill-detail",
      component: SkillDetailView,
      props: true,
    },
    { path: "/stats", name: "stats", component: StatsView },
    { path: "/publish", name: "publish", component: PublishView },
    { path: "/requests", name: "requests", component: RequestsView },
    { path: "/settings", name: "settings", component: SettingsView },
  ],
});

/** 全局守卫：未登录访问任何页面一律跳登录页（登录后回跳原地址） */
router.beforeEach((to) => {
  if (to.name !== "login" && !getAuth()) {
    return { name: "login", query: { redirect: to.fullPath } };
  }
  // 已登录访问登录页则直接进首页
  if (to.name === "login" && getAuth()) {
    return { name: "home" };
  }
  return true;
});
