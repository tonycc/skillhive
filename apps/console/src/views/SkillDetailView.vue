<script setup lang="ts">
import { onMounted, ref } from "vue";
import { marked } from "marked";
import { fetchSkillDetail, reportEvent, type SkillDetail } from "../api";

const props = defineProps<{ slug: string }>();

const skill = ref<SkillDetail | null>(null);
const bodyHtml = ref("");
const loading = ref(true);
const notFound = ref(false);

onMounted(async () => {
  try {
    skill.value = await fetchSkillDetail(props.slug);
    if (skill.value.latestVersion?.body) {
      bodyHtml.value = await marked.parse(skill.value.latestVersion.body);
    }
    // 上报浏览埋点
    reportEvent(props.slug, "view");
  } catch {
    notFound.value = true;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <router-link to="/" class="back-link">← 返回技能市场</router-link>

  <el-skeleton v-if="loading" :rows="6" animated style="margin-top: 24px" />

  <el-empty
    v-else-if="notFound || !skill"
    :description="`技能「${props.slug}」不存在或 Registry 服务不可用`"
  />

  <template v-else>
    <h2 style="margin: 16px 0 4px">{{ skill.name }}</h2>
    <p style="color: var(--text-secondary); margin-top: 0">{{ skill.summary }}</p>

    <div class="detail-meta">
      <el-tag effect="plain">分类：{{ skill.category }}</el-tag>
      <el-tag effect="plain">版本：v{{ skill.latestVersion?.version ?? "-" }}</el-tag>
      <el-tag effect="plain">
        可见范围：{{
          skill.visibleDepartments.length === 0
            ? "全员"
            : skill.visibleDepartments.join("、")
        }}
      </el-tag>
    </div>

    <el-alert type="warning" :closable="false" style="margin-bottom: 24px">
      💡 在 WorkBuddy 对话中通过快捷指令选择「{{ skill.slug }}」即可使用本技能；
      也可以说「用 {{ skill.name }} 帮我…」让 AI 自动调用。
    </el-alert>

    <p
      v-if="skill.latestVersion?.changelog"
      style="font-size: 13px; color: var(--text-secondary)"
    >
      最近更新：{{ skill.latestVersion.changelog }}
    </p>

    <article class="markdown-body" v-html="bodyHtml" />
  </template>
</template>
