import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/vue@") || id.includes("/vue-router@") || id.includes("/pinia@")) {
            return "vue";
          }
          if (id.includes("/marked@") || id.includes("/dompurify@")) return "markdown";
          if (id.includes("/jszip@") || id.includes("/yaml@") || id.includes("/zod@")) {
            return "skill-package";
          }
        },
      },
    },
  },
  server: {
    port: 3000,
    proxy: {
      // 开发态将 /api 代理到 Registry，避免跨域
      "/api": {
        target: process.env.SKILLHIVE_REGISTRY_URL ?? "http://localhost:3001",
        // 保留浏览器看到的 Host，使 Cookie 写请求的 Origin 校验在开发代理下仍成立。
        changeOrigin: false,
      },
    },
  },
});
