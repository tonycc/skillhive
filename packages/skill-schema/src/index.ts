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
  license: z.string().trim().min(1).max(128).optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(32).default([]),
  /** 声明允许调用的工具白名单（可选，遵循 Agent Skills 规范） */
  allowed_tools: z.array(z.string().trim().min(1).max(128)).max(64).optional(),
  // ---- SkillHive 扩展字段 ----
  /** 所属分类，如：研发 / 市场 / 财务 */
  category: z.string().trim().min(1).max(64).optional(),
  /** 可见部门名称列表，缺省表示全员可见 */
  departments: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(128),
    )
    .max(64)
    .optional(),
  /** 图标 URL（http/https），供客户端展示 */
  icon: z
    .string()
    .url()
    .max(1024)
    .refine((value) => /^https?:\/\//i.test(value), "icon 仅允许 http/https URL")
    .optional(),
});

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;

export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  /** Markdown 正文（frontmatter 之后的部分） */
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

/** SKILL.md 文件大小上限（UTF-8 字节）。 */
export const SKILL_MD_MAX_BYTES = 512 * 1024;

/** zip 输入与解压后总数据的防御性上限。 */
export const SKILL_PACKAGE_ZIP_MAX_BYTES = 16 * 1024 * 1024;
export const SKILL_PACKAGE_UNCOMPRESSED_MAX_BYTES = 16 * 1024 * 1024;
export const SKILL_PACKAGE_ENTRY_MAX_COUNT = 64;

/** 浏览器与 Node 通用的 UTF-8 字节数计算，避免依赖 Buffer。 */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/**
 * 解析并校验 SKILL.md 文件内容。
 * @throws {Error} 格式不合法或校验失败时抛出带中文说明的错误
 */
export function parseSkillMd(content: string): ParsedSkill {
  if (utf8ByteLength(content) > SKILL_MD_MAX_BYTES) {
    throw new Error(`SKILL.md 超过大小上限（${SKILL_MD_MAX_BYTES / 1024}KB）`);
  }
  const match = FRONTMATTER_RE.exec(content.trimStart());
  if (!match) {
    throw new Error("SKILL.md 格式错误：缺少 YAML frontmatter（--- 包裹的头部）");
  }

  const [, yamlText, body] = match;
  let raw: unknown;
  try {
    raw = parseYaml(yamlText, { maxAliasCount: 50 });
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

/** 单个技能包全部资源文件的总大小上限。 */
export const RESOURCE_PACKAGE_MAX_BYTES = 10 * 1024 * 1024;

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
  let totalBytes = 0;
  for (const f of files) {
    const pathErr = validateResourcePath(f.path);
    if (pathErr) throw new Error(pathErr);
    if (seen.has(f.path)) throw new Error(`资源文件路径重复：${f.path}`);
    seen.add(f.path);
    if (
      f.contentBase64.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        f.contentBase64,
      )
    ) {
      throw new Error(`资源文件不是合法 base64：${f.path}`);
    }
    const padding = f.contentBase64.endsWith("==")
      ? 2
      : f.contentBase64.endsWith("=")
        ? 1
        : 0;
    const decodedBytes = (f.contentBase64.length / 4) * 3 - padding;
    if (decodedBytes > RESOURCE_FILE_MAX_BYTES) {
      throw new Error(
        `资源文件超过大小上限（${RESOURCE_FILE_MAX_BYTES / 1024}KB）：${f.path}`,
      );
    }
    totalBytes += decodedBytes;
    if (totalBytes > RESOURCE_PACKAGE_MAX_BYTES) {
      throw new Error(
        `资源文件总大小超过上限（${RESOURCE_PACKAGE_MAX_BYTES / 1024 / 1024}MB）`,
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
  if (data.byteLength > SKILL_PACKAGE_ZIP_MAX_BYTES) {
    throw new Error(
      `压缩包超过大小上限（${SKILL_PACKAGE_ZIP_MAX_BYTES / 1024 / 1024}MB）`,
    );
  }
  const zip = await JSZip.loadAsync(data);
  const entries = Object.values(zip.files).filter(
    (e) =>
      !e.dir &&
      !e.name.startsWith("__MACOSX/") &&
      !e.name.split("/").every((s) => s === "") &&
      !e.name.endsWith(".DS_Store"),
  );
  if (entries.length === 0) throw new Error("压缩包为空");
  if (entries.length > SKILL_PACKAGE_ENTRY_MAX_COUNT) {
    throw new Error(`压缩包文件数量超过上限（${SKILL_PACKAGE_ENTRY_MAX_COUNT} 个）`);
  }

  // JSZip 没有在公开类型中暴露 central-directory 的解压大小，但 loadAsync 后
  // `_data.uncompressedSize` 已可用。先检查再解压，避免小压缩包触发巨量内存分配。
  type SizedZipEntry = (typeof entries)[number] & {
    _data?: { uncompressedSize?: number };
  };
  const entryDeclaredSizes = entries.map(
    (entry) => (entry as SizedZipEntry)._data?.uncompressedSize,
  );
  if (entryDeclaredSizes.some((size) => !Number.isSafeInteger(size) || (size ?? -1) < 0)) {
    throw new Error("压缩包缺少可信的解压大小信息");
  }
  const declaredUncompressedBytes = entries.reduce(
    (sum, entry) => sum + ((entry as SizedZipEntry)._data?.uncompressedSize ?? 0),
    0,
  );
  if (declaredUncompressedBytes > SKILL_PACKAGE_UNCOMPRESSED_MAX_BYTES) {
    throw new Error(
      `压缩包解压后超过大小上限（${SKILL_PACKAGE_UNCOMPRESSED_MAX_BYTES / 1024 / 1024}MB）`,
    );
  }

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
  const skillSize = (skillEntry as SizedZipEntry)._data?.uncompressedSize ?? 0;
  if (skillSize > SKILL_MD_MAX_BYTES) {
    throw new Error(`SKILL.md 超过大小上限（${SKILL_MD_MAX_BYTES / 1024}KB）`);
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
      const declaredSize = (e as SizedZipEntry)._data?.uncompressedSize ?? 0;
      if (declaredSize > RESOURCE_FILE_MAX_BYTES) {
        throw new Error(
          `资源文件超过大小上限（${RESOURCE_FILE_MAX_BYTES / 1024}KB）：${rel}`,
        );
      }
      files.push({ path: rel, contentBase64: await e.async("base64") });
    } else {
      skipped.push(rel);
    }
  }
  validateResourceFiles(files);

  return { content, frontmatter: parsed.frontmatter, files, skipped };
}
