import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  parseSkillMd,
  parseSkillPackageZip,
  serializeSkillMd,
  validateResourceFiles,
  validateResourcePath,
} from "./index.js";

const skillMd = `---
name: safe-skill
description: 用于验证安全边界
version: 1.0.0
departments:
  - 财务部
icon: https://example.com/icon.png
---
# Safe skill`;

describe("parseSkillMd", () => {
  it("parses a bounded valid document", () => {
    expect(parseSkillMd(skillMd).frontmatter.name).toBe("safe-skill");
  });

  it("rejects non-http icon schemes", () => {
    expect(() =>
      parseSkillMd(skillMd.replace("https://example.com/icon.png", "javascript:alert(1)")),
    ).toThrow("icon");
  });
});

describe("serializeSkillMd", () => {
  it("round-trips an editable Skill without platform routing metadata", () => {
    const content = serializeSkillMd({
      name: "requirement-exploration",
      description: "可编辑的需求探索规则",
      version: "1.0.1",
      category: "产品",
      tags: ["需求探索"],
      allowed_tools: ["save_exploration"],
    }, "# 规则正文\n\n先澄清问题。");
    expect(parseSkillMd(content)).toEqual({
      frontmatter: {
        name: "requirement-exploration",
        description: "可编辑的需求探索规则",
        version: "1.0.1",
        category: "产品",
        tags: ["需求探索"],
        allowed_tools: ["save_exploration"],
      },
      body: "# 规则正文\n\n先澄清问题。",
    });
  });
});

describe("resource validation", () => {
  it.each(["../secret", "scripts/../secret", "/assets/a", "assets//a"])(
    "rejects unsafe path %s",
    (path) => expect(validateResourcePath(path)).not.toBeNull(),
  );

  it("rejects malformed base64 padding", () => {
    expect(() =>
      validateResourceFiles([{ path: "assets/a.txt", contentBase64: "abc=" + "=" }]),
    ).toThrow("base64");
  });

  it("accepts exact base64", () => {
    expect(() =>
      validateResourceFiles([{ path: "assets/a.txt", contentBase64: "aGVsbG8=" }]),
    ).not.toThrow();
  });
});

describe("parseSkillPackageZip", () => {
  it("loads SKILL.md and allowed resource directories", async () => {
    const zip = new JSZip();
    zip.file("safe-skill/SKILL.md", skillMd);
    zip.file("safe-skill/references/guide.md", "guide");
    zip.file("safe-skill/README.md", "ignored");
    const result = await parseSkillPackageZip(await zip.generateAsync({ type: "uint8array" }));
    expect(result.files.map((file) => file.path)).toEqual(["references/guide.md"]);
    expect(result.skipped).toEqual(["README.md"]);
  });
});
