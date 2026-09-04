<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Search } from "@element-plus/icons-vue";
import { useRoute, useRouter } from "vue-router";
import { fetchSkills, type SkillCard } from "../api";
import PublishView from "./PublishView.vue";

const route = useRoute();
const router = useRouter();
const activeTab = computed({
  get: () => route.query.tab === "publish" ? "publish" : "list",
  set: (value: string) => {
    void router.replace(value === "publish"
      ? { name: "home", query: { tab: "publish" } }
      : { name: "home" });
  },
});

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
  <main class="page-shell" aria-label="Skill 管理">
    <p class="page-description">集中查看和发布公司普通 Skill 与应用 Skill。</p>
    <el-tabs v-model="activeTab" class="skill-management-tabs">
      <el-tab-pane label="Skill 列表" name="list">
        <div class="filter-panel">
          <el-input
            v-model="keyword"
            class="search-input"
            size="large"
            placeholder="搜索 Skill，如：周报、发票、翻译…"
            aria-label="搜索 Skill"
            :prefix-icon="Search"
            clearable
          />
        </div>

        <el-skeleton v-if="loading" :rows="4" animated style="margin-top: 24px" />

        <el-empty v-else-if="loadFailed" description="Skill 列表加载失败，请稍后重试">
          <el-button type="primary" @click="load">重新加载</el-button>
        </el-empty>

        <el-empty
          v-else-if="skills.length === 0"
          description="暂无 Skill，可切换到“发布 Skill”上传第一个 Skill"
        />

        <el-empty v-else-if="grouped.length === 0" description="没有匹配的 Skill，换个关键词试试" />

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
                <el-tag
                  size="small"
                  :type="s.skillType === 'application' ? 'warning' : 'info'"
                  effect="plain"
                  style="margin-left: 8px"
                >{{ s.skillType === "application" ? "应用 Skill" : "普通 Skill" }}</el-tag>
                <el-tag size="small" effect="plain" style="margin-left: 8px">{{
                  s.category
                }}</el-tag>
                <p class="summary">{{ s.summary }}</p>
              </router-link>
            </div>
          </section>
        </template>
      </el-tab-pane>
      <el-tab-pane label="发布 Skill" name="publish" lazy>
        <PublishView />
      </el-tab-pane>
    </el-tabs>
  </main>
</template>

<style scoped>
.skill-management-tabs { width: 100%; }
</style>
