<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Search } from "@element-plus/icons-vue";
import { fetchSkills, type SkillCard } from "../api";

const skills = ref<SkillCard[]>([]);
const keyword = ref("");
const loading = ref(true);
const loadFailed = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  loadFailed.value = false;
  try {
    skills.value = await fetchSkills();
  } catch {
    loadFailed.value = true;
  } finally {
    loading.value = false;
  }
}

onMounted(load);

const grouped = computed(() => {
  const kw = keyword.value.trim();
  const filtered = kw
    ? skills.value.filter((s) => s.name.includes(kw) || s.summary.includes(kw))
    : skills.value;

  const map = new Map<string, SkillCard[]>();
  for (const s of filtered) {
    const list = map.get(s.category) ?? [];
    list.push(s);
    map.set(s.category, list);
  }
  return [...map.entries()];
});
</script>

<template>
  <section aria-labelledby="market-title">
    <div class="page-heading">
      <div>
        <h1 id="market-title" class="page-title">技能市场</h1>
        <p class="page-description">查找团队已发布、且你有权使用的技能。</p>
      </div>
    </div>
    <div class="filter-panel">
      <el-input
        v-model="keyword"
        class="search-input"
        size="large"
        placeholder="搜索技能，如：周报、发票、翻译…"
        aria-label="搜索技能"
        :prefix-icon="Search"
        clearable
      />
    </div>

    <el-skeleton v-if="loading" :rows="4" animated style="margin-top: 24px" />

    <el-empty v-else-if="loadFailed" description="技能列表加载失败，请稍后重试">
      <el-button type="primary" @click="load">重新加载</el-button>
    </el-empty>

    <el-empty
      v-else-if="skills.length === 0"
      description="暂无可用技能，有发布权限的同事可以上传第一个技能"
    />

    <el-empty v-else-if="grouped.length === 0" description="没有匹配的技能，换个关键词试试" />

    <template v-else>
      <section v-for="[category, list] in grouped" :key="category">
        <h2 class="category-title">{{ category }}（{{ list.length }}）</h2>
        <div class="card-grid">
          <router-link
            v-for="s in list"
            :key="s.id"
            :to="`/skills/${encodeURIComponent(s.slug)}`"
            class="skill-card"
          >
            <span class="name">{{ s.name }}</span>
            <el-tag size="small" effect="plain" style="margin-left: 8px">{{
              s.category
            }}</el-tag>
            <p class="summary">{{ s.summary }}</p>
          </router-link>
        </div>
      </section>
    </template>
  </section>
</template>
