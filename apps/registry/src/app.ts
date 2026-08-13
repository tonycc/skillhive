import { Hono } from "hono";
import { logger } from "hono/logger";
import { bodyLimit } from "hono/body-limit";
import skills from "./routes/skills.js";
import stats from "./routes/stats.js";
import requests from "./routes/requests.js";
import auth from "./routes/auth.js";
import { requireSameOriginForCookieWrites } from "./security.js";

export function createApp(): Hono {
  const app = new Hono();
  app.use("*", logger());
  app.use("/api/*", requireSameOriginForCookieWrites);
  app.use(
    "/api/*",
    bodyLimit({
      maxSize: 16 * 1024 * 1024,
      onError: (c) => c.json({ error: "请求体过大（最大 16 MiB）" }, 413),
    }),
  );

  app.get("/health", (c) =>
    c.json({ status: "ok", service: "skillhive-registry", version: "0.1.0" }),
  );
  app.route("/api/skills", skills);
  app.route("/api/stats", stats);
  app.route("/api/requests", requests);
  app.route("/api/auth", auth);
  app.notFound((c) => c.json({ error: "接口不存在" }, 404));
  app.onError((error, c) => {
    console.error("Registry 未处理异常：", error);
    return c.json({ error: "服务器内部错误" }, 500);
  });
  return app;
}

export const app = createApp();
