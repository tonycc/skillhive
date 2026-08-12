<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, type FormInstance, type FormRules, type UploadFile } from "element-plus";
import { marked } from "marked";
import { parseSkillMd } from "@skillhive/skill-schema";
import { publishSkill, getAuth } from "../api";

const router = useRouter();
const formRef = ref<FormInstance>();
const submitting = ref(false);
const activeTab = ref("edit");

const CATEGORY_PRESETS = ["通用", "研发", "市场", "销售", "运营", "财务", "HR"];

const form = reactive({
  name: "",
  description: "",
  category: "通用",
  version: "0.1.0",
  tags: [] as string[],
  departments: [] as string[],
  body: "",
  changelog: "",
});

/**
 * 登录态与发布权限（路由守卫已保证到达本页时一定已登录）。
 * 发布需要 publisher / admin 角色，member 只读。
 */
const auth = getAuth();
const canPublish = auth?.user.role === "publisher" || auth?.user.role === "admin";

const rules: FormRules = {
  name: [
    { required: true, message: "请输入技能标识", trigger: "blur" },
    {
      pattern: /^[a-z0-9]+(-[a-z0-9]+)*$/,
      message: "仅支持小写字母、数字和中划线，如 weekly-report",
      trigger: "blur",
    },
  ],
  description: [{ required: true, message: "请输入一句话描述", trigger: "blur" }],
  version: [
    { required: true, message: "请输入版本号", trigger: "blur" },
    {
      pattern: /^\d+\.\d+\.\d+$/,
      message: "需符合语义化版本格式，如 1.0.0",
      trigger: "blur",
    },
  ],
  body: [{ required: true, message: "请输入技能正文（Markdown）", trigger: "blur" }],
};

/** 将表单组装为标准 SKILL.md（JSON 是合法 YAML，直接序列化避免转义问题） */
function buildSkillMd(): string {
  const lines = [
    "---",
    `name: ${form.name}`,
    `description: ${JSON.stringify(form.description)}`,
    `version: ${form.version}`,
  ];
  if (form.tags.length > 0) lines.push(`tags: ${JSON.stringify(form.tags)}`);
  lines.push(`category: ${JSON.stringify(form.category)}`);
  if (form.departments.length > 0) {
    lines.push(`departments: ${JSON.stringify(form.departments)}`);
  }
  lines.push("---", "", form.body.trim(), "");
  return lines.join("\n");
}

const previewHtml = ref("");

/** 上传 SKILL.md 文件并解析回填表单（适用于 Claude Code 等工具开发的技能包） */
function onFileChange(uploadFile: UploadFile): void {
  const file = uploadFile.raw;
  if (!file) return;
  void file.text().then((text) => {
    try {
      const parsed = parseSkillMd(text);
      form.name = parsed.frontmatter.name;
      form.description = parsed.frontmatter.description;
      form.version = parsed.frontmatter.version ?? "0.1.0";
      form.category = parsed.frontmatter.category ?? "通用";
      form.tags = parsed.frontmatter.tags ?? [];
      form.departments = parsed.frontmatter.departments ?? [];
      form.body = parsed.body;
      ElMessage.success(`已解析技能「${parsed.frontmatter.name}」，请确认信息后发布`);
    } catch (err) {
      ElMessage.error((err as Error).message);
    }
  });
}
async function refreshPreview(): Promise<void> {
  previewHtml.value = await marked.parse(form.body || "*暂无内容*");
}
const renderedPreview = computed(() => previewHtml.value);

async function onTabChange(tab: string | number): Promise<void> {
  if (tab === "preview") await refreshPreview();
}

async function onSubmit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;

  submitting.value = true;
  try {
    await publishSkill(buildSkillMd(), form.changelog);
    ElMessage.success(`技能「${form.name}」发布成功`);
    router.push(`/skills/${form.name}`);
  } catch (err) {
    // 版本冲突（409）等错误信息由 Registry 返回，直接展示
    ElMessage.error((err as Error).message);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <!-- 无发布角色（member）时只提示，全局路由守卫已保证已登录 -->
  <el-alert
    v-if="!canPublish"
    type="warning"
    :closable="false"
    title="当前账号无发布权限"
    description="发布技能需要 publisher / admin 角色，请联系 IT 管理员开通。"
    style="max-width: 720px"
  />

  <template v-else>
  <!-- 上传已有技能包（Claude Code 等工具开发的 SKILL.md） -->
  <el-upload
    drag
    :auto-upload="false"
    :show-file-list="false"
    accept=".md"
    :on-change="onFileChange"
    style="max-width: 720px; margin-bottom: 24px"
  >
    <div style="padding: 12px">
      <p style="margin: 0; font-size: 15px">
        📦 拖拽或点击上传 <strong>SKILL.md</strong> 文件
      </p>
      <p style="margin: 6px 0 0; font-size: 13px; color: var(--text-secondary)">
        适用于 Claude Code 等工具开发的技能包，解析后自动填充下方表单
        （多文件资源包暂不支持，请仅上传 SKILL.md）
      </p>
    </div>
  </el-upload>

  <el-form
    ref="formRef"
    :model="form"
    :rules="rules"
    label-position="top"
    style="max-width: 720px"
  >
    <el-form-item label="技能标识（slug，全局唯一）" prop="name">
      <el-input v-model="form.name" placeholder="如 weekly-report" />
    </el-form-item>

    <el-form-item label="一句话描述（告诉用户和 AI 何时使用它）" prop="description">
      <el-input
        v-model="form.description"
        maxlength="200"
        show-word-limit
        placeholder="如：根据本周工作要点生成结构规范的中文周报"
      />
    </el-form-item>

    <el-row :gutter="16">
      <el-col :span="8">
        <el-form-item label="分类">
          <el-select v-model="form.category" filterable allow-create style="width: 100%">
            <el-option v-for="c in CATEGORY_PRESETS" :key="c" :label="c" :value="c" />
          </el-select>
        </el-form-item>
      </el-col>
      <el-col :span="8">
        <el-form-item label="版本号" prop="version">
          <el-input v-model="form.version" placeholder="0.1.0" />
        </el-form-item>
      </el-col>
      <el-col :span="8">
        <el-form-item label="标签（可选）">
          <el-select
            v-model="form.tags"
            multiple
            filterable
            allow-create
            placeholder="回车创建"
            style="width: 100%"
          />
        </el-form-item>
      </el-col>
    </el-row>

    <el-form-item label="可见部门（不选 = 全员可见）">
      <el-select
        v-model="form.departments"
        multiple
        filterable
        allow-create
        placeholder="如：财务部"
        style="width: 100%"
      />
    </el-form-item>

    <el-form-item label="技能正文（Markdown，定义 AI 的行为方式）" prop="body">
      <el-tabs v-model="activeTab" style="width: 100%" @tab-change="onTabChange">
        <el-tab-pane label="编辑" name="edit">
          <el-input
            v-model="form.body"
            type="textarea"
            :rows="14"
            placeholder="# 技能名称&#10;&#10;你是一位…&#10;&#10;## 输出要求&#10;1. …"
            style="font-family: ui-monospace, monospace"
          />
        </el-tab-pane>
        <el-tab-pane label="预览" name="preview">
          <article class="markdown-body" v-html="renderedPreview" />
        </el-tab-pane>
      </el-tabs>
    </el-form-item>

    <el-form-item label="变更说明（可选）">
      <el-input v-model="form.changelog" placeholder="本次发布/修改了什么" />
    </el-form-item>

    <el-form-item>
      <el-button type="primary" :loading="submitting" @click="onSubmit">
        发布
      </el-button>
      <el-button @click="router.push('/')">取消</el-button>
    </el-form-item>
  </el-form>
  </template>
</template>
