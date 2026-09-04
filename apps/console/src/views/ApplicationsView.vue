<script setup lang="ts">
import { onMounted, ref } from "vue";
import { fetchApplications, type ApplicationSummary } from "../api";

const applications = ref<ApplicationSummary[]>([]);
const loading = ref(true);
const loadError = ref("");

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = "";
  try {
    applications.value = await fetchApplications();
  } catch (error) {
    loadError.value = (error as Error).message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <main class="page-shell">
    <section class="page-heading">
      <div>
        <p>管理带有固定业务流程、数据模型和 MCP 工具的企业应用。</p>
      </div>
    </section>
    <el-alert v-if="loadError" :title="loadError" type="error" show-icon :closable="false">
      <template #default><el-button link type="primary" @click="load">重试</el-button></template>
    </el-alert>
    <el-skeleton v-if="loading" :rows="5" animated />
    <el-empty v-else-if="applications.length === 0 && !loadError" description="暂无应用" />
    <div v-else class="card-grid application-grid">
      <router-link
        v-for="application in applications"
        :key="application.key"
        :to="`/applications/${application.key}`"
        class="skill-card application-card"
      >
        <div class="application-title">
          <span class="name">{{ application.name }}</span>
          <el-tag size="small" effect="plain">内置应用</el-tag>
          <el-tag size="small" :type="application.enabled ? 'success' : 'info'">
            {{ application.enabled ? '运行中' : '已停用' }}
          </el-tag>
        </div>
        <p class="summary">{{ application.description }}</p>
        <p class="application-meta">
          {{ application.initialized ? `当前激活：${application.activeVersion ?? '未激活'}` : '内置规则尚未初始化' }}
        </p>
      </router-link>
    </div>
  </main>
</template>

<style scoped>
.application-grid { width: 100%; }
.application-card { display: block; }
.application-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.application-meta { margin: 12px 0 0; color: var(--text-secondary); font-size: 13px; }
</style>
