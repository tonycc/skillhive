import { describe, expect, it } from "vitest";
import { decodeSkillFile, validateSkillFileResponse } from "./skill-files.js";
import type { SkillFile } from "./registry.js";

const guideContent = Buffer.from("# 使用说明\n");
const files: SkillFile[] = [
  {
    version: "1.2.3",
    path: "references/guide.md",
    contentBase64: guideContent.toString("base64"),
    size: guideContent.byteLength,
  },
  {
    version: "1.2.3",
    path: "assets/logo.png",
    contentBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
    size: 4,
  },
];

describe("skill resource access", () => {
  it("accepts only an exact, valid response path", () => {
    expect(validateSkillFileResponse(files[0]!, "references/guide.md", "1.2.3")).toBe(files[0]);
    expect(() => validateSkillFileResponse(files[0]!, "../references/guide.md", "1.2.3")).toThrow(
      /请求路径无效/,
    );
    expect(() => validateSkillFileResponse(files[0]!, "references/other.md", "1.2.3")).toThrow(
      /不匹配/,
    );
    expect(() =>
      validateSkillFileResponse({ ...files[0]!, size: -1 }, "references/guide.md", "1.2.3"),
    ).toThrow(/大小无效/);
    expect(() =>
      validateSkillFileResponse(files[0]!, "references/guide.md", "1.2.4"),
    ).toThrow(/版本.*不匹配/);
  });

  it("returns UTF-8 text and preserves binary as base64", () => {
    const text = decodeSkillFile(files[0]!);
    expect(text.encoding).toBe("utf-8");
    expect(text.content).toBe("# 使用说明\n");

    const binary = decodeSkillFile(files[1]!);
    expect(binary.encoding).toBe("base64");
    expect(binary.content).toBe(files[1]!.contentBase64);
  });

  it("rejects malformed base64 from storage", () => {
    expect(() =>
      decodeSkillFile({
        version: "1.2.3",
        path: "assets/broken.png",
        contentBase64: "abc===",
        size: 1,
      }),
    ).toThrow(/base64/);
  });

  it("rejects content whose decoded size differs from metadata", () => {
    expect(() => decodeSkillFile({ ...files[0]!, size: files[0]!.size + 1 })).toThrow(
      /大小不一致/,
    );
  });
});
