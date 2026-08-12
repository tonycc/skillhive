<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { marked } from "marked";
import type { ElTree } from "element-plus";
import { fetchSkillDetail, reportEvent, type SkillDetail } from "../api";

const props = defineProps<{ slug: string }>();

const skill = ref<SkillDetail | null>(null);
const bodyHtml = ref("");
const loading = ref(true);
const notFound = ref(false);

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
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/** base64 → UTF-8 文本 */
function decodeBase64(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

async function selectFile(path: string): Promise<void> {
  if (path === "SKILL.md") {
    preview.value = {
      path,
      kind: "markdown",
      html: await marked.parse(skill.value?.latestVersion?.body ?? ""),
    };
    return;
  }
  const file = skill.value?.latestVersion?.files.find((f) => f.path === path);
  if (!file) return;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "md") {
    preview.value = { path, kind: "markdown", html: await marked.parse(decodeBase64(file.contentBase64)) };
  } else if (IMG_MIME[ext]) {
    preview.value = { path, kind: "image", dataUrl: `data:${IMG_MIME[ext]};base64,${file.contentBase64}` };
  } else if (TEXT_EXTS.has(ext)) {
    preview.value = { path, kind: "text", text: decodeBase64(file.contentBase64) };
  } else {
    preview.value = { path, kind: "binary" };
  }
}

/** 点击树节点：文件 → 右侧预览；目录 → 交给默认展开/折叠 */
function onNodeClick(data: FileNode): void {
  if (data.children) return;
  void selectFile(data.path);
}

onMounted(async () => {
  try {
    skill.value = await fetchSkillDetail(props.slug);
    if (skill.value.latestVersion?.body) {
      bodyHtml.value = await marked.parse(skill.value.latestVersion.body);
    }
    // 默认选中 SKILL.md 预览
    void selectFile("SKILL.md");
    void nextTick(() => treeRef.value?.setCurrentKey("SKILL.md"));
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
      💡 在 WorkBuddy 的 / 菜单中选择「{{ skill.slug }}」即可使用本技能；
      也可以在对话中说「用 {{ skill.name }} 帮我…」让 AI 自动调用。
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
          <template v-if="preview">
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
            <el-empty v-else description="二进制文件，暂不支持预览" :image-size="60" />
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
</style>
