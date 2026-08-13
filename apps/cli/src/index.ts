#!/usr/bin/env tsx
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import readline from "node:readline";
import { Command } from "commander";
import {
  parseSkillMd,
  parseSkillPackageZip,
  validateResourceFiles,
  RESOURCE_DIRS,
  type SkillResourceFile,
} from "@skillhive/skill-schema";

const REGISTRY_URL = (process.env.SKILLHIVE_REGISTRY_URL ?? "http://localhost:3001").replace(
  /\/$/,
  "",
);

function assertSafeRegistryUrl(): void {
  const url = new URL(REGISTRY_URL);
  const isLoopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !isLoopback && process.env.SKILLHIVE_ALLOW_INSECURE_HTTP !== "1") {
    throw new Error(
      "拒绝通过明文 HTTP 向远程 Registry 发送凭证；请使用 HTTPS，或仅在受控网络显式设置 SKILLHIVE_ALLOW_INSECURE_HTTP=1",
    );
  }
}

const program = new Command();

program
  .name("skillhive")
  .description("SkillHive 命令行工具 —— IT 发布与管理企业 AI skill")
  .version("0.1.0");

// ---------- 登录凭证（~/.skillhive/credentials.json） ----------

const CREDENTIALS_FILE = join(homedir(), ".skillhive", "credentials.json");

interface Credentials {
  token: string;
  user: { id: string; email: string; name: string; role: string };
  savedAt: string;
}

async function readCredentials(): Promise<Credentials | null> {
  try {
    return JSON.parse(await readFile(CREDENTIALS_FILE, "utf-8")) as Credentials;
  } catch {
    return null;
  }
}

/** 交互式输入；hidden 时关闭回显（用于密码） */
function promptText(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      // 静默输出，避免密码回显
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => {};
    }
    rl.question("", (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

program
  .command("login")
  .description("登录 SkillHive 账号（发布前执行一次，凭证保存到 ~/.skillhive/）")
  .option("--email <email>", "账号邮箱")
  .option("--password <password>", "密码（不推荐，会留在 shell 历史中）")
  .action(async (opts: { email?: string; password?: string }) => {
    assertSafeRegistryUrl();
    const email = opts.email ?? (await promptText("账号："));
    const password = opts.password ?? (await promptText("密码：", true));
    if (!email || !password) {
      console.error("邮箱和密码不能为空");
      process.exit(1);
    }

    const res = await fetch(`${REGISTRY_URL}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-SkillHive-Session-Mode": "bearer",
      },
      body: JSON.stringify({ email, password }),
    });
    const json = (await res.json()) as {
      data?: { token: string; user: Credentials["user"] };
      error?: string;
    };
    if (!res.ok || !json.data) {
      console.error(`登录失败：${json.error ?? res.statusText}`);
      process.exit(1);
    }

    await mkdir(dirname(CREDENTIALS_FILE), { recursive: true });
    await writeFile(
      CREDENTIALS_FILE,
      JSON.stringify(
        { token: json.data.token, user: json.data.user, savedAt: new Date().toISOString() },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    const u = json.data.user;
    console.log(`✓ 已登录：${u.name}（${u.email}，${u.role}），凭证有效期 7 天`);
  });

program
  .command("logout")
  .description("退出登录（删除本地凭证）")
  .action(async () => {
    await rm(CREDENTIALS_FILE, { force: true });
    console.log("✓ 已退出登录");
  });

program
  .command("whoami")
  .description("查看当前登录状态")
  .action(async () => {
    assertSafeRegistryUrl();
    const cred = await readCredentials();
    if (!cred) {
      console.log("未登录（执行 skillhive login 登录）");
      return;
    }
    const res = await fetch(`${REGISTRY_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${cred.token}` },
    });
    if (!res.ok) {
      console.log("登录已过期，请重新执行 skillhive login");
      return;
    }
    const u = cred.user;
    console.log(`已登录：${u.name}（${u.email}，${u.role}）`);
  });

program
  .command("validate")
  .description("校验本地 SKILL.md 格式是否合法")
  .argument("<path>", "SKILL.md 文件路径")
  .action(async (path: string) => {
    const content = await readFile(path, "utf-8");
    try {
      const parsed = parseSkillMd(content);
      console.log(`✓ 校验通过：${parsed.frontmatter.name}（${parsed.frontmatter.description}）`);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

/** 收集技能包目录下的资源文件（scripts/ references/ assets/），内容 base64 编码 */
async function collectResourceFiles(dir: string): Promise<SkillResourceFile[]> {
  const files: SkillResourceFile[] = [];
  for (const sub of RESOURCE_DIRS) {
    const entries = await readdir(join(dir, sub), {
      recursive: true,
      withFileTypes: true,
    }).catch(() => []);
    for (const e of entries) {
      if (!e.isFile()) continue;
      const full = join(e.parentPath, e.name);
      const rel = relative(dir, full).split(sep).join("/");
      const buf = await readFile(full);
      files.push({ path: rel, contentBase64: buf.toString("base64") });
    }
  }
  return files;
}

program
  .command("publish")
  .description("发布 skill 到 SkillHive Registry（支持单个 SKILL.md、技能包目录或 zip）")
  .argument("<path>", "SKILL.md 文件、技能包目录，或 zip 压缩技能包")
  .option("--changelog <text>", "本次变更说明", "")
  .action(async (path: string, opts: { changelog: string }) => {
    assertSafeRegistryUrl();
    const target = await stat(path).catch(() => null);
    if (!target) {
      console.error(`路径不存在：${path}`);
      process.exit(1);
    }

    // 目录 = 完整技能包；.zip = 压缩技能包；其他 = 单个 SKILL.md
    let content: string;
    let files: SkillResourceFile[] = [];
    if (target.isDirectory()) {
      content = await readFile(join(path, "SKILL.md"), "utf-8").catch(() => {
        console.error(`技能包目录缺少 SKILL.md：${path}`);
        process.exit(1);
      });
      files = await collectResourceFiles(path);
    } else if (path.toLowerCase().endsWith(".zip")) {
      try {
        const pkg = await parseSkillPackageZip(await readFile(path));
        content = pkg.content;
        files = pkg.files;
        if (pkg.skipped.length > 0) {
          console.warn(`⚠ 已忽略非资源文件：${pkg.skipped.join("、")}`);
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    } else {
      content = await readFile(path, "utf-8");
    }

    // 本地先校验，避免无效请求
    try {
      parseSkillMd(content);
      validateResourceFiles(files);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }

    // 登录凭证（skillhive login 获得）
    const cred = await readCredentials();
    if (!cred) {
      console.error("未登录：请先执行 skillhive login");
      process.exit(1);
    }

    const res = await fetch(`${REGISTRY_URL}/api/skills/publish`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cred.token}`,
      },
      body: JSON.stringify({ content, changelog: opts.changelog, files }),
    });
    const json = await res.json();

    if (res.status === 401) {
      console.error("登录已过期，请重新执行 skillhive login");
      process.exit(1);
    }
    if (!res.ok) {
      console.error(`发布失败：${(json as { error?: string }).error ?? res.statusText}`);
      process.exit(1);
    }
    console.log("✓ 发布成功：", JSON.stringify((json as { data: unknown }).data));
    if (files.length > 0) console.log(`  含 ${files.length} 个资源文件`);
  });

program.parse();
