import type { MiddlewareHandler } from "hono";

/**
 * 发布/管理接口鉴权（极简形态：共享 Bearer 令牌，仅 IT 持有）。
 *
 * - 配置环境变量 SKILLHIVE_PUBLISH_TOKEN 后，所有受保护接口必须携带
 *   `Authorization: Bearer <token>`，否则返回 401
 * - 未配置（本地开发）时放行并输出告警；正式部署必须配置
 *
 * 后续接入专门登录模块时，本中间件替换为统一身份校验即可，
 * 受保护路由的挂载方式不变。
 */
const PUBLISH_TOKEN = process.env.SKILLHIVE_PUBLISH_TOKEN;

if (!PUBLISH_TOKEN) {
  console.warn(
    "[skillhive] ⚠️ 未配置 SKILLHIVE_PUBLISH_TOKEN，发布接口处于无鉴权开发模式（正式部署必须配置）",
  );
}

/** 校验发布令牌，挂载到发布/管理类路由 */
export const requirePublishToken: MiddlewareHandler = async (c, next) => {
  if (!PUBLISH_TOKEN) return next(); // 开发模式

  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (token !== PUBLISH_TOKEN) {
    return c.json(
      { error: "未授权：缺少或错误的发布令牌（需 Authorization: Bearer <token>）" },
      401,
    );
  }
  return next();
};
