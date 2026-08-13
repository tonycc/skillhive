<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { fetchTokens, createToken, revokeToken, type PatInfo } from "../api";

/** 接入设置：管理用于 WorkBuddy 等 MCP 客户端的个人接入令牌（PAT） */

const tokens = ref<PatInfo[]>([]);
const loading = ref(true);
const newName = ref("");
const creating = ref(false);
/** 刚生成的令牌明文（仅此一次可见） */
const createdToken = ref("");

/** 生成后展示给用户的 MCP 配置片段（令牌已填入） */
const configSnippet = computed(() =>
  JSON.stringify(
    {
      mcpServers: {
        skillhive: {
          url: "http://服务器地址:3100/sse",
          headers: { Authorization: `Bearer ${createdToken.value}` },
        },
      },
    },
    null,
    2,
  ),
);

async function reload(): Promise<void> {
  loading.value = true;
  try {
    tokens.value = await fetchTokens();
  } finally {
    loading.value = false;
  }
}

async function onCreate(): Promise<void> {
  creating.value = true;
  try {
    const { token } = await createToken(newName.value.trim());
    createdToken.value = token;
    newName.value = "";
    await reload();
    ElMessage.success("令牌已生成，请立即复制保存");
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    creating.value = false;
  }
}

async function onCopy(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  ElMessage.success("已复制到剪贴板");
}

async function onRevoke(row: PatInfo): Promise<void> {
  await ElMessageBox.confirm(
    "吊销后使用该令牌的 MCP 客户端将立即无法连接，确定吊销？",
    "吊销令牌",
    { type: "warning", confirmButtonText: "吊销", cancelButtonText: "取消" },
  );
  try {
    await revokeToken(row.id);
    await reload();
    ElMessage.success("已吊销");
  } catch (err) {
    ElMessage.error((err as Error).message);
  }
}

function formatTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString("zh-CN") : "-";
}

onMounted(reload);
</script>

<template>
  <h2 style="margin: 16px 0">接入设置</h2>
  <p style="color: var(--text-secondary); font-size: 13px; max-width: 720px">
    接入令牌（PAT）用于 WorkBuddy 等 MCP 客户端连接 SkillHive。
    生成后把下方配置片段填入客户端的 MCP 配置文件（如 ~/.workbuddy/mcp.json），重启客户端生效。
  </p>

  <!-- 生成新令牌 -->
  <el-card style="max-width: 720px; margin-bottom: 16px">
    <div style="display: flex; gap: 12px">
      <el-input
        v-model="newName"
        placeholder="备注（可选），如：工作 Mac 的 WorkBuddy"
        @keyup.enter="onCreate"
      />
      <el-button type="primary" :loading="creating" @click="onCreate">生成令牌</el-button>
    </div>

    <!-- 令牌明文仅显示一次 -->
    <template v-if="createdToken">
      <el-alert type="success" :closable="false" style="margin-top: 16px" title="令牌已生成（仅显示一次，请立即保存）" />
      <div class="token-box">
        <code>{{ createdToken }}</code>
        <el-button size="small" @click="onCopy(createdToken)">复制令牌</el-button>
      </div>
      <p style="font-size: 13px; color: var(--text-secondary); margin: 12px 0 4px">
        MCP 配置片段（已填入令牌，直接粘贴到配置文件）：
      </p>
      <pre class="config-box">{{ configSnippet }}</pre>
      <el-button size="small" @click="onCopy(configSnippet)">复制配置</el-button>
    </template>
  </el-card>

  <!-- 令牌列表 -->
  <el-card style="max-width: 720px">
    <el-table :data="tokens" v-loading="loading" size="small">
      <el-table-column prop="name" label="备注">
        <template #default="{ row }">{{ row.name || "（无备注）" }}</template>
      </el-table-column>
      <el-table-column label="创建时间" width="160">
        <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="最近使用" width="160">
        <template #default="{ row }">{{ formatTime(row.lastUsedAt) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="80">
        <template #default="{ row }">
          <el-tag :type="row.revoked ? 'info' : 'success'" size="small">
            {{ row.revoked ? "已吊销" : "有效" }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column width="90">
        <template #default="{ row }">
          <el-button
            v-if="!row.revoked"
            link
            type="danger"
            size="small"
            @click="onRevoke(row)"
          >
            吊销
          </el-button>
        </template>
      </el-table-column>
    </el-table>
  </el-card>
</template>

<style scoped>
.token-box {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
  padding: 10px 12px;
  background: var(--el-fill-color-light);
  border-radius: 6px;
}
.token-box code {
  font-family: ui-monospace, monospace;
  font-size: 13px;
  word-break: break-all;
}
.config-box {
  padding: 12px;
  font-size: 12px;
  font-family: ui-monospace, monospace;
  background: var(--el-fill-color-light);
  border-radius: 6px;
  overflow-x: auto;
}
</style>
