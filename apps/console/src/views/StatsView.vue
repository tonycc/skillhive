<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  fetchStatsOverview,
  fetchSkillStats,
  fetchTrend,
  type StatsOverview,
  type SkillStats,
  type TrendPoint,
} from "../api";

const overview = ref<StatsOverview | null>(null);
const skillStats = ref<SkillStats[]>([]);
const trend = ref<TrendPoint[]>([]);
const loading = ref(true);
const loadFailed = ref(false);

onMounted(async () => {
  try {
    [overview.value, skillStats.value, trend.value] = await Promise.all([
      fetchStatsOverview(),
      fetchSkillStats(),
      fetchTrend(14),
    ]);
  } catch {
    loadFailed.value = true;
  } finally {
    loading.value = false;
  }
});

/** 柱状图高度归一化（按最大调用数） */
const maxInvokes = computed(() =>
  Math.max(1, ...trend.value.map((t) => t.invokes)),
);
</script>

<template>
  <el-skeleton v-if="loading" :rows="6" animated />

  <el-empty
    v-else-if="loadFailed || !overview"
    description="统计数据加载失败，请确认 Registry 服务已启动"
  />

  <template v-else>
    <!-- 概览数字卡片 -->
    <el-row :gutter="16">
      <el-col :span="6">
        <div class="stat-card">
          <div class="stat-value">{{ overview.publishedSkills }}</div>
          <div class="stat-label">已发布技能</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="stat-card">
          <div class="stat-value">{{ overview.invokes }}</div>
          <div class="stat-label">总调用次数</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="stat-card">
          <div class="stat-value">{{ overview.views }}</div>
          <div class="stat-label">总浏览次数</div>
        </div>
      </el-col>
      <el-col :span="6">
        <div class="stat-card">
          <div class="stat-value">{{ overview.favorites }}</div>
          <div class="stat-label">收藏次数</div>
        </div>
      </el-col>
    </el-row>

    <!-- 近 14 天调用趋势 -->
    <h2 class="category-title">近 14 天调用趋势</h2>
    <div class="trend-chart">
      <div v-for="t in trend" :key="t.day" class="trend-item">
        <div
          class="trend-bar"
          :style="{ height: `${Math.round((t.invokes / maxInvokes) * 100)}%` }"
          :title="`${t.day}：调用 ${t.invokes} 次 / 浏览 ${t.views} 次`"
        />
        <span class="trend-day">{{ t.day.slice(5) }}</span>
      </div>
    </div>

    <!-- 按技能统计 -->
    <h2 class="category-title">技能使用排行</h2>
    <el-table :data="skillStats" style="width: 100%">
      <el-table-column prop="name" label="技能" min-width="180">
        <template #default="{ row }">
          <router-link :to="`/skills/${row.slug}`">{{ row.name }}</router-link>
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
