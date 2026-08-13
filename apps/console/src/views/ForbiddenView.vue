<template>
  <section class="state-panel" aria-labelledby="forbidden-title">
    <h1 id="forbidden-title" class="page-title">无访问权限</h1>
    <el-empty description="当前账号没有执行此操作的权限，请联系 IT 管理员开通。">
      <el-button type="primary" @click="$router.push('/')">返回技能市场</el-button>
    </el-empty>
  </section>
</template>
