<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import {
  fetchRequests,
  createRequest,
  toggleVote,
  type SkillRequest,
  type RequestStatus,
} from "../api";

const requests = ref<SkillRequest[]>([]);
const loading = ref(true);
const loadFailed = ref(false);

const dialogVisible = ref(false);
const submitting = ref(false);
const form = reactive({ title: "", description: "" });
const votingIds = ref(new Set<string>());

const STATUS_META: Record<RequestStatus, { label: string; type: "info" | "warning" | "success" | "danger" }> = {
  open: { label: "待评估", type: "info" },
  planned: { label: "已计划", type: "warning" },
  done: { label: "已上线", type: "success" },
  rejected: { label: "已拒绝", type: "danger" },
};

async function load(): Promise<void> {
  loading.value = true;
  loadFailed.value = false;
  try {
    requests.value = await fetchRequests();
  } catch {
    loadFailed.value = true;
  } finally {
    loading.value = false;
  }
}

onMounted(load);

async function onSubmit(): Promise<void> {
  if (!form.title.trim()) {
    ElMessage.warning("请填写标题");
    return;
  }
  submitting.value = true;
  try {
    await createRequest({
      title: form.title.trim(),
      description: form.description.trim(),
    });
    ElMessage.success("许愿成功，等待 IT 评估");
    dialogVisible.value = false;
    form.title = form.description = "";
    await load();
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    submitting.value = false;
  }
}

async function onVote(r: SkillRequest): Promise<void> {
  if (votingIds.value.has(r.id)) return;
  votingIds.value = new Set(votingIds.value).add(r.id);
  try {
    const { voted, votes } = await toggleVote(r.id);
    r.votedByMe = voted;
    r.votes = votes;
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    const next = new Set(votingIds.value);
    next.delete(r.id);
    votingIds.value = next;
  }
}
</script>

<template>
  <section aria-label="许愿墙">
    <div class="page-heading">
      <div>
        <p class="page-description">想要还没有的技能？许下愿望，得票高的优先开发。</p>
      </div>
      <el-button type="primary" @click="dialogVisible = true">✨ 我要许愿</el-button>
    </div>

  <el-skeleton v-if="loading" :rows="4" animated style="margin-top: 24px" />
  <el-empty v-else-if="loadFailed" description="愿望列表加载失败，请稍后重试">
    <el-button type="primary" @click="load">重新加载</el-button>
  </el-empty>
  <el-empty v-else-if="requests.length === 0" description="还没有愿望，来当第一个许愿的人" />

  <div v-else class="request-list">
    <div v-for="r in requests" :key="r.id" class="request-card">
      <button
        class="vote-btn"
        :class="{ voted: r.votedByMe }"
        :disabled="votingIds.has(r.id)"
        :aria-label="`${r.votedByMe ? '取消支持' : '支持'}「${r.title}」，当前 ${r.votes} 票`"
        :aria-pressed="r.votedByMe"
        @click="onVote(r)"
      >
        <span class="vote-arrow">▲</span>
        <span class="vote-count">{{ r.votes }}</span>
      </button>
      <div class="request-main">
        <div>
          <strong>{{ r.title }}</strong>
          <el-tag
            size="small"
            :type="STATUS_META[r.status].type"
            effect="plain"
            style="margin-left: 8px"
          >
            {{ STATUS_META[r.status].label }}
          </el-tag>
        </div>
        <p v-if="r.description" class="request-desc">{{ r.description }}</p>
        <span class="request-meta">
          {{ r.requesterName ?? "未知员工" }} ·
          {{ new Date(r.createdAt).toLocaleDateString("zh-CN") }}
        </span>
      </div>
    </div>
  </div>
  </section>

  <el-dialog v-model="dialogVisible" title="新建技能愿望" width="min(480px, 92vw)">
    <el-form label-position="top">
      <el-form-item label="想要什么技能？（一句话）" required>
        <el-input
          v-model="form.title"
          maxlength="100"
          show-word-limit
          placeholder="如：把会议录音自动整理成待办清单"
        />
      </el-form-item>
      <el-form-item label="补充说明（使用场景、期望效果）">
        <el-input v-model="form.description" type="textarea" :rows="4" maxlength="500" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="submitting" @click="onSubmit">提交愿望</el-button>
    </template>
  </el-dialog>
</template>
