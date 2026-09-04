<template>
  <section class="state-panel" aria-label="无访问权限">
    <el-empty description="当前账号没有执行此操作的权限，请联系 IT 管理员开通。">
      <el-button type="primary" @click="$router.push('/')">返回 Skill 管理</el-button>
    </el-empty>
  </section>
</template>
