<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { currentUser, logout } from "./api";
import { ElMessage } from "element-plus";

const route = useRoute();
const router = useRouter();

const isLoginPage = computed(() => route.name === "login");
const canPublish = computed(
  () => currentUser.value?.role === "publisher" || currentUser.value?.role === "admin",
);
const canViewStats = canPublish;
const loggingOut = ref(false);

async function onLogout(): Promise<void> {
  loggingOut.value = true;
  try {
    await logout();
    await router.push("/login");
  } catch (error) {
    ElMessage.error(`${(error as Error).message}；当前会话仍保持登录，请稍后重试`);
  } finally {
    loggingOut.value = false;
  }
}
</script>

<template>
  <div class="container">
    <header v-if="!isLoginPage" class="site-header">
      <router-link to="/" class="site-brand" aria-label="SkillHive 首页">
        🐝 SkillHive 技能蜂巢
      </router-link>
      <nav class="site-nav" aria-label="主导航">
        <router-link to="/" :class="{ active: $route.name === 'home' }">
          技能市场
        </router-link>
        <router-link
          v-if="canViewStats"
          to="/stats"
          :class="{ active: $route.name === 'stats' }"
        >
          数据看板
        </router-link>
        <router-link
          v-if="canPublish"
          to="/publish"
          :class="{ active: $route.name === 'publish' }"
        >
          发布技能
        </router-link>
        <router-link to="/requests" :class="{ active: $route.name === 'requests' }">
          许愿墙
        </router-link>
        <router-link to="/settings" :class="{ active: $route.name === 'settings' }">
          接入设置
        </router-link>
      </nav>
      <div v-if="currentUser" class="user-actions">
        <span>{{ currentUser.name }}（{{ currentUser.role }}）</span>
        <button
          type="button"
          class="link-button"
          :disabled="loggingOut"
          aria-label="退出当前账号"
          @click="onLogout"
        >
          退出
        </button>
      </div>
    </header>
    <router-view />
  </div>
</template>
