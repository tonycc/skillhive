import { z } from "zod";
import { parse as parseYaml } from "yaml";

/**
 * SKILL.md frontmatter 校验规则。
 * 兼容社区 Agent Skills 规范（agentskills.io），并预留 SkillHive 扩展字段。
 */
export const skillFrontmatterSchema = z.object({
  /** skill 名称，全局唯一标识（kebab-case） */
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "name 必须是 kebab-case"),
  /** 一句话描述，让模型/用户知道何时使用该 skill */
  description: z.string().min(1).max(512),
  /** 语义化版本号 */
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/, "version 必须符合语义化版本格式")
    .optional(),
  license: z.string().optional(),
  tags: z.array(z.string()).default([]),
  /** 声明允许调用的工具白名单（可选，遵循 Agent Skills 规范） */
  allowed_tools: z.array(z.string()).optional(),
  // ---- SkillHive 扩展字段 ----
  /** 所属分类，如：研发 / 市场 / 财务 */
  category: z.string().optional(),
  /** 可见部门 slug 列表，缺省表示全员可见 */
  departments: z.array(z.string()).optional(),
  /** 图标 URL（http/https），sync 时下载到本地技能目录供客户端 UI 展示 */
  icon: z.string().url().max(1024).optional(),
});

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;

export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  /** Markdown 正文（frontmatter 之后的部分） */
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

/**
 * 解析并校验 SKILL.md 文件内容。
 * @throws {Error} 格式不合法或校验失败时抛出带中文说明的错误
 */
export function parseSkillMd(content: string): ParsedSkill {
  const match = FRONTMATTER_RE.exec(content.trimStart());
  if (!match) {
    throw new Error("SKILL.md 格式错误：缺少 YAML frontmatter（--- 包裹的头部）");
  }

  const [, yamlText, body] = match;
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch {
    throw new Error("SKILL.md 格式错误：frontmatter 不是合法的 YAML");
  }

  const result = skillFrontmatterSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`SKILL.md frontmatter 校验失败：\n${issues}`);
  }

  return { frontmatter: result.data, body: body.trim() };
}
