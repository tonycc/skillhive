import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSkillMd, validateResourcePath } from "@skillhive/skill-schema";
import {
  loadRequirementExplorationBaseline,
  validateRequirementExplorationApplicationSkill,
} from "./built-in-applications.js";
import { explorationContentSchema, validateSubmission } from "./exploration-data.js";

const skillDirectory = resolve("examples/seed-skills/requirement-exploration");
const legacyProtocol = JSON.parse(await readFile(
  resolve("apps/registry/src/fixtures/grilling-protocol-1.0.json"),
  "utf8",
));

describe("managed requirement-exploration business Skill", () => {
  it("is publishable, versioned, and all-employee visible by default", async () => {
    const parsed = parseSkillMd(await readFile(resolve(skillDirectory, "SKILL.md"), "utf8"));
    expect(parsed.frontmatter).toMatchObject({
      name: "requirement-exploration",
      version: "1.2.0",
      category: "产品",
    });
    expect(parsed.frontmatter.departments).toBeUndefined();
    expect(parsed.frontmatter.allowed_tools).toEqual([
      "get_exploration",
      "get_skill_file",
      "save_exploration",
      "submit_exploration",
    ]);
  });

  it("ships only valid, discoverable reference resources", async () => {
    const files = await readdir(resolve(skillDirectory, "references"));
    expect(files.sort()).toEqual([
      "THIRD_PARTY_NOTICES.md",
      "discussion-playbook.md",
      "exploration-content.schema.json",
      "grilling-protocol.json",
    ]);
    for (const file of files) expect(validateResourcePath(`references/${file}`)).toBeNull();
    const body = parseSkillMd(await readFile(resolve(skillDirectory, "SKILL.md"), "utf8")).body;
    for (const file of files) expect(body).toContain(`references/${file}`);
  });

  it("keeps the published text-question protocol compatible regardless of Skill version", async () => {
    const baseline = await loadRequirementExplorationBaseline();
    const parsed = parseSkillMd(baseline.content);
    const files = baseline.files.map((file) => file.path === "references/grilling-protocol.json"
      ? { ...file, contentBase64: Buffer.from(JSON.stringify(legacyProtocol)).toString("base64") }
      : file);
    expect(() => validateRequirementExplorationApplicationSkill(parsed, files)).not.toThrow();
  });

  it("enforces the declared protocol version without dropping core interview requirements", async () => {
    const baseline = await loadRequirementExplorationBaseline();
    const parsed = parseSkillMd(baseline.content);
    const validateProtocol = (protocol: unknown) => validateRequirementExplorationApplicationSkill(
      parsed,
      baseline.files.map((file) => file.path === "references/grilling-protocol.json"
        ? { ...file, contentBase64: Buffer.from(JSON.stringify(protocol)).toString("base64") }
        : file),
    );
    expect(() => validateProtocol({ ...legacyProtocol, version: undefined })).not.toThrow();
    expect(() => validateProtocol({ ...legacyProtocol, questionStrategy: "one-at-a-time" }))
      .toThrow(/访谈协议不完整/);
    expect(() => validateProtocol({ ...legacyProtocol, version: "1.1" })).toThrow(/访谈协议不完整/);
    expect(() => validateProtocol({ ...legacyProtocol, version: "2.0" })).toThrow(/协议版本不受支持/);
    expect(() => validateProtocol(null)).toThrow(/访谈协议不完整/);
  });

  it("keeps the machine-readable rule fields aligned with the server schema", async () => {
    const schema = JSON.parse(await readFile(
      resolve(skillDirectory, "references/exploration-content.schema.json"),
      "utf8",
    )) as { properties: Record<string, unknown>; required: string[]; "x-skillhive-submit-required": string[] };
    expect(Object.keys(schema.properties).sort()).toEqual([...explorationContentSchema.keyof().options].sort());
    expect(schema.required).toEqual(["title"]);
    const emptyDraft = explorationContentSchema.parse({ title: "临时标题" });
    const missingLabels = validateSubmission(emptyDraft);
    expect(schema["x-skillhive-submit-required"].length).toBe(missingLabels.length + 1);
    expect(schema["x-skillhive-submit-required"]).toContain("title");
  });

  it("accepts only complete application Skill packages that satisfy the fixed contract", async () => {
    const baseline = await loadRequirementExplorationBaseline();
    const parsed = parseSkillMd(baseline.content);
    expect(() => validateRequirementExplorationApplicationSkill(parsed, baseline.files)).not.toThrow();

    expect(() => validateRequirementExplorationApplicationSkill(
      parsed,
      baseline.files.filter((file) => file.path !== "references/discussion-playbook.md"),
    )).toThrow(/必须包含并引用资源/);

    expect(() => validateRequirementExplorationApplicationSkill(
      parsed,
      baseline.files.filter((file) => file.path !== "references/grilling-protocol.json"),
    )).toThrow(/必须包含并引用资源/);

    expect(() => validateRequirementExplorationApplicationSkill(
      { ...parsed, body: parsed.body.replace("references/grilling-protocol.json", "") },
      baseline.files,
    )).toThrow(/必须包含并引用资源/);

    expect(() => validateRequirementExplorationApplicationSkill({
      ...parsed,
      frontmatter: { ...parsed.frontmatter, allowed_tools: ["get_exploration"] },
    }, baseline.files)).toThrow(/allowed_tools 必须且只能包含/);

    const invalidProtocol = baseline.files.map((file) => file.path === "references/grilling-protocol.json"
      ? { ...file, contentBase64: Buffer.from(JSON.stringify({ protocol: "grill-me" })).toString("base64") }
      : file);
    expect(() => validateRequirementExplorationApplicationSkill(parsed, invalidProtocol))
      .toThrow(/Grill Me 访谈协议不完整/);

    const textOnlyProtocol = baseline.files.map((file) => file.path === "references/grilling-protocol.json"
      ? {
          ...file,
          contentBase64: Buffer.from(JSON.stringify({
            ...JSON.parse(Buffer.from(file.contentBase64, "base64").toString("utf8")),
            questionFormat: {
              numbered: true,
              titled: true,
              recommendationRequired: true,
            },
          })).toString("base64"),
        }
      : file);
    expect(() => validateRequirementExplorationApplicationSkill(parsed, textOnlyProtocol))
      .toThrow(/Grill Me 访谈协议不完整/);
  });
});
