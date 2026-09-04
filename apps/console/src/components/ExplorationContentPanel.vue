<script setup lang="ts">
import type { ExplorationContent } from "../api";

withDefaults(defineProps<{
  content: ExplorationContent | null;
  heading?: string;
}>(), {
  heading: "结构化内容",
});

function display(value: string | undefined): string {
  return value?.trim() || "未填写";
}
</script>

<template>
  <section class="exploration-content-panel" :aria-label="heading">
    <h3>{{ heading }}</h3>
    <el-empty v-if="!content" description="尚无已保存内容" :image-size="72" />
    <el-descriptions v-else :column="1" border label-width="150px">
      <el-descriptions-item label="标题">
        <span class="detail-long-text">{{ display(content.title) }}</span>
      </el-descriptions-item>
      <el-descriptions-item label="问题描述">
        <span class="detail-long-text">{{ display(content.problemDescription) }}</span>
      </el-descriptions-item>
      <el-descriptions-item label="目标用户/对象">
        <span class="detail-long-text">{{ display(content.targetUsers) }}</span>
      </el-descriptions-item>
      <el-descriptions-item label="当前流程">
        <span class="detail-long-text">{{ display(content.currentProcess) }}</span>
      </el-descriptions-item>
      <el-descriptions-item label="痛点与事实依据">
        <div v-if="content.painAndEvidence.length" class="detail-list">
          <article v-for="(item, index) in content.painAndEvidence" :key="`${index}-${item.pain}`" class="detail-list-item">
            <div class="detail-list-title">
              <span>{{ index + 1 }}. {{ item.pain }}</span>
              <el-tag :type="item.evidenceStatus === 'to_verify' ? 'warning' : 'info'" size="small">
                {{ item.evidenceStatus === "to_verify" ? "待验证" : "员工陈述" }}
              </el-tag>
            </div>
            <p v-if="item.evidence" class="detail-list-note">依据：{{ item.evidence }}</p>
          </article>
        </div>
        <span v-else class="detail-empty-value">未填写</span>
      </el-descriptions-item>
      <el-descriptions-item label="目标与预期收益">
        <span class="detail-long-text">{{ display(content.objectivesAndBenefits) }}</span>
      </el-descriptions-item>
      <el-descriptions-item label="需求范围">
        <span class="detail-long-text">{{ display(content.scope) }}</span>
      </el-descriptions-item>
      <el-descriptions-item label="非目标">
        <span class="detail-long-text">{{ display(content.nonGoals) }}</span>
      </el-descriptions-item>
      <el-descriptions-item label="验收标准">
        <ol v-if="content.acceptanceCriteria.length" class="detail-ordered-list">
          <li v-for="item in content.acceptanceCriteria" :key="item">{{ item }}</li>
        </ol>
        <span v-else class="detail-empty-value">未填写</span>
      </el-descriptions-item>
      <el-descriptions-item label="约束与风险">
        <ul v-if="content.constraintsAndRisks.length" class="detail-ordered-list">
          <li v-for="item in content.constraintsAndRisks" :key="item">{{ item }}</li>
        </ul>
        <span v-else class="detail-empty-value">未填写</span>
      </el-descriptions-item>
      <el-descriptions-item label="待确认事项">
        <ul v-if="content.pendingQuestions.length" class="detail-ordered-list">
          <li v-for="item in content.pendingQuestions" :key="item">{{ item }}</li>
        </ul>
        <span v-else class="detail-empty-value">无</span>
      </el-descriptions-item>
      <el-descriptions-item label="总结">
        <span class="detail-long-text">{{ display(content.summary) }}</span>
      </el-descriptions-item>
    </el-descriptions>
  </section>
</template>
