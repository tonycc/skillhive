#!/usr/bin/env tsx
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { parseSkillMd } from "@skillhive/skill-schema";

const REGISTRY_URL = process.env.SKILLHIVE_REGISTRY_URL ?? "http://localhost:3001";

const program = new Command();

program
  .name("skillhive")
  .description("SkillHive 命令行工具 —— IT 发布与管理企业 AI skill")
  .version("0.1.0");

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

program
  .command("publish")
  .description("发布 skill 到 SkillHive Registry")
  .argument("<path>", "SKILL.md 文件路径")
  .option("--changelog <text>", "本次变更说明", "")
  .action(async (path: string, opts: { changelog: string }) => {
    const content = await readFile(path, "utf-8");

    // 本地先校验，避免无效请求
    try {
      parseSkillMd(content);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }

    // TODO: 携带发布者身份令牌（登录态 / API Key）
    const res = await fetch(`${REGISTRY_URL}/api/skills/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, changelog: opts.changelog }),
    });
    const json = await res.json();

    if (!res.ok) {
      console.error(`发布失败：${(json as { error?: string }).error ?? res.statusText}`);
      process.exit(1);
    }
    console.log("✓ 发布成功：", JSON.stringify((json as { data: unknown }).data));
  });

// TODO: install 命令 —— 将 skill 同步到本地 .claude/skills 等目录（二期）

interface SkillListItem {
  slug: string;
}

interface SkillDetailResp {
  data: {
    slug: string;
    latestVersion?: { version: string; content: string } | null;
  };
}

/** 同步清单：记录本工具写入过的 skill，下架清理时绝不动用户自行安装的技能 */
const MANIFEST_FILE = ".skillhive-manifest.json";

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
    const listRes = await fetch(`${REGISTRY_URL}/api/skills`);
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
      if (!detailRes.ok) continue;
      const { data: detail } = (await detailRes.json()) as SkillDetailResp;
      const version = detail.latestVersion;
      if (!version?.content) continue;
      platformSlugs.push(item.slug);

      const filePath = join(opts.dir, item.slug, "SKILL.md");
      const existing = await readFile(filePath, "utf-8").catch(() => null);

      if (existing === null) {
        stats.added++;
        console.log(`+ 新增 ${item.slug}（v${version.version}）`);
      } else if (existing !== version.content) {
        stats.updated++;
        console.log(`↑ 更新 ${item.slug}（v${version.version}）`);
      } else {
        stats.unchanged++;
        continue;
      }

      await mkdir(join(opts.dir, item.slug), { recursive: true });
      await writeFile(filePath, version.content, "utf-8");
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
