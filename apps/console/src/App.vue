<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { currentUser, logout } from "./api";
import { ElMessage } from "element-plus";

const route = useRoute();
const router = useRouter();

const isLoginPage = computed(() => route.name === "login");
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
      <router-link to="/" class="site-brand" aria-label="SkillHive 管理平台首页">
        🐝 SkillHive 管理平台
      </router-link>
      <nav class="site-nav" aria-label="主导航">
        <router-link to="/" :class="{ active: $route.name === 'home' }">
          Skill 管理
        </router-link>
        <router-link to="/applications" :class="{ active: String($route.name).includes('application') }">应用</router-link>
        <router-link to="/employees" :class="{ active: $route.name === 'employees' }">员工与令牌</router-link>
        <router-link to="/explorations" :class="{ active: $route.name === 'explorations' }">探索记录</router-link>
        <router-link to="/requirements" :class="{ active: $route.name === 'requirements' }">正式需求池</router-link>
        <router-link to="/stats" :class="{ active: $route.name === 'stats' }">数据看板</router-link>
        <router-link to="/settings" :class="{ active: $route.name === 'settings' }">WorkBuddy 连接器</router-link>
        <router-link to="/audit" :class="{ active: $route.name === 'audit' }">审计日志</router-link>
      </nav>
      <div v-if="currentUser" class="user-actions">
        <span>{{ currentUser.name }}（管理员）</span>
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
