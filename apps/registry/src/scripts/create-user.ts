import { eq } from "drizzle-orm";
import { db, users } from "@skillhive/db";
import { hashPassword } from "../auth.js";

/**
 * 创建/更新登录账号（解决"要登录才能建账号"的引导问题，直接在服务器上执行）。
 *
 * 用法：
 *   pnpm --filter @skillhive/registry create-user -- \
 *     --email it@example.com --name 张三 --password '强密码' --role admin
 *
 * 邮箱已存在时更新其密码与角色（可用于重置密码）。
 */

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key || key === "--" || !key.startsWith("--")) continue;
    args[key.slice(2)] = argv[i + 1] ?? "";
    i++;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const { email, name, password, role = "publisher" } = args;

if (!email || !name || !password) {
  console.error("用法：create-user --email <邮箱> --name <姓名> --password <密码> [--role admin|publisher|member]");
  process.exit(1);
}
if (!["admin", "publisher", "member"].includes(role)) {
  console.error(`非法角色：${role}（可选 admin / publisher / member）`);
  process.exit(1);
}
if (password.length < 8) {
  console.error("密码长度至少 8 位");
  process.exit(1);
}

const passwordHash = await hashPassword(password);
const existing = await db.query.users.findFirst({ where: eq(users.email, email) });

if (existing) {
  await db
    .update(users)
    .set({ passwordHash, name, role: role as "admin" | "publisher" | "member" })
    .where(eq(users.email, email));
  console.log(`✓ 已更新账号：${email}（${role}）`);
} else {
  await db.insert(users).values({
    email,
    name,
    passwordHash,
    role: role as "admin" | "publisher" | "member",
  });
  console.log(`✓ 已创建账号：${email}（${role}）`);
}
process.exit(0);
