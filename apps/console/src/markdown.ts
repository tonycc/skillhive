import DOMPurify from "dompurify";
import { marked } from "marked";

/** Markdown 内联图片的解码后大小上限；更大的图片应作为技能资源按需读取。 */
export const INLINE_IMAGE_MAX_BYTES = 512 * 1024;

const RASTER_DATA_URL_RE =
  /^data:image\/(png|jpeg|webp);base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/i;

function startsWithBytes(binary: string, expected: readonly number[]): boolean {
  return expected.every((byte, index) => binary.charCodeAt(index) === byte);
}

/** 只接收完整、限长且文件签名与 MIME 一致的 raster data URL。 */
function isSafeInlineRaster(src: string): boolean {
  const match = RASTER_DATA_URL_RE.exec(src);
  const mime = match?.[1]?.toLowerCase();
  const payload = match?.[2];
  if (!mime || !payload) return false;

  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  const decodedBytes = (payload.length / 4) * 3 - padding;
  if (decodedBytes <= 0 || decodedBytes > INLINE_IMAGE_MAX_BYTES) return false;

  let binary: string;
  try {
    binary = atob(payload);
  } catch {
    return false;
  }
  if (binary.length !== decodedBytes) return false;

  if (mime === "png") {
    return startsWithBytes(binary, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
  if (mime === "jpeg") return startsWithBytes(binary, [0xff, 0xd8, 0xff]);
  return binary.length >= 12
    && binary.slice(0, 4) === "RIFF"
    && binary.slice(8, 12) === "WEBP";
}

/**
 * 将不可信技能 Markdown 转成可展示 HTML。Markdown 允许作者写原始 HTML，
 * 因此任何写入 v-html 的结果都必须经过这里的严格清洗和 URL 二次校验。
 */
export async function renderSafeMarkdown(markdown: string): Promise<string> {
  const rendered = await marked.parse(markdown, {
    gfm: true,
    breaks: false,
  });
  const clean = DOMPurify.sanitize(rendered, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
      "script",
      "style",
      "iframe",
      "object",
      "embed",
      "form",
      "input",
      "button",
      "textarea",
      "select",
      "option",
      "svg",
      "math",
      "picture",
      "source",
      "video",
      "audio",
      "track",
    ],
    FORBID_ATTR: ["style", "srcdoc", "formaction", "srcset"],
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });

  const container = document.createElement("template");
  container.innerHTML = clean;

  for (const link of container.content.querySelectorAll("a")) {
    const href = link.getAttribute("href");
    if (!href) continue;
    if (href.startsWith("#")) continue;
    try {
      const url = new URL(href, window.location.origin);
      if (!["http:", "https:", "mailto:"].includes(url.protocol)) {
        link.removeAttribute("href");
      } else if (url.protocol !== "mailto:" && url.origin !== window.location.origin) {
        link.setAttribute("target", "_blank");
        link.setAttribute("rel", "noopener noreferrer");
      }
    } catch {
      link.removeAttribute("href");
    }
  }

  for (const image of container.content.querySelectorAll("img")) {
    const src = image.getAttribute("src") ?? "";
    // 不允许同源/外部 URL，避免 Markdown 借浏览器 Cookie 对 API 发盲 GET 或向第三方泄漏访问行为。
    if (!isSafeInlineRaster(src)) image.remove();
  }

  return container.innerHTML;
}
