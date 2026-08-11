<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Search } from "@element-plus/icons-vue";
import { fetchSkills, type SkillCard } from "../api";

const skills = ref<SkillCard[]>([]);
const keyword = ref("");
const loading = ref(true);
const loadFailed = ref(false);

onMounted(async () => {
  try {
    skills.value = await fetchSkills();
  } catch {
    loadFailed.value = true;
  } finally {
    loading.value = false;
  }
});

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
  <el-input
    v-model="keyword"
    class="search-input"
    size="large"
    placeholder="搜索技能，如：周报、发票、翻译…"
    :prefix-icon="Search"
    clearable
  />

  <el-skeleton v-if="loading" :rows="4" animated style="margin-top: 24px" />

  <el-empty
    v-else-if="loadFailed"
    description="Registry 服务不可用，请确认 pnpm dev:registry 已启动"
  />

  <el-empty
    v-else-if="skills.length === 0"
    description="暂无已发布的技能，IT 同事可通过 skillhive publish 发布"
  />

  <el-empty v-else-if="grouped.length === 0" description="没有匹配的技能，换个关键词试试" />

  <template v-else>
    <section v-for="[category, list] in grouped" :key="category">
      <h2 class="category-title">{{ category }}（{{ list.length }}）</h2>
      <div class="card-grid">
        <router-link
          v-for="s in list"
          :key="s.id"
          :to="`/skills/${s.slug}`"
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
</template>
