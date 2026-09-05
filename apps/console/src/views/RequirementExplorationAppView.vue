<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import {
  fetchExplorationPolicyOptions,
  fetchRequirementExplorationApplication,
  initializeRequirementExplorationSkill,
  updateExplorationPolicy,
  updateRequirementExplorationTriggerPhrases,
  type ExplorationPolicyOption,
  type RequirementExplorationApplication,
} from "../api";

const loading = ref(true);
const loadError = ref("");
const initializing = ref(false);
const savingPolicy = ref(false);
const savingTriggers = ref(false);
const application = ref<RequirementExplorationApplication | null>(null);
const options = ref<ExplorationPolicyOption[]>([]);
const invalidPolicyBinding = ref(false);
const advancedSettings = ref<string[]>([]);
const savedPolicySignature = ref("");
const triggerPhrases = ref<string[]>([]);
const savedTriggerSignature = ref("[]");

const policyForm = reactive({
  skillVersionId: "",
  blockedSkillVersionIds: [] as string[],
  enabled: false,
});
const selected = computed(() => options.value.find((item) => item.skillVersionId === policyForm.skillVersionId));
const selectedSkillId = ref("");
const applicationSkills = computed(() => {
  const byId = new Map<string, { id: string; name: string; slug: string }>();
  for (const item of options.value) {
    if (!byId.has(item.skillId)) {
      byId.set(item.skillId, { id: item.skillId, name: item.skillName, slug: item.slug });
    }
  }
  return [...byId.values()];
});
const versionsForSelectedSkill = computed(() =>
  options.value.filter((item) => item.skillId === selectedSkillId.value));
const hasApplicationSkills = computed(() => options.value.length > 0);
const selectedVersionBlocked = computed(() => Boolean(
  selected.value
  && policyForm.blockedSkillVersionIds.includes(selected.value.skillVersionId),
));
function serializePolicySignature(
  skillVersionId: string,
  blockedSkillVersionIds: string[],
  enabled: boolean,
): string {
  return JSON.stringify({
    skillVersionId,
    blockedSkillVersionIds: [...blockedSkillVersionIds].sort(),
    enabled,
  });
}
function policySignature(): string {
  return serializePolicySignature(
    policyForm.skillVersionId,
    policyForm.blockedSkillVersionIds,
    policyForm.enabled,
  );
}
const policyDirty = computed(() => savedPolicySignature.value !== policySignature());
const triggerDirty = computed(() => JSON.stringify(triggerPhrases.value) !== savedTriggerSignature.value);
const runSummary = computed(() => {
  if (!policyForm.enabled) {
    return policyDirty.value
      ? "尚未保存：保存后应用将暂停，历史内容仍可查看。"
      : "应用当前已暂停，历史内容仍可查看。";
  }
  if (!selected.value) return "请选择一个规则版本后保存。";
  if (selectedVersionBlocked.value) {
    return policyDirty.value
      ? `尚未保存：保存后「${selected.value.skillName}」${selected.value.version} 将被紧急停用。`
      : `应用当前不可运行：激活版本「${selected.value.skillName}」${selected.value.version} 已被紧急停用。`;
  }
  return policyDirty.value
      ? `尚未保存：保存后新探索将使用「${selected.value.skillName}」${selected.value.version}。`
      : `应用当前已启用，新探索使用「${selected.value.skillName}」${selected.value.version}。`;
});

function syncForms(detail: RequirementExplorationApplication, available: ExplorationPolicyOption[]): void {
  application.value = detail;
  // 保存运行策略会重新加载页面数据；此时不能覆盖另一个独立表单中的未保存草稿。
  if (!triggerDirty.value) {
    triggerPhrases.value = [...detail.triggerPhrases];
    savedTriggerSignature.value = JSON.stringify(detail.triggerPhrases);
  }
  options.value = available;
  const policy = detail.policy;
  invalidPolicyBinding.value = Boolean(
    policy?.skillVersionId
    && !available.some((item) => item.skillVersionId === policy.skillVersionId),
  );
  policyForm.skillVersionId = policy?.skillVersionId && !invalidPolicyBinding.value
    ? policy.skillVersionId
    : available[0]?.skillVersionId ?? "";
  selectedSkillId.value = available.find((item) => item.skillVersionId === policyForm.skillVersionId)?.skillId
    ?? available[0]?.skillId
    ?? "";
  policyForm.blockedSkillVersionIds = policy?.blockedSkillVersionIds ?? [];
  policyForm.enabled = policy?.enabled ?? false;
  savedPolicySignature.value = serializePolicySignature(
    policy?.skillVersionId ?? "",
    policy?.blockedSkillVersionIds ?? [],
    policy?.enabled ?? false,
  );
}

async function saveTriggers(): Promise<void> {
  if (savingTriggers.value) return;
  const submitted = [...triggerPhrases.value];
  savingTriggers.value = true;
  try {
    const saved = await updateRequirementExplorationTriggerPhrases(submitted);
    // 回执只代表提交时的快照，保存期间的后续编辑仍是未保存草稿。
    if (JSON.stringify(triggerPhrases.value) === JSON.stringify(submitted)) {
      triggerPhrases.value = [...saved];
    }
    savedTriggerSignature.value = JSON.stringify(saved);
    if (application.value) application.value.triggerPhrases = [...saved];
    ElMessage.success(triggerDirty.value ? "本次触发词已保存，后续修改尚未保存" : "应用触发词已生效");
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    savingTriggers.value = false;
  }
}

function selectApplicationSkill(skillId: string): void {
  selectedSkillId.value = skillId;
  policyForm.skillVersionId = options.value.find((item) => item.skillId === skillId)?.skillVersionId ?? "";
  policyForm.blockedSkillVersionIds = policyForm.blockedSkillVersionIds.filter((id) =>
    options.value.some((item) => item.skillId === skillId && item.skillVersionId === id));
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = "";
  try {
    const [detail, available] = await Promise.all([
      fetchRequirementExplorationApplication(),
      fetchExplorationPolicyOptions(),
    ]);
    syncForms(detail, available);
  } catch (error) {
    loadError.value = (error as Error).message;
  } finally {
    loading.value = false;
  }
}

async function initializeSkill(): Promise<void> {
  initializing.value = true;
  try {
    await initializeRequirementExplorationSkill();
    ElMessage.success("内置需求探索规则已初始化");
    await load();
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    initializing.value = false;
  }
}

async function savePolicy(): Promise<void> {
  if (!selected.value) return;
  const validVersionIds = new Set(versionsForSelectedSkill.value.map((item) => item.skillVersionId));
  const blockedSkillVersionIds = policyForm.blockedSkillVersionIds.filter((id) => validVersionIds.has(id));
  const activeVersionBlocked = blockedSkillVersionIds.includes(selected.value.skillVersionId);
  try {
    await ElMessageBox.confirm(
      !policyForm.enabled
        ? "停用后会立即阻止所有需求探索的新建、保存、提交和放弃；已有内容仍可查询。"
        : activeVersionBlocked
          ? "当前激活版本同时被紧急禁止：新探索无法开始，该版本的历史探索也不能继续写入。"
          : "激活后，新探索将锁定该规则版本；已有探索仍使用各自开始时的版本。",
      "确认更新需求探索应用",
      { type: "warning" },
    );
  } catch {
    return;
  }
  savingPolicy.value = true;
  try {
    await updateExplorationPolicy({
      skillId: selected.value.skillId,
      skillVersionId: selected.value.skillVersionId,
      blockedSkillVersionIds,
      enabled: policyForm.enabled,
    });
    ElMessage.success(
      !policyForm.enabled
        ? "需求探索应用写入已停用"
        : activeVersionBlocked
          ? "配置已保存，当前激活版本已紧急停用"
          : "需求探索应用配置已生效",
    );
    await load();
  } catch (error) {
    ElMessage.error(`${(error as Error).message}；应用配置未更新`);
  } finally {
    savingPolicy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <main class="page-shell">
    <router-link to="/applications" class="back-link">← 返回应用</router-link>
    <section class="page-heading">
      <div>
        <p>内置应用 · 固定业务流程与 MCP 工具，运行时引用已发布且兼容的应用 Skill。</p>
      </div>
      <div class="heading-actions">
        <router-link to="/explorations"><el-button>查看探索记录</el-button></router-link>
        <router-link to="/requirements"><el-button>查看正式需求</el-button></router-link>
      </div>
    </section>

    <el-alert v-if="loadError" :title="loadError" type="error" show-icon :closable="false">
      <template #default><el-button link type="primary" @click="load">重试</el-button></template>
    </el-alert>
    <el-skeleton v-if="loading" :rows="8" animated />

    <template v-else-if="application && !loadError">
      <el-card shadow="never" class="content-card">
        <template #header><strong>WorkBuddy 触发</strong></template>
        <el-form label-position="top" class="form-column">
          <el-form-item label="触发词">
            <el-select
              v-model="triggerPhrases"
              multiple
              filterable
              allow-create
              default-first-option
              clearable
              :multiple-limit="20"
              style="width: 100%"
              placeholder="输入短语后按回车，例如：需求探索"
            />
            <div class="field-help">
              员工原话命中这些短语时会优先发现本应用；应用 Skill 本身不参与企业助手检索。最多 20 个，每个不超过 64 个字符。
            </div>
          </el-form-item>
          <el-button type="primary" :loading="savingTriggers" :disabled="!triggerDirty" @click="saveTriggers">
            保存触发词
          </el-button>
        </el-form>
      </el-card>

      <el-card v-if="!hasApplicationSkills" shadow="never" class="content-card">
        <template #header><strong>需求探索应用 Skill</strong></template>
        <el-empty description="尚无可关联的应用 Skill">
          <p class="empty-help">可以初始化系统基线；也可以先在“Skill 管理 → 发布 Skill”中发布应用 Skill，再回到这里选择。</p>
          <el-button type="primary" :loading="initializing" @click="initializeSkill">初始化系统基线</el-button>
        </el-empty>
      </el-card>

      <template v-else>
        <el-card shadow="never" class="content-card">
          <template #header>
            <div class="card-header">
              <strong>当前运行 Skill</strong>
            </div>
          </template>
          <el-alert
            title="从满足需求探索契约的应用 Skill 候选版本中选择当前运行对象。保存后只影响新探索。"
            type="info"
            show-icon
            :closable="false"
          />
          <p class="field-help">应用 Skill 不会出现在企业 Skill 助手的普通 Skill 检索、动态 Prompt 或通用详情接口中。</p>
          <el-form label-position="top" class="form-column association-form">
            <el-form-item label="当前 Skill" required>
              <el-select
                v-model="selectedSkillId"
                filterable
                style="width: 100%"
                placeholder="选择已有应用 Skill"
                @change="selectApplicationSkill"
              >
                <el-option
                  v-for="skill in applicationSkills"
                  :key="skill.id"
                  :label="`${skill.name}（${skill.slug}）`"
                  :value="skill.id"
                />
              </el-select>
            </el-form-item>
          </el-form>
        </el-card>

        <el-card shadow="never" class="content-card">
          <template #header><strong>应用运行</strong></template>
          <el-alert
            v-if="invalidPolicyBinding"
            title="原运行配置绑定了普通或测试 Skill，现已从候选项中移除。请确认规则版本并保存应用配置。"
            type="warning"
            show-icon
            :closable="false"
            style="margin-bottom: 12px"
          />
          <el-alert
            :title="runSummary"
            :type="policyDirty || selectedVersionBlocked ? 'warning' : policyForm.enabled ? 'success' : 'info'"
            show-icon
            :closable="false"
          />
          <el-form label-position="top" class="form-column policy-form">
            <el-form-item label="运行版本" required>
              <el-select v-model="policyForm.skillVersionId" filterable style="width: 100%" placeholder="选择已发布规则版本">
                <el-option
                  v-for="item in versionsForSelectedSkill"
                  :key="item.skillVersionId"
                  :label="item.version"
                  :value="item.skillVersionId"
                />
              </el-select>
              <div class="field-help">只影响保存配置后新开始的探索，已有探索不会中途换版。</div>
            </el-form-item>
            <el-form-item label="应用状态">
              <el-switch v-model="policyForm.enabled" active-text="启用" inactive-text="暂停" />
              <div class="field-help">暂停会停止所有需求探索写入，但不会删除已保存内容。</div>
            </el-form-item>

            <el-collapse v-model="advancedSettings" class="advanced-settings">
              <el-collapse-item name="advanced">
                <template #title>
                  <span class="advanced-title">应急设置</span>
                  <span class="advanced-hint">仅在规则存在风险时使用</span>
                </template>
                <el-form-item label="已停用的历史规则版本">
                  <el-select v-model="policyForm.blockedSkillVersionIds" multiple clearable collapse-tags collapse-tags-tooltip style="width: 100%" placeholder="无">
                    <el-option
                      v-for="item in versionsForSelectedSkill"
                      :key="item.skillVersionId"
                      :label="`${item.version}${item.skillVersionId === policyForm.skillVersionId ? '（当前选择）' : ''}`"
                      :value="item.skillVersionId"
                    />
                  </el-select>
                  <div class="field-help">仅在某个历史版本存在错误或合规风险时使用；对应探索仍可查看，但不能继续写入。</div>
                </el-form-item>
              </el-collapse-item>
            </el-collapse>
            <el-button type="primary" :loading="savingPolicy" :disabled="!policyDirty || !selected" @click="savePolicy">保存更改</el-button>
          </el-form>
        </el-card>
      </template>
    </template>
  </main>
</template>

<style scoped>
.heading-actions, .card-header { display: flex; align-items: center; gap: 12px; }
.card-header { justify-content: space-between; width: 100%; }
.policy-form { margin-top: 20px; }
.association-form { margin-top: 16px; }
.field-help, .empty-help { color: var(--text-secondary); font-size: 12px; margin-top: 6px; }
.advanced-settings { margin: 0 0 20px; }
.advanced-title { font-weight: 600; }
.advanced-hint { color: var(--text-secondary); font-size: 12px; margin-left: 8px; font-weight: 400; }
@media (max-width: 720px) {
  .heading-actions { align-items: stretch; flex-direction: column; }
  .heading-actions a, .heading-actions .el-button { width: 100%; }
}
</style>
