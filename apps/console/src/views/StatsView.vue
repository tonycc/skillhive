<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  fetchStatsOverview,
  fetchExplorationErrorStats,
  fetchSkillStats,
  fetchTrend,
  type ExplorationErrorStat,
  type StatsOverview,
  type SkillStats,
  type TrendPoint,
} from "../api";

const overview = ref<StatsOverview | null>(null);
const skillStats = ref<SkillStats[]>([]);
const trend = ref<TrendPoint[]>([]);
const explorationErrors = ref<ExplorationErrorStat[]>([]);
const loading = ref(true);
const loadFailed = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  loadFailed.value = false;
  try {
    [overview.value, skillStats.value, trend.value, explorationErrors.value] = await Promise.all([
      fetchStatsOverview(),
      fetchSkillStats(),
      fetchTrend(14),
      fetchExplorationErrorStats(14),
    ]);
  } catch {
    loadFailed.value = true;
  } finally {
    loading.value = false;
  }
}

onMounted(load);

/** 柱状图高度归一化（按最大调用数） */
const maxInvokes = computed(() =>
  Math.max(1, ...trend.value.map((t) => t.invokes)),
);
</script>

<template>
  <p class="page-description">分别查看需求探索的持久化结果和技能读取趋势；工具调用量不等于保存或提交成功。</p>
  <el-skeleton v-if="loading" :rows="6" animated />

  <el-empty
    v-else-if="loadFailed || !overview"
    description="统计数据加载失败，请稍后重试"
  >
    <el-button type="primary" @click="load">重新加载</el-button>
  </el-empty>

  <template v-else>
    <!-- 概览数字卡片 -->
    <el-row :gutter="16">
      <el-col :xs="24" :sm="12" :md="6">
        <div class="stat-card">
          <div class="stat-value">{{ overview.publishedSkills }}</div>
          <div class="stat-label">已发布技能</div>
        </div>
      </el-col>
      <el-col :xs="24" :sm="12" :md="6">
        <div class="stat-card">
          <div class="stat-value">{{ overview.invokes }}</div>
          <div class="stat-label">总调用次数</div>
        </div>
      </el-col>
      <el-col :xs="24" :sm="12" :md="6">
        <div class="stat-card">
          <div class="stat-value">{{ overview.views }}</div>
          <div class="stat-label">总浏览次数</div>
        </div>
      </el-col>
      <el-col :xs="24" :sm="12" :md="6">
        <div class="stat-card">
          <div class="stat-value">{{ overview.favorites }}</div>
          <div class="stat-label">收藏次数</div>
        </div>
      </el-col>
    </el-row>
    <h2 class="category-title">需求探索闭环</h2>
    <el-row :gutter="16">
      <el-col :xs="24" :sm="12" :md="6"><div class="stat-card"><div class="stat-value">{{ overview.explorationsStarted }}</div><div class="stat-label">成功启动探索</div></div></el-col>
      <el-col :xs="24" :sm="12" :md="6"><div class="stat-card"><div class="stat-value">{{ overview.draftsSaved }}</div><div class="stat-label">持久化草稿修订</div></div></el-col>
      <el-col :xs="24" :sm="12" :md="6"><div class="stat-card"><div class="stat-value">{{ overview.requirementsSubmitted }}</div><div class="stat-label">已进入需求池</div></div></el-col>
      <el-col :xs="24" :sm="12" :md="6"><div class="stat-card"><div class="stat-value">{{ Math.round(overview.completionRate * 100) }}%</div><div class="stat-label">探索提交率（待补充 {{ overview.needsInformation }}）</div></div></el-col>
    </el-row>

    <!-- 近 14 天调用趋势 -->
    <h2 class="category-title">近 14 天调用趋势</h2>
    <div class="trend-chart-wrap">
      <div
        class="trend-chart"
        role="img"
        :aria-label="`近 14 天调用趋势，共 ${trend.reduce((sum, item) => sum + item.invokes, 0)} 次调用`"
      >
        <div v-for="t in trend" :key="t.day" class="trend-item">
          <div
            class="trend-bar"
            :style="{ height: `${Math.round((t.invokes / maxInvokes) * 100)}%` }"
            :title="`${t.day}：调用 ${t.invokes} 次 / 浏览 ${t.views} 次`"
            aria-hidden="true"
          />
          <span class="trend-day" :aria-label="`${t.day}，调用 ${t.invokes} 次`">{{ t.day.slice(5) }}</span>
        </div>
      </div>
    </div>

    <h2 class="category-title">近 14 天需求探索错误</h2>
    <el-empty v-if="explorationErrors.length === 0" description="近 14 天没有记录到需求探索错误" />
    <el-table v-else :data="explorationErrors" style="width: 100%">
      <el-table-column prop="code" label="错误码" min-width="240" />
      <el-table-column prop="count" label="次数" sortable width="120" />
      <el-table-column label="最近发生" width="200">
        <template #default="{ row }">{{ row.lastOccurredAt ? new Date(row.lastOccurredAt).toLocaleString("zh-CN") : "—" }}</template>
      </el-table-column>
    </el-table>

    <!-- 按技能统计 -->
    <h2 class="category-title">技能使用排行</h2>
    <el-empty v-if="skillStats.length === 0" description="暂无技能使用数据" />
    <el-table v-else :data="skillStats" style="width: 100%">
      <el-table-column prop="name" label="技能" min-width="180">
        <template #default="{ row }">
          <router-link :to="`/skills/${encodeURIComponent(row.slug)}`">{{ row.name }}</router-link>
          <el-tag size="small" effect="plain" style="margin-left: 8px">{{
            row.category
          }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="invokes" label="调用" sortable width="110" />
      <el-table-column prop="views" label="浏览" sortable width="110" />
      <el-table-column prop="favorites" label="收藏" sortable width="110" />
      <el-table-column label="转化率" width="120">
        <template #default="{ row }">
          {{ row.views > 0 ? `${Math.round((row.invokes / row.views) * 100)}%` : "-" }}
        </template>
      </el-table-column>
    </el-table>
  </template>
</template>
