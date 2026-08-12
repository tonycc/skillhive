import { z } from "zod";
import { parse as parseYaml } from "yaml";
import JSZip from "jszip";

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
  /** 图标 URL（http/https），供客户端展示 */
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

// ---------- 多文件技能包（scripts/ references/ assets/） ----------

/** 技能包允许的资源目录（对齐 WorkBuddy/Claude 技能规范） */
export const RESOURCE_DIRS = ["scripts", "references", "assets"] as const;

/** 单个资源文件大小上限（解码前原始字节） */
export const RESOURCE_FILE_MAX_BYTES = 512 * 1024;

/** 单个技能包资源文件数量上限 */
export const RESOURCE_FILE_MAX_COUNT = 20;

/** 技能包资源文件（传输与存储统一使用 base64，兼容文本与二进制） */
export interface SkillResourceFile {
  /** 相对技能包根目录的路径，如 references/policy.md */
  path: string;
  /** base64 编码的文件内容 */
  contentBase64: string;
}

/** 校验单个资源文件路径，合法返回 null，否则返回中文错误说明 */
export function validateResourcePath(path: string): string | null {
  if (!path || path.length > 512) return "资源文件路径为空或超过 512 字符";
  if (path.includes("\\")) return `路径必须使用 / 分隔符：${path}`;
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return `不允许绝对路径：${path}`;
  const segments = path.split("/");
  if (segments.some((s) => s === ".." || s === "." || s === "")) {
    return `路径含非法片段（.. / . / 空段）：${path}`;
  }
  const topDir = segments[0] ?? "";
  if (segments.length < 2 || !(RESOURCE_DIRS as readonly string[]).includes(topDir)) {
    return `资源文件必须位于 ${RESOURCE_DIRS.join("/")} 目录下：${path}`;
  }
  return null;
}

/** 校验整包资源文件（路径合法 + 去重 + 数量/大小/编码限制），不合法抛出中文错误 */
export function validateResourceFiles(files: SkillResourceFile[]): void {
  if (files.length > RESOURCE_FILE_MAX_COUNT) {
    throw new Error(`资源文件数量超过上限（${RESOURCE_FILE_MAX_COUNT} 个）：当前 ${files.length} 个`);
  }
  const seen = new Set<string>();
  for (const f of files) {
    const pathErr = validateResourcePath(f.path);
    if (pathErr) throw new Error(pathErr);
    if (seen.has(f.path)) throw new Error(`资源文件路径重复：${f.path}`);
    seen.add(f.path);
    if (!/^[A-Za-z0-9+/=\r\n]*$/.test(f.contentBase64)) {
      throw new Error(`资源文件不是合法 base64：${f.path}`);
    }
    // base64 长度 ≈ 原始字节 × 4/3
    const approxBytes = Math.ceil((f.contentBase64.length * 3) / 4);
    if (approxBytes > RESOURCE_FILE_MAX_BYTES) {
      throw new Error(
        `资源文件超过大小上限（${RESOURCE_FILE_MAX_BYTES / 1024}KB）：${f.path}`,
      );
    }
  }
}

/** zip 技能包解析结果 */
export interface ParsedSkillPackage {
  /** SKILL.md 全文 */
  content: string;
  /** 技能元信息（frontmatter 解析结果） */
  frontmatter: SkillFrontmatter;
  /** 资源文件（scripts/ references/ assets/，base64） */
  files: SkillResourceFile[];
  /** 被忽略的非资源文件（如 README、图片散件），供界面提示 */
  skipped: string[];
}

/**
 * 解析 zip 格式的技能包（浏览器 / Node 通用）：
 * - 自动剥离压缩时可能多出的一层顶层文件夹
 * - 自动忽略 macOS 压缩产生的 __MACOSX/ 与 .DS_Store
 * - 只收集 scripts/ references/ assets/ 下的资源文件，其余列入 skipped
 * @throws {Error} 找不到 SKILL.md 或校验失败时抛出带中文说明的错误
 */
export async function parseSkillPackageZip(data: ArrayBuffer | Uint8Array): Promise<ParsedSkillPackage> {
  const zip = await JSZip.loadAsync(data);
  const entries = Object.values(zip.files).filter(
    (e) =>
      !e.dir &&
      !e.name.startsWith("__MACOSX/") &&
      !e.name.split("/").every((s) => s === "") &&
      !e.name.endsWith(".DS_Store"),
  );
  if (entries.length === 0) throw new Error("压缩包为空");

  // 剥离公共顶层目录（直接压缩文件夹时路径会多一层，如 my-skill/SKILL.md）
  let prefix = "";
  if (!entries.some((e) => e.name === "SKILL.md")) {
    const top = entries[0]?.name.split("/")[0];
    if (top && entries.every((e) => e.name.startsWith(`${top}/`))) {
      prefix = `${top}/`;
    }
  }

  const skillEntry = entries.find((e) => e.name === `${prefix}SKILL.md`);
  if (!skillEntry) {
    throw new Error("压缩包中未找到 SKILL.md（应位于技能包根目录）");
  }
  const content = await skillEntry.async("string");
  const parsed = parseSkillMd(content); // 格式不合法会在这里抛错

  const files: SkillResourceFile[] = [];
  const skipped: string[] = [];
  for (const e of entries) {
    const rel = e.name.slice(prefix.length);
    if (rel === "SKILL.md") continue;
    const topDir = rel.split("/")[0] ?? "";
    if ((RESOURCE_DIRS as readonly string[]).includes(topDir)) {
      files.push({ path: rel, contentBase64: await e.async("base64") });
    } else {
      skipped.push(rel);
    }
  }
  validateResourceFiles(files);

  return { content, frontmatter: parsed.frontmatter, files, skipped };
}
