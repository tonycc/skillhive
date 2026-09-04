<script setup lang="ts">
import { onMounted, ref } from "vue";
import {
  fetchWorkBuddyConnectorInfo,
  type WorkBuddyConnectorInfo,
} from "../api";

const loading = ref(false);
const loadError = ref("");
const connector = ref<WorkBuddyConnectorInfo | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = "";
  try {
    connector.value = await fetchWorkBuddyConnectorInfo();
  } catch (error) {
    loadError.value = (error as Error).message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function reviewStatusLabel(value: string): string {
  return ({
    not_submitted: "待提交",
    submitted: "审核中",
    approved: "已通过",
    rejected: "未通过",
    paused: "已暂停",
  } as Record<string, string>)[value] ?? value;
}

function environmentLabel(value: string): string {
  return ({ production: "生产", test: "测试", development: "开发", unconfigured: "未配置" } as Record<string, string>)[value] ?? value;
}

function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleString("zh-CN") : "尚未记录";
}
</script>

<template>
  <main class="page-shell">
    <section class="page-heading">
      <div>
        <p>查看官方连接器的企业地址、构建、联调和平台发布状态。需求探索规则请在“应用”中管理。</p>
      </div>
    </section>
    <el-alert v-if="loadError" :title="loadError" type="error" show-icon :closable="false">
      <template #default><el-button link type="primary" @click="load">重试</el-button></template>
    </el-alert>
    <el-card v-loading="loading" shadow="never" class="content-card">
      <template #header><strong>WorkBuddy 官方连接器</strong></template>
      <template v-if="connector">
        <el-alert
          v-if="connector.configurationIssues.length"
          :title="connector.configurationIssues.join('；')"
          type="warning"
          show-icon
          :closable="false"
          style="margin-bottom: 16px"
        />
        <el-alert
          v-if="connector.launchIssues.length"
          title="尚未达到全员发布条件"
          :description="connector.launchIssues.join('；')"
          type="info"
          show-icon
          :closable="false"
          style="margin-bottom: 16px"
        />
        <el-descriptions :column="2" border>
          <el-descriptions-item label="Source">{{ connector.source }}</el-descriptions-item>
          <el-descriptions-item label="包版本">{{ connector.packageVersion }}</el-descriptions-item>
          <el-descriptions-item label="企业 MCP 地址">{{ connector.mcpUrl || '待 IT 配置' }}</el-descriptions-item>
          <el-descriptions-item label="部署环境">{{ environmentLabel(connector.environment) }}</el-descriptions-item>
          <el-descriptions-item label="最低 WorkBuddy 版本">{{ connector.minClientVersion }}</el-descriptions-item>
          <el-descriptions-item label="服务端协议">{{ connector.protocolVersion }}</el-descriptions-item>
          <el-descriptions-item label="平台审核状态">{{ reviewStatusLabel(connector.reviewStatus) }}</el-descriptions-item>
          <el-descriptions-item label="正式市场入口">
            <a v-if="connector.marketUrl" :href="connector.marketUrl" target="_blank" rel="noopener noreferrer">打开入口</a>
            <span v-else>待审核通过</span>
          </el-descriptions-item>
          <el-descriptions-item label="最近实测客户端">{{ connector.verifiedClientVersion || '尚未记录' }}</el-descriptions-item>
          <el-descriptions-item label="实测操作系统">{{ connector.verifiedOs || '尚未记录' }}</el-descriptions-item>
          <el-descriptions-item label="最近实测时间">{{ formatTime(connector.verifiedAt) }}</el-descriptions-item>
          <el-descriptions-item label="正式包构建条件">
            <el-tag :type="connector.readyForPackageBuild ? 'success' : 'warning'">
              {{ connector.readyForPackageBuild ? '地址已就绪' : '地址未就绪' }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="真实客户端联调条件">
            <el-tag :type="connector.readyForClientTest ? 'success' : 'warning'">
              {{ connector.readyForClientTest ? '可以开始联调' : '配置未就绪' }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="全员发布条件">
            <el-tag :type="connector.readyForLaunch ? 'success' : 'warning'">
              {{ connector.readyForLaunch ? '仓库侧证据已齐' : `仍缺 ${connector.launchIssues.length} 项` }}
            </el-tag>
          </el-descriptions-item>
        </el-descriptions>
      </template>
      <el-empty v-else-if="!loading && !loadError" description="暂无连接器配置" />
    </el-card>
  </main>
</template>
