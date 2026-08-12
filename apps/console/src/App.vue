<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { getAuth, clearAuth } from "./api";

const route = useRoute();
const router = useRouter();

// 依赖 route.fullPath 触发重算：登录/退出跳转后自动刷新显示
const auth = computed(() => {
  void route.fullPath;
  return getAuth();
});
const isLoginPage = computed(() => route.name === "login");

function onLogout(): void {
  clearAuth();
  router.push("/login");
}
</script>

<template>
  <div class="container">
    <header v-if="!isLoginPage" class="site-header">
      <h1>🐝 SkillHive 技能蜂巢</h1>
      <nav class="site-nav">
        <router-link to="/" :class="{ active: $route.name === 'home' }">
          技能市场
        </router-link>
        <router-link to="/stats" :class="{ active: $route.name === 'stats' }">
          数据看板
        </router-link>
        <router-link to="/publish" :class="{ active: $route.name === 'publish' }">
          发布技能
        </router-link>
        <router-link to="/requests" :class="{ active: $route.name === 'requests' }">
          许愿墙
        </router-link>
      </nav>
      <div v-if="auth" style="margin-left: auto; font-size: 13px; color: var(--text-secondary)">
        {{ auth.user.name }}（{{ auth.user.role }}）
        <a
          href="javascript:void(0)"
          style="margin-left: 8px; color: var(--el-color-primary)"
          @click="onLogout"
        >
          退出
        </a>
      </div>
    </header>
    <router-view />
  </div>
</template>
