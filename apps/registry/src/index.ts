import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import skills from "./routes/skills.js";
import stats from "./routes/stats.js";
import requests from "./routes/requests.js";

const app = new Hono();

app.use("*", logger());

app.get("/health", (c) =>
  c.json({ status: "ok", service: "skillhive-registry", version: "0.1.0" }),
);

app.route("/api/skills", skills);
app.route("/api/stats", stats);
app.route("/api/requests", requests);

// TODO: /api/auth（企业微信登录）

const port = Number(process.env.REGISTRY_PORT ?? 3001);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`SkillHive Registry 已启动: http://localhost:${info.port}`);
});
