<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { ElTree } from "element-plus";
import {
  ApiError,
  fetchSkillDetail,
  fetchSkillFile,
  reportEvent,
  type SkillDetail,
} from "../api";
import { renderSafeMarkdown } from "../markdown";

const props = defineProps<{ slug: string }>();

const skill = ref<SkillDetail | null>(null);
const bodyHtml = ref("");
const loading = ref(true);
const errorMessage = ref("");
let skillRequestId = 0;

// ---------- 技能包文件树 + 预览 ----------

/** 目录树节点（目录有 children，文件有 size） */
interface FileNode {
  name: string;
  path: string;
  size?: number;
  children?: FileNode[];
}

/** 将 SKILL.md + 资源文件的扁平路径组装为目录树（目录在前，按名称排序） */
const fileTree = computed<FileNode[]>(() => {
  const detail = skill.value;
  if (!detail) return [];
  const root: FileNode = { name: "", path: "", children: [] };

  const insert = (path: string, size: number): void => {
    const parts = path.split("/");
    let cur = root;
    parts.forEach((name, i) => {
      const isFile = i === parts.length - 1;
      let child = cur.children?.find((c) => c.name === name);
      if (!child) {
        child = {
          name,
          path: parts.slice(0, i + 1).join("/"),
          ...(isFile ? { size } : { children: [] }),
        };
        cur.children?.push(child);
      }
      cur = child;
    });
  };

  const content = detail.latestVersion?.body ?? "";
  insert("SKILL.md", new TextEncoder().encode(content).length);
  for (const f of detail.latestVersion?.files ?? []) insert(f.path, f.size);

  const sortRec = (nodes: FileNode[]): void => {
    nodes.sort(
      (a, b) =>
        Number(!a.children) - Number(!b.children) || a.name.localeCompare(b.name),
    );
    nodes.forEach((n) => n.children && sortRec(n.children));
  };
  sortRec(root.children ?? []);
  return root.children ?? [];
});

const fileCount = computed(() => 1 + (skill.value?.latestVersion?.files.length ?? 0));

function formatSize(bytes = 0): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

// ---------- 文件预览 ----------

interface Preview {
  path: string;
  kind: "markdown" | "text" | "image" | "binary";
  html?: string;
  text?: string;
  dataUrl?: string;
}

const preview = ref<Preview | null>(null);
const previewLoading = ref(false);
const previewError = ref("");
let previewRequestId = 0;
const treeRef = ref<InstanceType<typeof ElTree>>();

/** 可按文本预览的扩展名 */
const TEXT_EXTS = new Set([
  "txt", "py", "sh", "js", "ts", "json", "yaml", "yml", "csv",
  "xml", "html", "css", "sql", "toml", "ini", "cfg", "log", "env",
]);
/** 可按图片预览的扩展名 → MIME */
const IMG_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** base64 → UTF-8 文本 */
function decodeBase64(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function hasExpectedImageSignature(extension: string, contentBase64: string): boolean {
  try {
    const binary = atob(contentBase64);
    const startsWith = (bytes: readonly number[]) =>
      bytes.every((byte, index) => binary.charCodeAt(index) === byte);
    if (extension === "png") {
      return startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    }
    if (extension === "jpg" || extension === "jpeg") {
      return startsWith([0xff, 0xd8, 0xff]);
    }
    return binary.length >= 12
      && binary.slice(0, 4) === "RIFF"
      && binary.slice(8, 12) === "WEBP";
  } catch {
    return false;
  }
}

async function selectFile(path: string): Promise<void> {
  const requestId = ++previewRequestId;
  previewError.value = "";
  if (path === "SKILL.md") {
    previewLoading.value = true;
    try {
      const html = await renderSafeMarkdown(skill.value?.latestVersion?.body ?? "");
      if (requestId !== previewRequestId) return;
      preview.value = { path, kind: "markdown", html };
    } finally {
      if (requestId === previewRequestId) previewLoading.value = false;
    }
    return;
  }
  const manifest = skill.value?.latestVersion?.files.find((file) => file.path === path);
  const version = skill.value?.latestVersion?.version;
  if (!manifest || !version) {
    preview.value = null;
    previewError.value = "资源文件不存在，请重新加载技能详情";
    return;
  }

  previewLoading.value = true;
  preview.value = null;
  try {
    const file = await fetchSkillFile(props.slug, path, version);
    if (requestId !== previewRequestId) return;
    if (file.version !== version || file.path !== path || file.size !== manifest.size) {
      throw new Error("资源文件响应与清单不一致");
    }
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    if (ext === "md") {
      const html = await renderSafeMarkdown(decodeBase64(file.contentBase64));
      if (requestId !== previewRequestId) return;
      preview.value = {
        path,
        kind: "markdown",
        html,
      };
    } else if (IMG_MIME[ext]) {
      if (!hasExpectedImageSignature(ext, file.contentBase64)) {
        throw new Error("资源图片格式无效");
      }
      preview.value = {
        path,
        kind: "image",
        dataUrl: `data:${IMG_MIME[ext]};base64,${file.contentBase64}`,
      };
    } else if (TEXT_EXTS.has(ext)) {
      preview.value = { path, kind: "text", text: decodeBase64(file.contentBase64) };
    } else {
      preview.value = { path, kind: "binary" };
    }
  } catch (error) {
    if (requestId !== previewRequestId) return;
    previewError.value = error instanceof ApiError && error.status === 403
      ? "你已无权读取该资源文件"
      : error instanceof ApiError && error.status === 404
        ? "资源文件不存在或版本已更新"
        : "资源文件加载失败，请稍后重试";
  } finally {
    if (requestId === previewRequestId) previewLoading.value = false;
  }
}

function retryPreview(): void {
  const path = treeRef.value?.getCurrentKey();
  if (typeof path === "string") void selectFile(path);
}

/** 点击树节点：文件 → 右侧预览；目录 → 交给默认展开/折叠 */
function onNodeClick(data: FileNode): void {
  if (data.children) return;
  void selectFile(data.path);
}

async function loadSkill(): Promise<void> {
  const requestId = ++skillRequestId;
  const requestedSlug = props.slug;
  loading.value = true;
  errorMessage.value = "";
  skill.value = null;
  previewRequestId += 1;
  preview.value = null;
  previewLoading.value = false;
  previewError.value = "";
  bodyHtml.value = "";
  try {
    const detail = await fetchSkillDetail(requestedSlug);
    if (requestId !== skillRequestId) return;
    const renderedBody = detail.latestVersion?.body
      ? await renderSafeMarkdown(detail.latestVersion.body)
      : "";
    if (requestId !== skillRequestId) return;
    skill.value = detail;
    bodyHtml.value = renderedBody;
    // 默认选中 SKILL.md 预览
    void selectFile("SKILL.md");
    void nextTick(() => treeRef.value?.setCurrentKey("SKILL.md"));
    // 上报浏览埋点
    if (detail.skillType === "ordinary") reportEvent(requestedSlug, "view");
  } catch (error) {
    if (requestId !== skillRequestId) return;
    if (error instanceof ApiError && error.status === 403) {
      errorMessage.value = "你没有权限查看这个技能，请联系技能负责人或管理员";
    } else if (error instanceof ApiError && error.status === 404) {
      errorMessage.value = `技能「${props.slug}」不存在或尚未发布`;
    } else {
      errorMessage.value = "技能详情加载失败，请稍后重试";
    }
  } finally {
    if (requestId === skillRequestId) loading.value = false;
  }
}

watch(() => props.slug, loadSkill, { immediate: true });
</script>

<template>
  <router-link to="/" class="back-link">← 返回 Skill 管理</router-link>

  <el-skeleton v-if="loading" :rows="6" animated style="margin-top: 24px" />

  <section v-else-if="errorMessage || !skill" aria-label="技能详情加载失败">
    <el-empty :description="errorMessage">
      <el-button type="primary" @click="loadSkill">重新加载</el-button>
    </el-empty>
  </section>

  <template v-else>
    <p style="color: var(--text-secondary); margin-top: 0">{{ skill.summary }}</p>

    <div class="detail-meta">
      <el-tag :type="skill.skillType === 'application' ? 'warning' : 'info'" effect="plain">
        {{ skill.skillType === "application" ? "应用 Skill" : "普通 Skill" }}
      </el-tag>
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

    <el-alert v-if="skill.skillType === 'ordinary'" type="warning" :closable="false" style="margin-bottom: 24px">
      💡 在 WorkBuddy 的 / 菜单中选择「{{ skill.slug }}」即可使用本技能；
      也可以在对话中说「用 {{ skill.name }} 帮我…」让 AI 自动调用。
    </el-alert>
    <el-alert v-else type="info" :closable="false" style="margin-bottom: 24px">
      此 Skill 不会被企业 Skill 助手检索；满足应用契约的版本可在对应应用中选择并激活。
    </el-alert>

    <p
      v-if="skill.latestVersion?.changelog"
      style="font-size: 13px; color: var(--text-secondary)"
    >
      最近更新：{{ skill.latestVersion.changelog }}
    </p>

    <!-- 技能包文件：左侧目录树 + 右侧预览 -->
    <el-card style="margin-bottom: 24px">
      <template #header>
        <span style="font-size: 14px">📦 技能包文件（{{ fileCount }} 个）</span>
      </template>
      <div class="pkg-layout">
        <div class="pkg-tree">
          <el-tree
            ref="treeRef"
            :data="fileTree"
            :props="{ label: 'name', children: 'children' }"
            node-key="path"
            highlight-current
            default-expand-all
            @node-click="onNodeClick"
          >
            <template #default="{ data }">
              <span style="font-size: 13px">
                {{ data.children ? "📁" : "📄" }} {{ data.name }}
                <span
                  v-if="!data.children"
                  style="color: var(--text-secondary); font-size: 12px"
                >
                  （{{ formatSize(data.size) }}）
                </span>
              </span>
            </template>
          </el-tree>
        </div>
        <div class="pkg-preview">
          <el-skeleton v-if="previewLoading" :rows="5" animated aria-label="资源文件加载中" />
          <el-empty v-else-if="previewError" :description="previewError" :image-size="60">
            <el-button type="primary" size="small" @click="retryPreview">重新加载</el-button>
          </el-empty>
          <template v-else-if="preview">
            <div class="pkg-preview-header">{{ preview.path }}</div>
            <article
              v-if="preview.kind === 'markdown'"
              class="markdown-body"
              v-html="preview.html"
            />
            <pre v-else-if="preview.kind === 'text'" class="pkg-preview-code">{{
              preview.text
            }}</pre>
            <img
              v-else-if="preview.kind === 'image'"
              :src="preview.dataUrl"
              :alt="preview.path"
              style="max-width: 100%"
            />
            <el-empty
              v-else
              :description="preview.path.toLowerCase().endsWith('.svg') ? '为避免执行不可信脚本，SVG 文件不提供内联预览' : '二进制文件，暂不支持预览'"
              :image-size="60"
            />
          </template>
        </div>
      </div>
    </el-card>

    <article class="markdown-body" v-html="bodyHtml" />
  </template>
</template>

<style scoped>
.pkg-layout {
  display: flex;
  gap: 16px;
  min-height: 220px;
}
.pkg-tree {
  width: 260px;
  flex-shrink: 0;
  border-right: 1px solid var(--el-border-color-lighter);
  padding-right: 12px;
  overflow-x: auto;
}
.pkg-preview {
  flex: 1;
  min-width: 0;
}
.pkg-preview-header {
  font-size: 12px;
  font-family: ui-monospace, monospace;
  color: var(--text-secondary);
  padding-bottom: 8px;
  margin-bottom: 12px;
  border-bottom: 1px dashed var(--el-border-color-lighter);
}
.pkg-preview-code {
  margin: 0;
  padding: 12px;
  font-size: 12px;
  line-height: 1.6;
  font-family: ui-monospace, monospace;
  background: var(--el-fill-color-light);
  border-radius: 6px;
  overflow-x: auto;
  white-space: pre;
}

@media (max-width: 720px) {
  .pkg-layout {
    flex-direction: column;
  }

  .pkg-tree {
    width: 100%;
    border-right: 0;
    border-bottom: 1px solid var(--el-border-color-lighter);
    padding: 0 0 12px;
  }
}
</style>
