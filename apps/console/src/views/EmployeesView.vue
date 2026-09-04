<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  createEmployee,
  createEmployeeToken,
  fetchEmployees,
  fetchDepartments,
  fetchEmployeeTokens,
  revokeEmployeeToken,
  updateEmployee,
  type EmployeeInfo,
  type EmployeeTokenInfo,
  type DepartmentInfo,
} from "../api";

const loading = ref(false);
const actionLoading = ref(false);
const error = ref("");
const keyword = ref("");
const statusFilter = ref<"" | EmployeeInfo["status"]>("");
const departmentFilter = ref("");
const rows = ref<EmployeeInfo[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const departments = ref<DepartmentInfo[]>([]);
const createVisible = ref(false);
const editVisible = ref(false);
const tokenVisible = ref(false);
const tokenListVisible = ref(false);
const tokenListLoading = ref(false);
const employeeTokenRows = ref<EmployeeTokenInfo[]>([]);
const selected = ref<EmployeeInfo | null>(null);
const issuedToken = ref("");
const issuedTokenId = ref("");
const createForm = reactive({ phone: "", name: "", email: "", departmentId: "" });
const editForm = reactive({ phone: "", name: "", email: "", departmentId: "" });
const tokenForm = reactive({ name: "WorkBuddy", expiresInDays: 90 });

async function runAction(action: () => Promise<unknown>, success: string): Promise<boolean> {
  actionLoading.value = true;
  try {
    await action();
    ElMessage.success(success);
    return true;
  } catch (error) {
    ElMessage.error((error as Error).message);
    return false;
  } finally {
    actionLoading.value = false;
  }
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const result = await fetchEmployees({
      keyword: keyword.value.trim() || undefined,
      status: statusFilter.value || undefined,
      departmentId: departmentFilter.value || undefined,
      page: page.value,
      pageSize: pageSize.value,
    });
    rows.value = result.items;
    total.value = result.total;
  } catch (e) { error.value = (e as Error).message; }
  finally { loading.value = false; }
}

async function loadOptions(): Promise<void> {
  try {
    departments.value = await fetchDepartments();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function applyFilters(): void { page.value = 1; void load(); }
function resetFilters(): void {
  keyword.value = "";
  statusFilter.value = "";
  departmentFilter.value = "";
  applyFilters();
}
function changePageSize(): void { page.value = 1; void load(); }

async function submitCreate(): Promise<void> {
  const ok = await runAction(
    () => createEmployee({ ...createForm, email: createForm.email || null, departmentId: createForm.departmentId || null }),
    "员工档案已创建",
  );
  if (!ok) return;
  createVisible.value = false;
  Object.assign(createForm, { phone: "", name: "", email: "", departmentId: "" });
  await load();
}

function openEdit(row: EmployeeInfo): void {
  selected.value = row;
  Object.assign(editForm, {
    phone: row.phone ?? "",
    name: row.name,
    email: row.email ?? "",
    departmentId: row.departmentId ?? "",
  });
  editVisible.value = true;
}

async function submitEdit(): Promise<void> {
  if (!selected.value) return;
  const ok = await runAction(() => updateEmployee(selected.value!.id, {
    phone: editForm.phone, name: editForm.name, email: editForm.email || null,
    departmentId: editForm.departmentId || null,
  }), "员工档案已更新");
  if (!ok) return;
  editVisible.value = false;
  await load();
}

async function toggleStatus(row: EmployeeInfo): Promise<void> {
  const disabling = row.status === "active";
  if (disabling) {
    try { await ElMessageBox.confirm("停用员工会立即吊销其全部有效连接器令牌。", `停用 ${row.name}`, { type: "warning" }); } catch { return; }
  }
  if (!await runAction(
    () => updateEmployee(row.id, { status: disabling ? "disabled" : "active" }),
    disabling ? "员工已停用" : "员工已启用；旧令牌不会恢复",
  )) return;
  await load();
}

async function issue(row: EmployeeInfo): Promise<void> {
  selected.value = row;
  issuedToken.value = "";
  issuedTokenId.value = "";
  tokenForm.name = "WorkBuddy";
  tokenForm.expiresInDays = 90;
  tokenVisible.value = true;
}

async function submitToken(): Promise<void> {
  if (!selected.value) return;
  actionLoading.value = true;
  try {
    const result = await createEmployeeToken(selected.value.id, {
      name: tokenForm.name,
      expiresInDays: tokenForm.expiresInDays,
    });
    issuedToken.value = result.token;
    issuedTokenId.value = result.id;
    ElMessage.success("员工专属令牌已生成");
    await load();
  } catch (error) { ElMessage.error((error as Error).message); }
  finally { actionLoading.value = false; }
}

function closeIssuedToken(): void {
  issuedToken.value = "";
  issuedTokenId.value = "";
  tokenVisible.value = false;
}

async function cancelIssuedToken(): Promise<void> {
  if (!selected.value || !issuedTokenId.value) return;
  try {
    await ElMessageBox.confirm(
      "该令牌将立即吊销且无法恢复。",
      "吊销并关闭令牌",
      { type: "warning" },
    );
  } catch { return; }
  if (!await runAction(
    () => revokeEmployeeToken(selected.value!.id, issuedTokenId.value),
    "令牌已吊销",
  )) return;
  issuedToken.value = "";
  issuedTokenId.value = "";
  tokenVisible.value = false;
  await load();
}

async function openTokens(row: EmployeeInfo): Promise<void> {
  selected.value = row;
  tokenListVisible.value = true;
  tokenListLoading.value = true;
  try { employeeTokenRows.value = await fetchEmployeeTokens(row.id); }
  catch (error) { ElMessage.error((error as Error).message); employeeTokenRows.value = []; }
  finally { tokenListLoading.value = false; }
}

async function revokeToken(row: EmployeeTokenInfo): Promise<void> {
  if (!selected.value) return;
  try { await ElMessageBox.confirm(`吊销“${row.name}”后，对应 WorkBuddy 连接会立即失效。`, "确认吊销员工令牌", { type: "warning" }); } catch { return; }
  if (!await runAction(() => revokeEmployeeToken(selected.value!.id, row.id), "令牌已吊销")) return;
  employeeTokenRows.value = await fetchEmployeeTokens(selected.value.id);
  await load();
}

async function copyToken(): Promise<void> {
  try {
    await navigator.clipboard.writeText(issuedToken.value);
    ElMessage.success("已复制；关闭后无法再次查看，请妥善保存");
  } catch {
    ElMessage.error("复制失败，请手动选择令牌文本；不要粘贴到公开渠道");
  }
}

function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleString("zh-CN") : "—";
}

function tokenStatus(row: EmployeeTokenInfo): { label: string; type: "success" | "info" | "warning" } {
  if (row.revokedAt) return { label: "已吊销", type: "info" };
  if (new Date(row.expiresAt).getTime() <= Date.now()) return { label: "已过期", type: "warning" };
  return { label: "有效", type: "success" };
}

onMounted(() => { void loadOptions(); void load(); });
</script>

<template>
  <main class="page-shell">
    <section class="page-heading">
      <div><p>员工不是 Web 用户。管理员建档后，按员工、按设备发放独立令牌。</p></div>
      <el-button type="primary" @click="createVisible = true">新建员工</el-button>
    </section>
    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false"><template #default><el-button link type="primary" @click="load">重试</el-button></template></el-alert>
    <el-card shadow="never" class="content-card">
      <div class="filter-row">
        <el-input v-model="keyword" clearable placeholder="搜索手机号、姓名或邮箱" style="width: 300px" @keyup.enter="applyFilters" />
        <el-select v-model="departmentFilter" clearable placeholder="全部部门" style="width: 150px"><el-option v-for="item in departments" :key="item.id" :label="item.name" :value="item.id" /></el-select>
        <el-select v-model="statusFilter" clearable placeholder="全部状态" style="width: 130px"><el-option label="启用" value="active" /><el-option label="停用" value="disabled" /></el-select>
        <el-button type="primary" @click="applyFilters">查询</el-button><el-button @click="resetFilters">重置</el-button>
      </div>
      <el-table v-loading="loading" :data="rows" style="width: 100%" empty-text="暂无员工档案">
        <el-table-column label="手机号" width="160"><template #default="{ row }">{{ row.phone || '待补充' }}</template></el-table-column>
        <el-table-column prop="name" label="姓名" min-width="140" />
        <el-table-column prop="email" label="邮箱" min-width="220"><template #default="{ row }">{{ row.email || '—' }}</template></el-table-column>
        <el-table-column label="部门" width="140"><template #default="{ row }">{{ row.departmentName || '—' }}</template></el-table-column>
        <el-table-column label="状态" width="110"><template #default="{ row }"><el-tag :type="row.status === 'active' ? 'success' : 'info'">{{ row.status === 'active' ? '启用' : '停用' }}</el-tag></template></el-table-column>
        <el-table-column prop="activeTokens" label="有效令牌" width="100" />
        <el-table-column label="最近连接" width="180"><template #default="{ row }">{{ formatTime(row.lastConnectedAt) }}</template></el-table-column>
        <el-table-column label="操作" width="300" fixed="right"><template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button link type="primary" :disabled="row.status !== 'active'" @click="issue(row)">发放令牌</el-button>
          <el-button link type="primary" @click="openTokens(row)">令牌列表</el-button>
          <el-button link :type="row.status === 'active' ? 'danger' : 'success'" @click="toggleStatus(row)">{{ row.status === 'active' ? '停用' : '启用' }}</el-button>
        </template></el-table-column>
      </el-table>
      <el-pagination v-model:current-page="page" v-model:page-size="pageSize" class="table-pagination" :page-sizes="[20, 50, 100]" layout="total, sizes, prev, pager, next" :total="total" @current-change="load" @size-change="changePageSize" />
    </el-card>

    <el-dialog v-model="createVisible" title="新建员工档案" width="520px">
      <el-form label-position="top"><el-form-item label="手机号" required><el-input v-model="createForm.phone" maxlength="16" placeholder="例如：13800138000" /></el-form-item><el-form-item label="姓名" required><el-input v-model="createForm.name" maxlength="128" /></el-form-item><el-form-item label="邮箱（可选）"><el-input v-model="createForm.email" maxlength="256" /></el-form-item><el-form-item label="部门（可选）"><el-select v-model="createForm.departmentId" clearable style="width: 100%"><el-option v-for="item in departments" :key="item.id" :label="item.name" :value="item.id" /></el-select></el-form-item></el-form>
      <template #footer><el-button :disabled="actionLoading" @click="createVisible = false">取消</el-button><el-button type="primary" :loading="actionLoading" :disabled="!createForm.phone.trim() || !createForm.name.trim()" @click="submitCreate">创建员工</el-button></template>
    </el-dialog>
    <el-dialog v-model="editVisible" :title="`编辑员工档案 · ${selected?.name ?? ''}`" width="520px">
      <el-form label-position="top"><el-form-item label="手机号" required><el-input v-model="editForm.phone" maxlength="16" placeholder="例如：13800138000" /></el-form-item><el-form-item label="姓名" required><el-input v-model="editForm.name" maxlength="128" /></el-form-item><el-form-item label="邮箱（可选）"><el-input v-model="editForm.email" maxlength="256" /></el-form-item><el-form-item label="部门（可选）"><el-select v-model="editForm.departmentId" clearable style="width: 100%"><el-option v-for="item in departments" :key="item.id" :label="item.name" :value="item.id" /></el-select></el-form-item></el-form>
      <template #footer><el-button :disabled="actionLoading" @click="editVisible = false">取消</el-button><el-button type="primary" :loading="actionLoading" :disabled="!editForm.phone.trim() || !editForm.name.trim()" @click="submitEdit">保存修改</el-button></template>
    </el-dialog>
    <el-dialog v-model="tokenVisible" :title="`发放连接器令牌 · ${selected?.name ?? ''}`" width="620px" :close-on-click-modal="!issuedToken" :close-on-press-escape="!issuedToken" :show-close="!issuedToken">
      <template v-if="!issuedToken"><el-form label-position="top"><el-form-item label="设备/用途备注" required><el-input v-model="tokenForm.name" maxlength="128" /></el-form-item><el-form-item label="有效期（天）" required><el-input-number v-model="tokenForm.expiresInDays" :min="1" :max="365" /></el-form-item></el-form></template>
      <template v-else><el-alert title="令牌明文仅显示这一次，关闭后无法再次查看；服务端不会保存明文。" type="warning" show-icon :closable="false" /><el-input :model-value="issuedToken" readonly type="textarea" :rows="3" style="margin-top: 16px" /><el-button style="margin-top: 12px" type="primary" @click="copyToken">复制令牌</el-button></template>
      <template #footer><el-button v-if="!issuedToken" :disabled="actionLoading" @click="tokenVisible = false">取消</el-button><el-button v-if="issuedToken" type="danger" plain :disabled="actionLoading" @click="cancelIssuedToken">吊销并关闭</el-button><el-button v-if="issuedToken" type="primary" @click="closeIssuedToken">关闭</el-button><el-button v-else type="primary" :loading="actionLoading" :disabled="!tokenForm.name.trim()" @click="submitToken">生成令牌</el-button></template>
    </el-dialog>
    <el-dialog v-model="tokenListVisible" :title="`连接器令牌 · ${selected?.name ?? ''}`" width="680px">
      <el-table v-loading="tokenListLoading" :data="employeeTokenRows" style="width: 100%" empty-text="暂无令牌">
        <el-table-column prop="name" label="设备/用途" min-width="160" />
        <el-table-column label="到期时间" width="180"><template #default="{ row }">{{ formatTime(row.expiresAt) }}</template></el-table-column>
        <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="tokenStatus(row).type">{{ tokenStatus(row).label }}</el-tag></template></el-table-column>
        <el-table-column label="操作" width="90"><template #default="{ row }"><el-button v-if="tokenStatus(row).label === '有效'" link type="danger" @click="revokeToken(row)">吊销</el-button></template></el-table-column>
      </el-table>
    </el-dialog>
  </main>
</template>
