#!/usr/bin/env tsx
import { mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
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

const REGISTRY_URL = process.env.SKILLHIVE_REGISTRY_URL ?? "http://localhost:3001";

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
    const email = opts.email ?? (await promptText("账号："));
    const password = opts.password ?? (await promptText("密码：", true));
    if (!email || !password) {
      console.error("邮箱和密码不能为空");
      process.exit(1);
    }

    const res = await fetch(`${REGISTRY_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

// TODO: install 命令 —— 将 skill 同步到本地 .claude/skills 等目录（二期）

interface SkillListItem {
  slug: string;
}

interface SkillDetailResp {
  data: {
    slug: string;
    iconUrl?: string | null;
    latestVersion?: {
      version: string;
      content: string;
      publishedAt?: string;
      files?: SkillResourceFile[];
    } | null;
  };
}

/** 同步清单：记录本工具写入过的 skill，下架清理时绝不动用户自行安装的技能 */
const MANIFEST_FILE = ".skillhive-manifest.json";

/** 落地到技能目录的元数据/图标文件名（对齐 WorkBuddy 技能包格式） */
const META_FILE = "_meta.json";
const ICON_FILE = "_icon.png";

/** 写入技能目录的 _meta.json 结构（publishedAt 为毫秒时间戳，与 WorkBuddy 技能包约定一致） */
interface SkillMeta {
  slug: string;
  version: string;
  publishedAt?: number | undefined;
  source: "skillhive";
  iconUrl?: string | undefined;
  /** 本工具同步的资源文件路径清单，用于下架/精简时清理本地多余文件 */
  files?: string[] | undefined;
}

/**
 * 同步单个 skill 的元数据、图标与资源文件（SKILL.md 无变化时也会执行，保证完整）：
 * - _meta.json：内容变化才覆写（含资源文件清单）
 * - _icon.png：iconUrl 变化或本地缺失时重新下载；平台移除 icon 时删除本地图标
 * - 资源文件（scripts/ references/ assets/）：内容不一致才覆写，平台移除的本地同步删除
 * 图标下载失败仅告警，不中断整体同步。
 */
async function syncSkillMeta(
  dir: string,
  meta: SkillMeta,
  resources: SkillResourceFile[],
): Promise<void> {
  await mkdir(dir, { recursive: true });

  const metaPath = join(dir, META_FILE);
  const prevRaw = await readFile(metaPath, "utf-8").catch(() => null);
  let prev: Partial<SkillMeta> = {};
  if (prevRaw) {
    try {
      prev = JSON.parse(prevRaw) as Partial<SkillMeta>;
    } catch {
      // 损坏的 _meta.json 后面会被覆写
    }
  }

  const iconPath = join(dir, ICON_FILE);
  if (meta.iconUrl) {
    const iconExists = (await readFile(iconPath).catch(() => null)) !== null;
    if (!iconExists || prev.iconUrl !== meta.iconUrl) {
      try {
        const res = await fetch(meta.iconUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await writeFile(iconPath, Buffer.from(await res.arrayBuffer()));
        console.log(`  ⭑ 图标已下载 ${meta.slug}`);
      } catch (err) {
        console.warn(
          `  ⚠ 图标下载失败（${meta.slug}）：`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  } else {
    await rm(iconPath, { force: true });
  }

  // 资源文件：增量覆写 + 清理已移除
  const nextPaths = new Set(resources.map((r) => r.path));
  for (const r of resources) {
    const fp = join(dir, r.path);
    const local = await readFile(fp).catch(() => null);
    if (local === null || local.toString("base64") !== r.contentBase64) {
      await mkdir(dirname(fp), { recursive: true });
      await writeFile(fp, Buffer.from(r.contentBase64, "base64"));
      console.log(`  ⭑ 资源文件 ${meta.slug}/${r.path}`);
    }
  }
  for (const p of prev.files ?? []) {
    if (!nextPaths.has(p)) {
      await rm(join(dir, p), { force: true });
      console.log(`  - 移除资源文件 ${meta.slug}/${p}`);
    }
  }
  // 清理空资源目录（目录非空时 rmdir 报错，忽略即可）
  for (const sub of RESOURCE_DIRS) {
    await rmdir(join(dir, sub)).catch(() => {});
  }

  meta.files = resources.map((r) => r.path);
  const next = JSON.stringify(meta, null, 2) + "\n";
  if (prevRaw !== next) {
    await writeFile(metaPath, next, "utf-8");
  }
}

async function readManifest(dir: string): Promise<string[]> {
  try {
    const raw = await readFile(join(dir, MANIFEST_FILE), "utf-8");
    return (JSON.parse(raw) as { skills: string[] }).skills;
  } catch {
    return [];
  }
}

program
  .command("sync")
  .description("将平台已发布的 skill 同步到本地技能目录（供 WorkBuddy 等客户端的 / 菜单使用）")
  .option(
    "--dir <path>",
    "本地技能目录",
    join(homedir(), ".workbuddy", "skills"),
  )
  .action(async (opts: { dir: string }) => {
    // 1. 拉取已发布 skill 列表
    const listRes = await fetch(`${REGISTRY_URL}/api/skills`).catch(() => null);
    if (!listRes) {
      console.error(`无法连接 Registry（${REGISTRY_URL}），请确认服务已启动`);
      process.exit(1);
    }
    if (!listRes.ok) {
      console.error(`无法连接 Registry（${listRes.status}），请确认服务已启动`);
      process.exit(1);
    }
    const { data: list } = (await listRes.json()) as { data: SkillListItem[] };
    await mkdir(opts.dir, { recursive: true });

    // 2. 增量同步：对比内容，避免无变化覆写
    const stats = { added: 0, updated: 0, unchanged: 0, removed: 0 };
    const platformSlugs: string[] = [];

    for (const item of list) {
      const detailRes = await fetch(`${REGISTRY_URL}/api/skills/${item.slug}`);
      if (detailRes.status === 404) continue; // 确认已下架，交给后续清理
      if (!detailRes.ok) {
        // 查询失败（临时故障）：保留本地副本，绝不能误判为下架
        platformSlugs.push(item.slug);
        console.warn(`  ⚠ ${item.slug} 详情查询失败（HTTP ${detailRes.status}），本次跳过并保留本地副本`);
        continue;
      }
      const { data: detail } = (await detailRes.json()) as SkillDetailResp;
      const version = detail.latestVersion;
      if (!version?.content) {
        platformSlugs.push(item.slug); // 同理：无版本信息时保留本地副本
        continue;
      }
      platformSlugs.push(item.slug);

      const skillDir = join(opts.dir, item.slug);
      const filePath = join(skillDir, "SKILL.md");
      const existing = await readFile(filePath, "utf-8").catch(() => null);

      if (existing === null) {
        stats.added++;
        console.log(`+ 新增 ${item.slug}（v${version.version}）`);
        await mkdir(skillDir, { recursive: true });
        await writeFile(filePath, version.content, "utf-8");
      } else if (existing !== version.content) {
        stats.updated++;
        console.log(`↑ 更新 ${item.slug}（v${version.version}）`);
        await writeFile(filePath, version.content, "utf-8");
      } else {
        stats.unchanged++;
      }

      // 同步元数据、图标与资源文件（对齐 WorkBuddy 技能包格式，SKILL.md 无变化也会补齐）
      await syncSkillMeta(
        skillDir,
        {
          slug: item.slug,
          version: version.version,
          source: "skillhive",
          publishedAt: version.publishedAt
            ? new Date(version.publishedAt).getTime()
            : undefined,
          iconUrl: detail.iconUrl ?? undefined,
        },
        version.files ?? [],
      );
    }

    // 3. 下架清理：仅移除「上次由本工具同步、且平台已下架」的 skill
    const previous = await readManifest(opts.dir);
    for (const slug of previous) {
      if (!platformSlugs.includes(slug)) {
        await rm(join(opts.dir, slug), { recursive: true, force: true });
        stats.removed++;
        console.log(`- 下架 ${slug}`);
      }
    }

    // 4. 更新清单
    await writeFile(
      join(opts.dir, MANIFEST_FILE),
      JSON.stringify({ skills: platformSlugs, syncedAt: new Date().toISOString() }, null, 2),
      "utf-8",
    );

    console.log(
      `\n同步完成：新增 ${stats.added} / 更新 ${stats.updated} / 已是最新 ${stats.unchanged} / 下架 ${stats.removed}`,
    );
    if (stats.added + stats.updated + stats.removed > 0) {
      console.log("重启 WorkBuddy 后在 / 菜单中生效。");
    }
  });

program.parse();
