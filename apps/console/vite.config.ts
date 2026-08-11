import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 3000,
    proxy: {
      // 开发态将 /api 代理到 Registry，避免跨域
      "/api": {
        target: process.env.SKILLHIVE_REGISTRY_URL ?? "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
