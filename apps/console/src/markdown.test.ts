// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { INLINE_IMAGE_MAX_BYTES, renderSafeMarkdown } from "./markdown.js";

const PNG_SIGNATURE = "iVBORw0KGgo=";
const JPEG_SIGNATURE = "/9j/";
const WEBP_SIGNATURE = "UklGRgAAAABXRUJQ";

function parse(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
}

describe("renderSafeMarkdown", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("removes active HTML, event handlers and javascript URLs", async () => {
    const result = await renderSafeMarkdown(`
<script>window.pwned = true</script>
<img src=x onerror="window.pwned = true">
<a href="javascript:alert(1)">bad</a>
<iframe src="https://evil.example"></iframe>
`);
    const fragment = parse(result);
    expect(fragment.querySelector("script, iframe, img")).toBeNull();
    expect(fragment.querySelector("[onerror]")).toBeNull();
    expect(fragment.querySelector("a")?.hasAttribute("href")).toBe(false);
  });

  it("hardens external links and preserves local anchors", async () => {
    const result = await renderSafeMarkdown(
      `[external](https://example.com) [section](#safe-heading)`,
    );
    const links = parse(result).querySelectorAll("a");
    expect(links[0]?.getAttribute("target")).toBe("_blank");
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(links[1]?.getAttribute("href")).toBe("#safe-heading");
  });

  it("removes srcset, picture/source and media elements", async () => {
    const result = await renderSafeMarkdown(`
<img src="data:image/png;base64,${PNG_SIGNATURE}" srcset="https://tracker.example/pixel 2x">
<picture><source srcset="https://tracker.example/pixel"><img src="data:image/png;base64,${PNG_SIGNATURE}"></picture>
<video src="https://tracker.example/video"><track src="https://tracker.example/track"></video>
<audio src="https://tracker.example/audio"></audio>
`);
    const fragment = parse(result);
    expect(fragment.querySelector("picture, source, video, audio, track, [srcset]")).toBeNull();
    expect(fragment.querySelectorAll("img")).toHaveLength(2);
  });

  it("does not allow same-origin, API, external, empty or GIF image URLs", async () => {
    const result = await renderSafeMarkdown(`
<img src="/assets/logo.png">
<img src="/api/auth/me">
<img src="https://tracker.example/pixel.png">
<img src="">
<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
`);
    expect(parse(result).querySelector("img")).toBeNull();
  });

  it("accepts only PNG, JPEG and WebP data URLs with matching signatures", async () => {
    const result = await renderSafeMarkdown(`
<img alt="png" src="data:image/png;base64,${PNG_SIGNATURE}">
<img alt="jpeg" src="data:image/jpeg;base64,${JPEG_SIGNATURE}">
<img alt="webp" src="data:image/webp;base64,${WEBP_SIGNATURE}">
<img alt="wrong" src="data:image/png;base64,${JPEG_SIGNATURE}">
`);
    const images = parse(result).querySelectorAll("img");
    expect([...images].map((image) => image.getAttribute("alt"))).toEqual([
      "png",
      "jpeg",
      "webp",
    ]);
  });

  it("removes SVG, non-image and malformed or oversized data URLs", async () => {
    const oversized = btoa(
      "\x89PNG\r\n\x1a\n" + "A".repeat(INLINE_IMAGE_MAX_BYTES),
    );
    const result = await renderSafeMarkdown(`
<svg><script>alert(1)</script></svg>
<img src="data:text/html;base64,PHNjcmlwdD4=">
<img src="data:image/png;base64,not-base64!!">
<img src="data:image/png;base64,${PNG_SIGNATURE}#trailing">
<img src="data:image/png;base64,${oversized}">
`);
    const fragment = parse(result);
    expect(fragment.querySelector("svg, script, img")).toBeNull();
  });
});
