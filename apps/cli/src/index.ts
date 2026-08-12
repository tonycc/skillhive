#!/usr/bin/env tsx
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
    if (list.length === 0) {
      console.log("平台暂无已发布的 skill");
      return;
    }

    // 2. 逐个拉取详情并写入本地目录：<dir>/<slug>/SKILL.md
    let synced = 0;
    for (const item of list) {
      const detailRes = await fetch(`${REGISTRY_URL}/api/skills/${item.slug}`);
      if (!detailRes.ok) continue;
      const { data: detail } = (await detailRes.json()) as SkillDetailResp;
      const version = detail.latestVersion;
      if (!version?.content) continue;

      const dir = join(opts.dir, item.slug);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "SKILL.md"), version.content, "utf-8");
      console.log(`✓ ${item.slug}（v${version.version}）`);
      synced++;
    }

    console.log(`\n已同步 ${synced} 个 skill 到 ${opts.dir}`);
    console.log("重启 WorkBuddy 后即可在 / 菜单中看到。");
  });

program.parse();
