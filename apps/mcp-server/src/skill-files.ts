import {
  RESOURCE_FILE_MAX_BYTES,
  validateResourcePath,
} from "@skillhive/skill-schema";
import type { SkillFile } from "./registry.js";

const TEXT_EXTENSIONS = new Set([
  "c",
  "conf",
  "cpp",
  "css",
  "csv",
  "go",
  "h",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsx",
  "md",
  "mjs",
  "py",
  "rb",
  "rs",
  "sh",
  "sql",
  "svg",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
]);

export interface DecodedSkillFile {
  path: string;
  size: number;
  encoding: "utf-8" | "base64";
  content: string;
}

/** 对单文件端点的响应做边界校验，防止路径串线或异常大小进入 MCP 输出。 */
export function validateSkillFileResponse(
  file: SkillFile,
  requestedPath: string,
  requestedVersion: string,
): SkillFile {
  if (validateResourcePath(requestedPath)) {
    throw new Error("资源文件请求路径无效");
  }
  if (validateResourcePath(file.path) || file.path !== requestedPath) {
    throw new Error("资源文件响应路径与请求不匹配");
  }
  if (file.version !== requestedVersion) {
    throw new Error("资源文件响应版本与请求不匹配");
  }
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > RESOURCE_FILE_MAX_BYTES) {
    throw new Error("资源文件响应大小无效");
  }
  return file;
}

function looksTextual(path: string): boolean {
  const extension = path.includes(".") ? path.slice(path.lastIndexOf(".") + 1).toLowerCase() : "";
  return TEXT_EXTENSIONS.has(extension);
}

/** 文本以 UTF-8 返回，二进制保留 base64，避免破坏脚本、图片等技能资源。 */
export function decodeSkillFile(file: SkillFile): DecodedSkillFile {
  if (
    file.contentBase64.length > Math.ceil((RESOURCE_FILE_MAX_BYTES * 4) / 3) + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      file.contentBase64,
    )
  ) {
    throw new Error("资源文件不是合法的 base64 编码");
  }
  const bytes = Buffer.from(file.contentBase64, "base64");
  if (bytes.byteLength > RESOURCE_FILE_MAX_BYTES) {
    throw new Error("资源文件超过 MCP 可返回的大小上限");
  }
  if (bytes.byteLength !== file.size) {
    throw new Error("资源文件正文与声明大小不一致");
  }

  if (looksTextual(file.path)) {
    try {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return { path: file.path, size: bytes.byteLength, encoding: "utf-8", content };
    } catch {
      // 声明为文本但内容不是合法 UTF-8 时，安全降级为 base64。
    }
  }

  return {
    path: file.path,
    size: bytes.byteLength,
    encoding: "base64",
    content: file.contentBase64,
  };
}
