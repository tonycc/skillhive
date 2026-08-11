import { createRouter, createWebHistory } from "vue-router";
import HomeView from "./views/HomeView.vue";
import SkillDetailView from "./views/SkillDetailView.vue";
import StatsView from "./views/StatsView.vue";
import PublishView from "./views/PublishView.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "home", component: HomeView },
    {
      path: "/skills/:slug",
      name: "skill-detail",
      component: SkillDetailView,
      props: true,
    },
    { path: "/stats", name: "stats", component: StatsView },
    { path: "/publish", name: "publish", component: PublishView },
  ],
});
