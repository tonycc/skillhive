<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { ElMessage, type UploadFile } from "element-plus";
import {
  parseSkillMd,
  parseSkillPackageZip,
  type SkillFrontmatter,
  type SkillResourceFile,
} from "@skillhive/skill-schema";
import { publishSkill } from "../api";

/**
 * 发布技能（仅上传模式）：
 * - zip 压缩技能包（SKILL.md + scripts/references/assets），浏览器内自动解压
 * - 单个 SKILL.md 文件
 * 表单编辑模式已移除，技能内容请在本地编辑器/Claude Code 中编写后打包上传。
 */

const router = useRouter();

/** 已解析、待确认发布的技能包 */
interface PendingPackage {
  sourceName: string;
  content: string;
  frontmatter: SkillFrontmatter;
  files: SkillResourceFile[];
  skipped: string[];
}

const pending = ref<PendingPackage | null>(null);
const changelog = ref("");
const submitting = ref(false);
const parsing = ref(false);
let parseRequestId = 0;

async function onFileChange(uploadFile: UploadFile): Promise<void> {
  const file = uploadFile.raw;
  if (!file) return;
  const requestId = ++parseRequestId;
  // 新选择代表用户已经放弃旧包；即使本次解析失败，也绝不能继续提交旧结果。
  pending.value = null;
  parsing.value = true;
  try {
    if (file.name.toLowerCase().endsWith(".zip")) {
      const pkg = await parseSkillPackageZip(await file.arrayBuffer());
      if (requestId !== parseRequestId) return;
      pending.value = { sourceName: file.name, ...pkg };
    } else {
      const text = await file.text();
      if (requestId !== parseRequestId) return;
      const parsed = parseSkillMd(text);
      if (requestId !== parseRequestId) return;
      pending.value = {
        sourceName: file.name,
        content: text,
        frontmatter: parsed.frontmatter,
        files: [],
        skipped: [],
      };
    }
    ElMessage.success(`已解析「${pending.value.frontmatter.name}」，请确认后发布`);
  } catch (err) {
    if (requestId !== parseRequestId) return;
    pending.value = null;
    ElMessage.error((err as Error).message);
  } finally {
    if (requestId === parseRequestId) parsing.value = false;
  }
}

function onReset(): void {
  parseRequestId += 1;
  parsing.value = false;
  pending.value = null;
  changelog.value = "";
}

/** base64 长度换算为可读文件大小 */
function fileSize(contentBase64: string): string {
  const bytes = Math.ceil((contentBase64.length * 3) / 4);
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

async function onSubmit(): Promise<void> {
  if (!pending.value || parsing.value) return;
  submitting.value = true;
  try {
    await publishSkill(pending.value.content, changelog.value.trim(), pending.value.files);
    ElMessage.success(`技能「${pending.value.frontmatter.name}」发布成功`);
    router.push(`/skills/${encodeURIComponent(pending.value.frontmatter.name)}`);
  } catch (err) {
    // 版本冲突（409）等错误信息由 Registry 返回，直接展示
    ElMessage.error((err as Error).message);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section aria-labelledby="publish-title">
    <h1 id="publish-title" class="page-title">发布技能</h1>
    <p class="page-description">上传经过校验的 SKILL.md 或完整技能包。</p>
    <div class="form-column">
    <el-upload
      drag
      :auto-upload="false"
      :show-file-list="false"
      :disabled="parsing || submitting"
      accept=".zip,.md"
      :on-change="onFileChange"
      style="width: 100%; margin-bottom: 24px"
    >
      <div style="padding: 12px">
        <p style="margin: 0; font-size: 15px">
          📦 拖拽或点击上传 <strong>技能包 zip</strong> 或 <strong>SKILL.md</strong>
        </p>
        <p style="margin: 6px 0 0; font-size: 13px; color: var(--text-secondary)">
          zip 结构：SKILL.md（根目录必需）+ scripts/ references/ assets/（可选资源），
          系统自动解压并校验
        </p>
      </div>
    </el-upload>

    <el-skeleton v-if="parsing" :rows="3" animated aria-label="技能包解析中" />

    <!-- 解析结果确认 -->
    <el-card v-if="pending" style="width: 100%">
      <el-descriptions :column="2" border size="small">
        <el-descriptions-item label="技能标识">
          {{ pending.frontmatter.name }}
        </el-descriptions-item>
        <el-descriptions-item label="版本">
          {{ pending.frontmatter.version ?? "0.1.0" }}
        </el-descriptions-item>
        <el-descriptions-item label="描述" :span="2">
          {{ pending.frontmatter.description }}
        </el-descriptions-item>
        <el-descriptions-item label="分类">
          {{ pending.frontmatter.category ?? "通用" }}
        </el-descriptions-item>
        <el-descriptions-item label="来源文件">
          {{ pending.sourceName }}
        </el-descriptions-item>
      </el-descriptions>

      <div style="margin: 12px 0; font-size: 13px">
        <template v-if="pending.files.length > 0">
          <p style="margin: 0 0 6px; color: var(--text-secondary)">
            资源文件（{{ pending.files.length }} 个）：
          </p>
          <p v-for="f in pending.files" :key="f.path" style="margin: 2px 0">
            📎 {{ f.path }}
            <span style="color: var(--text-secondary)">（{{ fileSize(f.contentBase64) }}）</span>
          </p>
        </template>
        <p v-else style="margin: 0; color: var(--text-secondary)">无资源文件（纯提示词技能）</p>
        <el-alert
          v-if="pending.skipped.length > 0"
          type="info"
          :closable="false"
          style="margin-top: 8px"
          title="以下文件不在 scripts/references/assets 目录中，已忽略"
          :description="pending.skipped.join('、')"
        />
      </div>

      <el-input
        v-model="changelog"
        placeholder="变更说明（可选）：本次发布/修改了什么"
        style="margin-bottom: 12px"
      />

      <el-button type="primary" :loading="submitting" @click="onSubmit">确认发布</el-button>
      <el-button @click="onReset">重新选择</el-button>
    </el-card>
    </div>
  </section>
</template>
