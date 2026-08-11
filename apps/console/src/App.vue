<template>
  <div class="container">
    <header class="site-header">
      <h1>🐝 SkillHive 技能蜂巢</h1>
      <nav class="site-nav">
        <router-link to="/" :class="{ active: $route.name === 'home' }">
          技能市场
        </router-link>
        <router-link to="/stats" :class="{ active: $route.name === 'stats' }">
          数据看板
        </router-link>
      </nav>
    </header>
    <router-view />
  </div>
</template>
