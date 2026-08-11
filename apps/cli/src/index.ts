#!/usr/bin/env tsx
import { readFile } from "node:fs/promises";
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

program.parse();
