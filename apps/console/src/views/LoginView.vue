<script setup lang="ts">
import { reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { login } from "../api";

/** 全局登录页：未登录访问任何页面都会被路由守卫引导到这里 */
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
    const redirect = typeof route.query.redirect === "string" ? route.query.redirect : "/";
    router.push(redirect);
  } catch (err) {
    ElMessage.error((err as Error).message);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div style="display: flex; justify-content: center; padding-top: 64px">
    <el-card style="width: 400px">
      <h2 style="margin: 0 0 8px; text-align: center">🐝 SkillHive 技能蜂巢</h2>
      <p
        style="
          margin: 0 0 24px;
          text-align: center;
          font-size: 13px;
          color: var(--text-secondary);
        "
      >
        请使用公司账号登录，账号由 IT 管理员创建
      </p>
      <el-form label-position="top" @submit.prevent>
        <el-form-item label="邮箱">
          <el-input
            v-model="form.email"
            placeholder="you@company.com"
            autofocus
            @keyup.enter="onSubmit"
          />
        </el-form-item>
        <el-form-item label="密码">
          <el-input
            v-model="form.password"
            type="password"
            show-password
            @keyup.enter="onSubmit"
          />
        </el-form-item>
        <el-button
          type="primary"
          style="width: 100%"
          :loading="submitting"
          @click="onSubmit"
        >
          登录
        </el-button>
      </el-form>
    </el-card>
  </div>
</template>
