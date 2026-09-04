<script setup lang="ts">
import { onMounted, ref } from "vue";
import ExplorationContentPanel from "../components/ExplorationContentPanel.vue";
import {
  fetchDepartments,
  fetchExplorationAdmin,
  fetchExplorations,
  type DepartmentInfo,
  type ExplorationAdminDetail,
  type ExplorationListItem,
} from "../api";

const rows = ref<ExplorationListItem[]>([]);
const loading = ref(false);
const error = ref("");
const keyword = ref("");
const state = ref<"" | ExplorationListItem["state"]>("");
const employee = ref("");
const departmentId = ref("");
const skillVersion = ref("");
const updatedRange = ref<[string, string] | []>([]);
const departments = ref<DepartmentInfo[]>([]);
const page = ref(1);
const pageSize = ref(20);
const total = ref(0);
const detailVisible = ref(false);
const detailLoading = ref(false);
const detailError = ref("");
const detail = ref<ExplorationAdminDetail | null>(null);
const selected = ref<ExplorationListItem | null>(null);

function dayBoundary(value: string, end: boolean): string {
  return new Date(`${value}T${end ? "23:59:59.999" : "00:00:00"}`).toISOString();
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const result = await fetchExplorations({
      keyword: keyword.value.trim() || undefined,
      state: state.value || undefined,
      employee: employee.value.trim() || undefined,
      departmentId: departmentId.value || undefined,
      skillVersion: skillVersion.value.trim() || undefined,
      updatedFrom: updatedRange.value[0] ? dayBoundary(updatedRange.value[0], false) : undefined,
      updatedTo: updatedRange.value[1] ? dayBoundary(updatedRange.value[1], true) : undefined,
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
  state.value = "";
  employee.value = "";
  departmentId.value = "";
  skillVersion.value = "";
  updatedRange.value = [];
  applyFilters();
}

function changePageSize(): void {
  page.value = 1;
  void load();
}

async function open(row: ExplorationListItem): Promise<void> {
  selected.value = row;
  detailVisible.value = true;
  detailLoading.value = true;
  detailError.value = "";
  detail.value = null;
  try {
    detail.value = await fetchExplorationAdmin(row.id);
  } catch (e) {
    detailError.value = (e as Error).message;
  } finally {
    detailLoading.value = false;
  }
}

function format(value: string): string {
  return new Date(value).toLocaleString("zh-CN");
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KB`;
}

function stateLabel(value: ExplorationListItem["state"]): string {
  return { discussing: "讨论中", submitted: "已提交", editing: "补充中", abandoned: "已放弃" }[value];
}

function stateType(value: ExplorationListItem["state"]): "primary" | "success" | "warning" | "info" {
  return { discussing: "primary", submitted: "success", editing: "warning", abandoned: "info" }[value] as
    "primary" | "success" | "warning" | "info";
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
        <p>查看所有已保存草稿及其修订历史。管理员只能查看，不能代员工修改、提交或放弃。</p>
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
        <el-select v-model="state" clearable placeholder="全部状态" style="width: 140px">
          <el-option label="讨论中" value="discussing" />
          <el-option label="已提交" value="submitted" />
          <el-option label="补充中" value="editing" />
          <el-option label="已放弃" value="abandoned" />
        </el-select>
        <el-input v-model="skillVersion" clearable placeholder="规则版本" style="width: 130px" @keyup.enter="applyFilters" />
        <el-date-picker v-model="updatedRange" type="daterange" value-format="YYYY-MM-DD" start-placeholder="更新起始" end-placeholder="更新结束" style="width: 250px" />
        <el-button type="primary" @click="applyFilters">查询</el-button>
        <el-button @click="resetFilters">重置</el-button>
      </div>

      <el-table v-loading="loading" :data="rows" style="width: 100%" empty-text="暂无已保存探索">
        <el-table-column prop="number" label="探索编号" width="230" />
        <el-table-column prop="title" label="标题" min-width="240" show-overflow-tooltip />
        <el-table-column label="员工" width="200"><template #default="{ row }">{{ row.employeeName }}<template v-if="row.employeePhone">（{{ row.employeePhone }}）</template></template></el-table-column>
        <el-table-column label="部门" width="130"><template #default="{ row }">{{ row.departmentName || "—" }}</template></el-table-column>
        <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="stateType(row.state)">{{ stateLabel(row.state) }}</el-tag></template></el-table-column>
        <el-table-column label="规则版本" width="100"><template #default="{ row }">{{ row.skillVersion || "—" }}</template></el-table-column>
        <el-table-column label="修订" width="80"><template #default="{ row }">v{{ row.currentRevision }}</template></el-table-column>
        <el-table-column label="最近保存" width="180"><template #default="{ row }">{{ format(row.updatedAt) }}</template></el-table-column>
        <el-table-column label="操作" width="100" fixed="right"><template #default="{ row }"><el-button link type="primary" @click="open(row)">查看</el-button></template></el-table-column>
      </el-table>
      <el-pagination v-model:current-page="page" v-model:page-size="pageSize" class="table-pagination" :page-sizes="[20, 50, 100]" layout="total, sizes, prev, pager, next" :total="total" @current-change="load" @size-change="changePageSize" />
    </el-card>

    <el-drawer v-model="detailVisible" :title="`探索详情 · ${selected?.number ?? ''}`" size="68%">
      <div v-loading="detailLoading" class="detail-drawer-body">
        <el-alert title="查看敏感业务内容的行为已记入审计日志。" type="info" show-icon :closable="false" />
        <el-alert v-if="detailError" :title="detailError" type="error" show-icon :closable="false" class="detail-block" />
        <template v-if="detail">
          <el-descriptions :column="2" border class="detail-block">
            <el-descriptions-item label="探索编号">{{ detail.number }}</el-descriptions-item>
            <el-descriptions-item label="状态"><el-tag :type="stateType(detail.state)">{{ stateLabel(detail.state) }}</el-tag></el-descriptions-item>
            <el-descriptions-item label="员工">{{ detail.employee?.name ?? selected?.employeeName }}<template v-if="detail.employee?.phone ?? selected?.employeePhone">（{{ detail.employee?.phone ?? selected?.employeePhone }}）</template></el-descriptions-item>
            <el-descriptions-item label="部门">{{ selected?.departmentName || "—" }}</el-descriptions-item>
            <el-descriptions-item label="规则版本">{{ detail.skillVersion || "—" }}</el-descriptions-item>
            <el-descriptions-item label="最近保存">{{ format(detail.updatedAt) }}</el-descriptions-item>
            <el-descriptions-item label="当前修订">v{{ detail.currentRevision }}</el-descriptions-item>
            <el-descriptions-item label="当前有效修订">v{{ detail.activeRevision }}</el-descriptions-item>
            <el-descriptions-item label="正式需求">{{ detail.requirementNumber || "尚未正式提交" }}</el-descriptions-item>
            <el-descriptions-item label="最近提交修订">{{ detail.lastSubmittedRevision === null ? "—" : `v${detail.lastSubmittedRevision}` }}</el-descriptions-item>
          </el-descriptions>

          <el-alert
            v-if="detail.state === 'submitted' && detail.currentRevision > detail.activeRevision"
            title="最近一次正式提交后的修改已放弃；当前有效内容已恢复为最近正式版本，历史修改仍保留供审计。"
            type="warning"
            show-icon
            :closable="false"
            class="detail-block"
          />
          <el-alert v-if="detail.publicFeedback" :title="`员工可见评审反馈：${detail.publicFeedback}`" type="info" show-icon :closable="false" class="detail-block" />

          <ExplorationContentPanel :content="detail.activeContent" :heading="`当前有效内容 · v${detail.activeRevision}`" class="detail-block" />

          <section class="detail-section detail-block" aria-label="修订历史">
            <h3>修订历史</h3>
            <el-collapse>
              <el-collapse-item v-for="revision in detail.revisions" :key="revision.revision" :name="revision.revision">
                <template #title>
                  <span class="revision-title">v{{ revision.revision }} · {{ format(revision.createdAt) }}</span>
                  <el-tag v-if="revision.revision === detail.activeRevision" type="success" size="small">当前有效</el-tag>
                  <el-tag v-if="revision.revision === detail.lastSubmittedRevision" type="primary" size="small">最近正式提交</el-tag>
                </template>
                <ExplorationContentPanel :content="revision.content" :heading="`修订 v${revision.revision}`" />
              </el-collapse-item>
            </el-collapse>
          </section>

          <section v-if="detail.ruleSnapshot" class="detail-section detail-block" aria-label="锁定规则">
            <h3>锁定规则</h3>
            <el-descriptions :column="2" border>
              <el-descriptions-item label="Skill">{{ detail.ruleSnapshot.slug || "—" }}</el-descriptions-item>
              <el-descriptions-item label="版本">{{ detail.ruleSnapshot.version || detail.skillVersion || "—" }}</el-descriptions-item>
              <el-descriptions-item label="资源清单" :span="2">
                <ul v-if="detail.ruleSnapshot.resources.length" class="detail-ordered-list">
                  <li v-for="resource in detail.ruleSnapshot.resources" :key="resource.path">{{ resource.path }}（{{ formatBytes(resource.size) }}）</li>
                </ul>
                <span v-else>无附加资源</span>
              </el-descriptions-item>
            </el-descriptions>
          </section>
        </template>
        <el-empty v-else-if="!detailLoading && !detailError" description="未加载到记录" />
      </div>
    </el-drawer>
  </main>
</template>
