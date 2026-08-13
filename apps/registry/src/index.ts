import { serve } from "@hono/node-server";
import { app } from "./app.js";

const port = Number(process.env.REGISTRY_PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`无效的 REGISTRY_PORT：${process.env.REGISTRY_PORT ?? ""}`);
}

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`SkillHive Registry 已启动: http://localhost:${info.port}`);
});
