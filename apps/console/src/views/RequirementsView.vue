<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage } from "element-plus";
import ExplorationContentPanel from "../components/ExplorationContentPanel.vue";
import {
  fetchDepartments,
  fetchRequirementAdmin,
  fetchRequirements,
  reviewRequirement,
  type DepartmentInfo,
  type RequirementAdminDetail,
  type RequirementListItem,
  type RequirementStatus,
} from "../api";

const rows = ref<RequirementListItem[]>([]);
const loading = ref(false);
const error = ref("");
const keyword = ref("");
const status = ref<"" | RequirementStatus>("");
const employee = ref("");
const departmentId = ref("");
const skillVersion = ref("");
const submittedRange = ref<[string, string] | []>([]);
const departments = ref<DepartmentInfo[]>([]);
const page = ref(1);
const pageSize = ref(20);
const total = ref(0);
const detailVisible = ref(false);
const detailLoading = ref(false);
const detailError = ref("");
const detail = ref<RequirementAdminDetail | null>(null);
const reviewVisible = ref(false);
const selected = ref<RequirementListItem | null>(null);
const reviewing = ref(false);
const reviewForm = reactive<{ status: RequirementStatus; publicFeedback: string; internalNote: string }>({
  status: "in_review",
  publicFeedback: "",
  internalNote: "",
});
const currentSnapshot = computed(() => detail.value?.submissions.find(
  (item) => item.submission === detail.value?.currentSubmission,
) ?? null);

function dayBoundary(value: string, end: boolean): string {
  return new Date(`${value}T${end ? "23:59:59.999" : "00:00:00"}`).toISOString();
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const result = await fetchRequirements({
      keyword: keyword.value.trim() || undefined,
      reviewStatus: status.value || undefined,
      employee: employee.value.trim() || undefined,
      departmentId: departmentId.value || undefined,
      skillVersion: skillVersion.value.trim() || undefined,
      submittedFrom: submittedRange.value[0] ? dayBoundary(submittedRange.value[0], false) : undefined,
      submittedTo: submittedRange.value[1] ? dayBoundary(submittedRange.value[1], true) : undefined,
      page: page.value,
      pageSize: pageSize.value,
    });
    rows.value = result.items;
    total.value = result.total;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

async function loadOptions(): Promise<void> {
  try {
    departments.value = await fetchDepartments();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function applyFilters(): void {
  page.value = 1;
  void load();
}

function resetFilters(): void {
  keyword.value = "";
  status.value = "";
  employee.value = "";
  departmentId.value = "";
  skillVersion.value = "";
  submittedRange.value = [];
  applyFilters();
}

function changePageSize(): void {
  page.value = 1;
  void load();
}

async function open(row: RequirementListItem): Promise<void> {
  selected.value = row;
  detailVisible.value = true;
  detailLoading.value = true;
  detailError.value = "";
  detail.value = null;
  try {
    detail.value = await fetchRequirementAdmin(row.id);
  } catch (e) {
    detailError.value = (e as Error).message;
  } finally {
    detailLoading.value = false;
  }
}

function openReview(row: RequirementListItem): void {
  selected.value = row;
  reviewForm.status = row.reviewStatus;
  reviewForm.publicFeedback = row.publicFeedback ?? "";
  reviewForm.internalNote = "";
  reviewVisible.value = true;
}

function needsReason(value: RequirementStatus): boolean {
  return ["needs_information", "accepted", "deferred", "rejected"].includes(value);
}

async function submitReview(): Promise<void> {
  if (!selected.value) return;
  reviewing.value = true;
  try {
    await reviewRequirement(selected.value.id, {
      expectedRevision: selected.value.reviewRevision,
      expectedSubmission: selected.value.currentSubmission,
      status: reviewForm.status,
      publicFeedback: reviewForm.publicFeedback || null,
      internalNote: reviewForm.internalNote || null,
    });
    reviewVisible.value = false;
    ElMessage.success("评审结果已保存");
    await load();
  } catch (e) {
    ElMessage.error(`${(e as Error).message}；请刷新列表后确认当前提交版本`);
  } finally {
    reviewing.value = false;
  }
}

function format(value: string): string {
  return new Date(value).toLocaleString("zh-CN");
}

function statusLabel(value: RequirementStatus): string {
  return {
    pending_review: "待评审",
    needs_information: "待补充",
    in_review: "评审中",
    accepted: "已接受",
    deferred: "已延期",
    rejected: "已拒绝",
  }[value];
}

function statusType(value: RequirementStatus): "primary" | "success" | "warning" | "danger" | "info" {
  return {
    pending_review: "warning",
    needs_information: "warning",
    in_review: "primary",
    accepted: "success",
    deferred: "info",
    rejected: "danger",
  }[value] as "primary" | "success" | "warning" | "danger" | "info";
}

onMounted(() => {
  void loadOptions();
  void load();
});
</script>

<template>
  <main class="page-shell">
    <section class="page-heading">
      <div>
        <p>这里只展示员工明确正式提交的不可变快照；草稿请到“探索记录”查看。</p>
      </div>
    </section>

    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false">
      <template #default><el-button link type="primary" @click="load">重试</el-button></template>
    </el-alert>

    <el-card shadow="never" class="content-card">
      <div class="filter-row">
        <el-input v-model="keyword" clearable placeholder="搜索编号或标题" style="width: 240px" @keyup.enter="applyFilters" />
        <el-input v-model="employee" clearable placeholder="手机号或姓名" style="width: 180px" @keyup.enter="applyFilters" />
        <el-select v-model="departmentId" clearable placeholder="全部部门" style="width: 150px">
          <el-option v-for="item in departments" :key="item.id" :label="item.name" :value="item.id" />
        </el-select>
        <el-select v-model="status" clearable placeholder="全部评审状态" style="width: 160px">
          <el-option label="待评审" value="pending_review" />
          <el-option label="待补充" value="needs_information" />
          <el-option label="评审中" value="in_review" />
          <el-option label="已接受" value="accepted" />
          <el-option label="已延期" value="deferred" />
          <el-option label="已拒绝" value="rejected" />
        </el-select>
        <el-input v-model="skillVersion" clearable placeholder="规则版本" style="width: 130px" @keyup.enter="applyFilters" />
        <el-date-picker v-model="submittedRange" type="daterange" value-format="YYYY-MM-DD" start-placeholder="提交起始" end-placeholder="提交结束" style="width: 250px" />
        <el-button type="primary" @click="applyFilters">查询</el-button>
        <el-button @click="resetFilters">重置</el-button>
      </div>

      <el-table v-loading="loading" :data="rows" style="width: 100%" empty-text="暂无正式需求">
        <el-table-column prop="number" label="需求编号" width="230" />
        <el-table-column prop="title" label="标题" min-width="240" show-overflow-tooltip />
        <el-table-column label="员工" width="200"><template #default="{ row }">{{ row.employeeName }}<template v-if="row.employeePhone">（{{ row.employeePhone }}）</template></template></el-table-column>
        <el-table-column label="部门" width="130"><template #default="{ row }">{{ row.departmentName || "—" }}</template></el-table-column>
        <el-table-column label="评审状态" width="110"><template #default="{ row }"><el-tag :type="statusType(row.reviewStatus)">{{ statusLabel(row.reviewStatus) }}</el-tag></template></el-table-column>
        <el-table-column label="规则版本" width="100"><template #default="{ row }">{{ row.skillVersion || "—" }}</template></el-table-column>
        <el-table-column label="提交版本" width="150"><template #default="{ row }">第 {{ row.currentSubmission }} 次 <el-tag v-if="row.hasUnsubmittedChanges" type="warning" size="small">有新草稿</el-tag></template></el-table-column>
        <el-table-column label="提交时间" width="180"><template #default="{ row }">{{ format(row.submittedAt) }}</template></el-table-column>
        <el-table-column label="操作" width="150" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="open(row)">查看快照</el-button><el-button link type="primary" @click="openReview(row)">评审</el-button></template></el-table-column>
      </el-table>
      <el-pagination v-model:current-page="page" v-model:page-size="pageSize" class="table-pagination" :page-sizes="[20, 50, 100]" layout="total, sizes, prev, pager, next" :total="total" @current-change="load" @size-change="changePageSize" />
    </el-card>

    <el-drawer v-model="detailVisible" :title="`正式需求详情 · ${selected?.number ?? ''}`" size="68%">
      <div v-loading="detailLoading" class="detail-drawer-body">
        <el-alert title="正式提交快照不可修改；查看行为已记入审计日志。" type="info" show-icon :closable="false" />
        <el-alert v-if="detailError" :title="detailError" type="error" show-icon :closable="false" class="detail-block" />
        <template v-if="detail">
          <el-alert
            v-if="detail.hasUnsubmittedChanges"
            title="员工在最近正式提交后还有已保存但未提交的草稿；当前评审仍绑定下方正式快照。"
            type="warning"
            show-icon
            :closable="false"
            class="detail-block"
          />
          <el-descriptions :column="2" border class="detail-block">
            <el-descriptions-item label="需求编号">{{ detail.number }}</el-descriptions-item>
            <el-descriptions-item label="评审状态"><el-tag :type="statusType(detail.reviewStatus)">{{ statusLabel(detail.reviewStatus) }}</el-tag></el-descriptions-item>
            <el-descriptions-item label="来源探索">{{ detail.explorationNumber }}</el-descriptions-item>
            <el-descriptions-item label="员工">{{ detail.employeeName }}<template v-if="detail.employeePhone">（{{ detail.employeePhone }}）</template></el-descriptions-item>
            <el-descriptions-item label="部门">{{ detail.departmentName || "—" }}</el-descriptions-item>
            <el-descriptions-item label="规则版本">{{ detail.skillVersion || "—" }}</el-descriptions-item>
            <el-descriptions-item label="当前提交">第 {{ detail.currentSubmission }} 次</el-descriptions-item>
            <el-descriptions-item label="对应草稿修订">{{ currentSnapshot ? `v${currentSnapshot.revision}` : "—" }}</el-descriptions-item>
            <el-descriptions-item label="提交时间">{{ currentSnapshot ? format(currentSnapshot.submittedAt) : "—" }}</el-descriptions-item>
            <el-descriptions-item label="评审更新时间">{{ detail.reviewedAt ? format(detail.reviewedAt) : "尚未评审" }}</el-descriptions-item>
          </el-descriptions>

          <ExplorationContentPanel :content="currentSnapshot?.content ?? null" :heading="`当前正式快照 · 第 ${detail.currentSubmission} 次提交`" class="detail-block" />

          <section class="detail-section detail-block" aria-label="提交历史">
            <h3>提交历史</h3>
            <el-collapse>
              <el-collapse-item v-for="submission in detail.submissions" :key="submission.id" :name="submission.id">
                <template #title>
                  <span class="revision-title">第 {{ submission.submission }} 次提交 · v{{ submission.revision }} · {{ format(submission.submittedAt) }}</span>
                  <el-tag v-if="submission.submission === detail.currentSubmission" type="success" size="small">当前评审版本</el-tag>
                </template>
                <ExplorationContentPanel :content="submission.content" :heading="`第 ${submission.submission} 次正式快照`" />
              </el-collapse-item>
            </el-collapse>
          </section>

          <section class="detail-section detail-block" aria-label="评审历史">
            <h3>评审历史</h3>
            <el-empty v-if="detail.reviews.length === 0" description="暂无评审记录" :image-size="72" />
            <el-timeline v-else>
              <el-timeline-item v-for="review in detail.reviews" :key="review.id" :timestamp="format(review.createdAt)" placement="top">
                <el-card shadow="never">
                  <div class="review-heading">
                    <strong>第 {{ review.submission }} 次提交 · 评审修订 {{ review.reviewRevision }}</strong>
                    <el-tag :type="statusType(review.status)" size="small">{{ statusLabel(review.status) }}</el-tag>
                  </div>
                  <p><strong>评审人：</strong>{{ review.reviewerName || "历史管理员" }}</p>
                  <p><strong>员工可见反馈：</strong>{{ review.publicFeedback || "无" }}</p>
                  <p><strong>内部备注：</strong>{{ review.internalNote || "无" }}</p>
                </el-card>
              </el-timeline-item>
            </el-timeline>
          </section>
        </template>
        <el-empty v-else-if="!detailLoading && !detailError" description="未加载到记录" />
      </div>
    </el-drawer>

    <el-dialog v-model="reviewVisible" :title="`评审需求 · ${selected?.number ?? ''}`" width="640px" :close-on-click-modal="!reviewing">
      <el-form label-position="top">
        <el-form-item label="评审状态" required>
          <el-select v-model="reviewForm.status" style="width: 100%">
            <el-option label="待评审" value="pending_review" />
            <el-option label="待补充" value="needs_information" />
            <el-option label="评审中" value="in_review" />
            <el-option label="已接受" value="accepted" />
            <el-option label="延期" value="deferred" />
            <el-option label="已拒绝" value="rejected" />
          </el-select>
        </el-form-item>
        <el-form-item label="员工可见反馈" :required="needsReason(reviewForm.status)">
          <el-input v-model="reviewForm.publicFeedback" type="textarea" :rows="4" maxlength="8000" show-word-limit />
        </el-form-item>
        <el-form-item label="内部备注">
          <el-input v-model="reviewForm.internalNote" type="textarea" :rows="3" maxlength="8000" show-word-limit />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button :disabled="reviewing" @click="reviewVisible = false">取消</el-button>
        <el-button type="primary" :loading="reviewing" :disabled="needsReason(reviewForm.status) && !reviewForm.publicFeedback.trim()" @click="submitReview">保存评审</el-button>
      </template>
    </el-dialog>
  </main>
</template>
