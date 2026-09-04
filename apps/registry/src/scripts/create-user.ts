import { and, eq, isNull, sql } from "drizzle-orm";
import { db, users, userTokens } from "@skillhive/db";
import { hashPassword } from "../auth.js";

/**
 * 创建/更新登录账号（解决"要登录才能建账号"的引导问题，直接在服务器上执行）。
 *
 * 用法：
 *   pnpm --filter @skillhive/registry create-user -- \
 *     --email it@example.com --name 张三 --password '强密码' --role admin
 *
 * 邮箱已存在时更新其密码与角色（可用于重置密码）；--disable / --enable 管理停用状态。
 */

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key || key === "--" || !key.startsWith("--")) continue;
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key.slice(2)] = "true";
    } else {
      args[key.slice(2)] = next;
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const { email, name, role = "publisher" } = args;
const password = args.password || process.env.SKILLHIVE_ADMIN_PASSWORD || "";
const disable = args.disable === "true";
const enable = args.enable === "true";

if (disable && enable) {
  console.error("--disable 与 --enable 不能同时使用");
  process.exit(1);
}
if (!email || (!disable && !enable && (!name || !password))) {
  console.error(
    "用法：SKILLHIVE_ADMIN_PASSWORD=<密码> create-user --email <邮箱> --name <姓名> [--role admin|publisher|member]\n" +
    "停用/启用：create-user --email <邮箱> --disable|--enable\n" +
    "也兼容本地手工使用 --password，但生产环境建议通过环境变量提供，避免暴露在进程列表中。",
  );
  process.exit(1);
}
if (!disable && !enable && !["admin", "publisher", "member"].includes(role)) {
  console.error(`非法角色：${role}（可选 admin / publisher / member）`);
  process.exit(1);
}
if (!disable && !enable && password.length < 12) {
  console.error("密码长度至少 12 位");
  process.exit(1);
}

const normalizedEmail = email.toLowerCase();
const existing = await db.query.users.findFirst({ where: eq(users.email, normalizedEmail) });

if (disable || enable) {
  if (!existing) {
    console.error(`账号不存在：${normalizedEmail}`);
    process.exit(1);
  }
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        disabledAt: disable ? new Date() : null,
        sessionVersion: sql`${users.sessionVersion} + 1`,
      })
      .where(eq(users.id, existing.id));
    if (disable) {
      // 历史用户 PAT 已不用于 MCP；离线脚本仍保证遗留凭据在数据层失效。
      await tx
        .update(userTokens)
        .set({ revokedAt: new Date() })
        .where(and(eq(userTokens.userId, existing.id), isNull(userTokens.revokedAt)));
    }
  });
  console.log(`✓ 已${disable ? "停用" : "启用"}账号：${normalizedEmail}，旧会话已失效`);
  process.exit(0);
}

const passwordHash = await hashPassword(password);

if (existing) {
  await db
    .update(users)
    .set({
      passwordHash,
      name,
      role: role as "admin" | "publisher" | "member",
      disabledAt: null,
      sessionVersion: sql`${users.sessionVersion} + 1`,
    })
    .where(eq(users.email, normalizedEmail));
  console.log(`✓ 已更新账号：${normalizedEmail}（${role}），旧登录会话已失效`);
} else {
  await db.insert(users).values({
    email: normalizedEmail,
    name,
    passwordHash,
    role: role as "admin" | "publisher" | "member",
  });
  console.log(`✓ 已创建账号：${normalizedEmail}（${role}）`);
}
process.exit(0);
