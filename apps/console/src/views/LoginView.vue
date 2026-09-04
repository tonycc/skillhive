<script setup lang="ts">
import { reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { login } from "../api";

/** 管理员登录页：员工只通过 WorkBuddy 使用产品。 */
const route = useRoute();
const router = useRouter();
const form = reactive({ email: "", password: "" });
const submitting = ref(false);

async function onSubmit(): Promise<void> {
  if (!form.email || !form.password) {
    ElMessage.warning("请输入邮箱和密码");
    return;
  }
  submitting.value = true;
  try {
    const user = await login(form.email, form.password);
    ElMessage.success(`欢迎，${user.name}`);
    const candidate = typeof route.query.redirect === "string" ? route.query.redirect : "/";
    const redirect = candidate.startsWith("/") && !candidate.startsWith("//") ? candidate : "/";
    router.push(redirect);
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="login-shell">
    <el-card class="login-card">
      <h1 class="login-title">🐝 SkillHive 管理平台</h1>
      <p
        style="
          margin: 0 0 24px;
          text-align: center;
          font-size: 13px;
          color: var(--text-secondary);
        "
      >
        仅限管理员登录；员工请在 WorkBuddy 中使用 SkillHive 连接器
      </p>
      <el-form label-position="top" @submit.prevent="onSubmit">
        <el-form-item label="管理员邮箱">
          <el-input
            v-model="form.email"
            placeholder="请输入管理员邮箱"
            autocomplete="username"
            autofocus
          />
        </el-form-item>
        <el-form-item label="密码">
          <el-input
            v-model="form.password"
            type="password"
            show-password
            autocomplete="current-password"
          />
        </el-form-item>
        <el-button
          type="primary"
          style="width: 100%"
          :loading="submitting"
          native-type="submit"
        >
          登录
        </el-button>
      </el-form>
    </el-card>
  </div>
</template>

<style scoped>
.login-shell {
  display: flex;
  justify-content: center;
  padding-top: 64px;
}

.login-card {
  width: min(400px, 100%);
}

.login-title {
  margin: 0 0 8px;
  text-align: center;
  font-size: 24px;
}

@media (max-width: 480px) {
  .login-shell {
    padding-top: 24px;
  }
}
</style>
